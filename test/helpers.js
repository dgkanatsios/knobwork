import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChunk } from '../src/protocol/framing.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const hex = (s) => Uint8Array.from(Buffer.from(s.trim(), 'hex'));
export const toHex = (b) => Buffer.from(b).toString('hex');

// Traffic captured between the official app and the amp, without any preset or amp data.
export const traffic = JSON.parse(readFileSync(join(DIR, 'traffic.json'), 'utf8'));

// Made-up presets and amp data in the amp's formats (fixtures/make-fixtures.js).
export function presetFixture(slot) {
  return hex(readFileSync(join(DIR, 'presets', `slot-${slot}.hex`), 'utf8'));
}

// Slot 7's amp bank: the 15 variants of the amp its preset uses.
export function bank17() {
  return readdirSync(join(DIR, 'amp-bank-17'))
    .sort()
    .map((f) => hex(readFileSync(join(DIR, 'amp-bank-17', f), 'utf8')));
}

// The difference message that writes variants 1-14 of bank17().
export function ampBatch17() {
  return hex(readFileSync(join(DIR, 'amp-batch-17.hex'), 'utf8'));
}

// A client write is a 16-byte block header followed by one chunk.
export function chunkOfWrite(write) {
  const b = hex(write);
  return b[0] === 0x01 && b[1] === 0xfe ? b.subarray(16) : b;
}

export function parseWrite(write) {
  return parseChunk(chunkOfWrite(write));
}

// Joins the parts (<count> <index> <len hi> <len lo> <data>) of consecutive writes of one multi-part message.
export function joinParts(chunks) {
  const out = [];
  for (const c of chunks) out.push(...c.payload.subarray(4));
  return Uint8Array.from(out);
}
