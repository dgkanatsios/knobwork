// Framing (docs/protocol.md, section 2): 7-bit packing, chunks, block headers and multi-part payloads.

export function pack7(data) {
  const out = new Uint8Array(data.length + Math.ceil(data.length / 7));
  let o = 0;
  for (let i = 0; i < data.length; i += 7) {
    const end = Math.min(i + 7, data.length);
    let flags = 0;
    for (let j = i; j < end; j++) if (data[j] & 0x80) flags |= 1 << (j - i);
    out[o++] = flags;
    for (let j = i; j < end; j++) out[o++] = data[j] & 0x7f;
  }
  return out;
}

export function unpack7(data) {
  const out = new Uint8Array(data.length - Math.ceil(data.length / 8));
  let o = 0;
  for (let i = 0; i < data.length; i += 8) {
    const flags = data[i];
    const end = Math.min(i + 8, data.length);
    for (let j = i + 1; j < end; j++) out[o++] = data[j] | ((flags >> (j - i - 1)) & 1 ? 0x80 : 0);
  }
  return out;
}

export function chunk(seq, cmd, sub, payload = new Uint8Array(0)) {
  const isByte = (v, max = 0xff) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!isByte(seq, 0x7f) || !isByte(cmd) || !isByte(sub)) throw new RangeError(`bad chunk header ${seq} ${cmd} ${sub}`);
  const packed = pack7(payload);
  let chk = 0;
  for (const b of packed) chk ^= b;
  const out = new Uint8Array(packed.length + 7);
  out.set([0xf0, 0x01, seq, chk & 0x7f, cmd, sub]);
  out.set(packed, 6);
  out[out.length - 1] = 0xf7;
  return out;
}

export function blockHeader(writeLength) {
  return Uint8Array.of(0x01, 0xfe, 0x00, 0x00, 0x53, 0xfe, writeLength & 0xff, writeLength >> 8, 0, 0, 0, 0, 0, 0, 0, 0);
}

// One client write: 16-byte block header + one chunk.
export function frame(seq, cmd, sub, payload) {
  const c = chunk(seq, cmd, sub, payload);
  const out = new Uint8Array(c.length + 16);
  out.set(blockHeader(out.length));
  out.set(c, 16);
  return out;
}

// Payload of each part of a multi-part message: <count> <index> <len hi> <len lo> <data>.
export function splitParts(payload, partSize) {
  if (!Number.isInteger(partSize) || partSize < 1) throw new RangeError(`bad part size ${partSize}`);
  const count = Math.max(1, Math.ceil(payload.length / partSize));
  if (count > 0xff) throw new RangeError(`${payload.length} bytes need more than 255 parts`);
  const parts = [];
  for (let k = 0; k < count; k++) {
    const data = payload.subarray(k * partSize, (k + 1) * partSize);
    const part = new Uint8Array(data.length + 4);
    part.set([count, k, data.length >> 8, data.length & 0xff]);
    part.set(data, 4);
    parts.push(part);
  }
  return parts;
}

export function parseChunk(raw) {
  if (raw.length < 7 || raw[0] !== 0xf0 || raw[raw.length - 1] !== 0xf7) throw new Error('not a chunk');
  const packed = raw.subarray(6, raw.length - 1);
  let chk = 0;
  for (const b of packed) chk ^= b;
  return {
    marker: raw[1],
    seq: raw[2],
    checksum: raw[3],
    checksumOk: (chk & 0x7f) === raw[3],
    cmd: raw[4],
    sub: raw[5],
    payload: unpack7(packed),
  };
}

// Splits a byte stream (notification values) into chunks. Keeps an incomplete tail for the next call and skips
// block headers; any other byte outside a chunk is reported through onStray.
export class ChunkSplitter {
  constructor(onStray = () => {}) {
    this.rest = new Uint8Array(0);
    this.onStray = onStray;
  }

  push(bytes) {
    let data = bytes;
    if (this.rest.length) {
      data = new Uint8Array(this.rest.length + bytes.length);
      data.set(this.rest);
      data.set(bytes, this.rest.length);
    }
    const chunks = [];
    let i = 0;
    while (i < data.length) {
      if (data[i] === 0x01 && (i + 1 === data.length || data[i + 1] === 0xfe)) {
        if (i + 16 > data.length) break;
        i += 16;
        continue;
      }
      if (data[i] !== 0xf0) {
        this.onStray(data[i]);
        i++;
        continue;
      }
      // cmd and sub (offsets 4 and 5) are not 7-bit packed and may themselves be 0xF7.
      const end = i + 6 < data.length ? data.indexOf(0xf7, i + 6) : -1;
      if (end < 0) break;
      chunks.push(data.slice(i, end + 1));
      i = end + 1;
    }
    this.rest = data.slice(i);
    return chunks;
  }
}

// Amp messages that always arrive in parts (presets and amp data).
const SLICED = new Set(['3:1', '3:167']);

export function isSliced(cmd, sub) {
  return SLICED.has(`${cmd}:${sub}`);
}

// Joins the parts of sliced amp messages; passes every other chunk through as a message.
export class Reassembler {
  constructor() {
    this.open = new Map();
  }

  push(c) {
    if (!isSliced(c.cmd, c.sub)) return { ...c };
    const p = c.payload;
    if (p.length < 4) throw new Error(`short part for ${c.cmd}/${c.sub}`);
    const [count, index] = p;
    const len = (p[2] << 8) | p[3];
    if (len !== p.length - 4 || index >= count) throw new Error(`bad part header ${count}/${index}/${len}`);
    const key = `${c.cmd}:${c.sub}:${c.seq}`;
    let entry = this.open.get(key);
    // The amp sends parts in order, so part 0 always starts a new message. This also drops a partial message whose
    // remaining parts were lost, before a later message with the same sequence number could be mixed into it.
    if (!entry || entry.count !== count || index === 0) {
      entry = { count, parts: new Array(count) };
      this.open.set(key, entry);
    }
    entry.parts[index] = p.subarray(4);
    if (entry.parts.filter(Boolean).length < count) return null;
    this.open.delete(key);
    const total = entry.parts.reduce((n, x) => n + x.length, 0);
    const payload = new Uint8Array(total);
    let o = 0;
    for (const x of entry.parts) {
      payload.set(x, o);
      o += x.length;
    }
    return { ...c, payload, parts: count };
  }
}
