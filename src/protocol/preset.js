// Preset and amp data (docs/protocol.md, sections 6-8). Parameters are kept as raw half-float bit patterns so that
// parse -> serialize reproduces the amp's bytes exactly.

import { Reader, Writer } from './codec.js';
import { crc32record, crc32mpeg2 } from './crc.js';
import { halfToFloat } from './half.js';

export const TEMP_SLOT = 0x7f;
export const LIVE_BANK = 0x7d;
export const TEMP_BANK = 0x7f;
export const VARIANTS = 15;

function readMeta(r) {
  const id = r.bin();
  const name = r.str();
  const version = r.str();
  const description = r.str();
  const icon = r.str();
  const gainStage = r.int();
  const tags = [];
  for (let n = r.array(); n > 0; n--) tags.push(r.str());
  return { id, name, version, description, icon, gainStage, tags };
}

function writeMeta(w, m) {
  w.bin(m.id).str(m.name).str(m.version).str(m.description).str(m.icon).int(m.gainStage).array(m.tags.length);
  for (const t of m.tags) w.str(t);
}

function readBlocks(r) {
  const blocks = [];
  for (let n = r.array(); n > 0; n--) {
    const code = r.bin();
    if (code.length !== 2) throw new Error(`block code of ${code.length} bytes`);
    const active = r.bool();
    const params = [];
    for (let k = r.array(); k > 0; k--) params.push(r.int());
    blocks.push({ code: (code[0] << 8) | code[1], active, params });
  }
  return blocks;
}

function writeBlocks(w, blocks) {
  w.array(blocks.length);
  for (const b of blocks) {
    w.bin(Uint8Array.of(b.code >> 8, b.code & 0xff)).bool(b.active).array(b.params.length);
    for (const p of b.params) w.uint(p);
  }
}

function readTrailer(r, bytes) {
  if (r.remaining !== 4) throw new Error(`expected a 4-byte checksum, ${r.remaining} bytes left`);
  const checksum = r.u32();
  return { checksum, checksumOk: crc32mpeg2(bytes.subarray(2, bytes.length - 4)) === checksum };
}

function finishWithChecksum(w) {
  const body = w.finish();
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  new DataView(out.buffer).setUint32(body.length, crc32mpeg2(body.subarray(2)));
  return out;
}

export function parsePreset(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  const slot = r.u8();
  const meta = readMeta(r);
  const bpm = r.float();
  const amp = { ...readMeta(r), blocks: readBlocks(r) };
  const blocks = readBlocks(r);
  return { type, slot, ...meta, bpm, amp, blocks, ...readTrailer(r, bytes) };
}

// type/slot: 00 n = slot n, 00 7F = temporary slot.
export function serializePreset(p, type = p.type, slot = p.slot) {
  const w = new Writer();
  w.byte(type).byte(slot);
  writeMeta(w, p);
  w.float(p.bpm);
  writeMeta(w, p.amp);
  writeBlocks(w, p.amp.blocks);
  writeBlocks(w, p.blocks);
  return finishWithChecksum(w);
}

export function parseAmp(bytes) {
  const r = new Reader(bytes);
  const bank = r.u8();
  const variant = r.u8();
  const meta = readMeta(r);
  const blocks = readBlocks(r);
  return { bank, variant, ...meta, blocks, ...readTrailer(r, bytes) };
}

export function serializeAmp(a, bank = a.bank, variant = a.variant) {
  const w = new Writer();
  w.byte(bank).byte(variant);
  writeMeta(w, a);
  writeBlocks(w, a.blocks);
  return finishWithChecksum(w);
}

// Same bytes with a different 2-byte header (the checksum does not cover the header).
export function withHeader(blob, a, b) {
  const out = blob.slice();
  out[0] = a;
  out[1] = b;
  return out;
}

function sameAfterHeader(a, b) {
  return a.length === b.length && a.every((x, i) => i < 2 || x === b[i]);
}

export function paramValue(block, index) {
  return halfToFloat(block.params[index]);
}

// Message that writes variants 1-14 of a bank as differences from variant 0 (docs/protocol.md, section 8).
// variants: 15 amp blobs (variant 0..14) of the same amp. A record carries only parameter values, so every variant must
// be variant 0 with some parameters changed: the amp would apply any other record, find its checksum wrong and skip it.
export function buildAmpBatch(bank, variants) {
  if (variants.length !== VARIANTS) throw new Error(`need ${VARIANTS} variants, got ${variants.length}`);
  const base = parseAmp(variants[0]);
  const w = new Writer();
  w.byte(0x03).byte(bank).byte(variants.length - 1).byte(0x00);
  for (let v = 1; v < variants.length; v++) {
    const amp = parseAmp(variants[v]);
    if (!amp.checksumOk) throw new Error(`variant ${v} fails its checksum`);
    if (amp.blocks.length !== base.blocks.length) throw new Error(`variant ${v}: block count differs from variant 0`);
    const groups = [];
    amp.blocks.forEach((b, bi) => {
      const ref = base.blocks[bi];
      if (b.code !== ref.code || b.active !== ref.active || b.params.length !== ref.params.length) {
        throw new Error(`variant ${v}: block ${bi} differs from variant 0 in more than its parameters`);
      }
      const changed = [];
      b.params.forEach((p, pi) => {
        if (p !== ref.params[pi]) changed.push([pi, p]);
      });
      if (changed.length) groups.push([bi, changed]);
    });
    const rebuilt = applyAmpRecord(variants[0], { variant: v, groups: groups.map(([block, changes]) => ({ block, changes })) });
    if (!sameAfterHeader(rebuilt, variants[v])) throw new Error(`variant ${v} differs from variant 0 in more than its parameters`);
    const crc = crc32record(variants[v].subarray(2, variants[v].length - 4));
    const d = new Writer();
    d.byte(0x02).byte(0x00).byte(groups.length);
    d.byte(crc).byte(crc >>> 8).byte(crc >>> 16).byte(crc >>> 24);
    for (const [bi, changed] of groups) {
      if (changed.length > 255) throw new Error('too many changed parameters in one block');
      d.byte(bi).byte(changed.length);
      for (const [pi, bits] of changed) d.byte(pi).byte(bits).byte(bits >> 8);
    }
    const diff = d.finish();
    w.byte(v).byte(diff.length).byte(diff.length >> 8).bytes(diff).u32(crc);
  }
  const body = w.finish();
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  new DataView(out.buffer).setUint32(body.length, crc32mpeg2(body));
  return out;
}

export function parseAmpBatch(bytes) {
  const r = new Reader(bytes);
  const [kind, bank, count, flag] = [r.u8(), r.u8(), r.u8(), r.u8()];
  if (kind !== 0x03) throw new Error(`not a difference message (0x${kind.toString(16)})`);
  const records = [];
  for (let k = 0; k < count; k++) {
    const variant = r.u8();
    const len = r.u8() | (r.u8() << 8);
    const d = new Reader(r.take(len));
    const mode = d.u8();
    const reference = d.u8();
    const groupCount = d.u8();
    const crc = (d.u8() | (d.u8() << 8) | (d.u8() << 16) | (d.u8() << 24)) >>> 0;
    const groups = [];
    for (let g = 0; g < groupCount; g++) {
      const block = d.u8();
      const changes = [];
      for (let n = d.u8(); n > 0; n--) changes.push([d.u8(), d.u8() | (d.u8() << 8)]);
      groups.push({ block, changes });
    }
    if (d.remaining) throw new Error(`record ${variant}: ${d.remaining} unparsed bytes`);
    const crcAfter = r.u32();
    records.push({ variant, mode, reference, crc, crcAfter, groups });
  }
  if (r.remaining !== 4) throw new Error(`expected a 4-byte checksum, ${r.remaining} bytes left`);
  const checksum = r.u32();
  return { bank, count, flag, records, checksum, checksumOk: crc32mpeg2(bytes.subarray(0, bytes.length - 4)) === checksum };
}

// Rebuilds one variant blob from the base blob and a parsed difference record.
export function applyAmpRecord(baseBlob, record, bank = baseBlob[0]) {
  const amp = parseAmp(baseBlob);
  const blocks = amp.blocks.map((b) => ({ ...b, params: b.params.slice() }));
  for (const g of record.groups) for (const [pi, bits] of g.changes) blocks[g.block].params[pi] = bits;
  return serializeAmp({ ...amp, blocks }, bank, record.variant);
}
