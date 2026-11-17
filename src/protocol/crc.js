// Checksums (docs/protocol.md, sections 8 and 9).

const MPEG2 = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  MPEG2[n] = c >>> 0;
}

// CRC-32/MPEG-2: the trailer of every preset and amp blob, and of the amp difference message.
export function crc32mpeg2(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ MPEG2[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

const RECORD = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  RECORD[n] = c >>> 0;
}
// One entry differs from the standard table by one bit. Each record of the amp difference message uses this CRC
// (docs/protocol.md, section 8).
RECORD[0xf5] = 0xcdd706b3;

export function crc32record(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (RECORD[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return ~crc >>> 0;
}
