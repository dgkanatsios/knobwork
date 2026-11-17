import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkSplitter, Reassembler, chunk, frame, pack7, parseChunk, splitParts, unpack7 } from '../src/protocol/framing.js';
import { UPLOAD_PART } from '../src/protocol/messages.js';
import { hex, parseWrite, presetFixture, toHex, traffic } from './helpers.js';

const REPLY_PART = 350; // data bytes per part of the amp's multi-part replies

// The part headers splitParts makes for a message as long as the parts these captured headers describe.
function splitLike(headers, size) {
  const length = headers.reduce((n, h) => n + parseInt(h.slice(4), 16), 0);
  return splitParts(new Uint8Array(length), size).map((p) => toHex(p.subarray(0, 4)));
}

test('7-bit packing matches the documented example and round-trips', () => {
  assert.equal(toHex(pack7(hex('ca42f00000'))), '054a42700000');
  for (let n = 0; n < 40; n++) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff);
    assert.deepEqual(unpack7(pack7(data)), data);
  }
});

test('every write the official app made is reproduced byte for byte', () => {
  for (const w of traffic.appWrites) {
    const c = parseWrite(w);
    assert.equal(c.marker, 0x01);
    assert.ok(c.checksumOk, `checksum of ${w.slice(0, 60)}`);
    assert.equal(toHex(frame(c.seq, c.cmd, c.sub, c.payload)), w);
  }
});

test('amp notifications are single checksummed chunks without a block header', () => {
  const notes = [...traffic.uploadParts.notifications, ...traffic.events];
  for (const n of notes) {
    const b = hex(n);
    assert.equal(b[0], 0xf0);
    const chunks = new ChunkSplitter(() => assert.fail('stray byte')).push(b);
    assert.equal(chunks.length, 1);
    assert.ok(parseChunk(chunks[0]).checksumOk);
  }
});

test('the splitter handles chunks split across notifications and block headers', () => {
  const a = frame(5, 2, 0x2f, new Uint8Array(0));
  const b = chunk(6, 3, 0x2f, hex('ce0002056c'));
  const stream = new Uint8Array([...a, ...b]);
  const s = new ChunkSplitter(() => assert.fail('stray byte'));
  const got = [...s.push(stream.subarray(0, 20)), ...s.push(stream.subarray(20, 30)), ...s.push(stream.subarray(30))];
  assert.equal(got.length, 2);
  assert.equal(toHex(got[0]), toHex(a.subarray(16)));
  assert.equal(toHex(got[1]), toHex(b));
});

test('a read reassembles from parts split the way the amp splits its replies', () => {
  for (const headers of traffic.replyParts.headers) assert.deepEqual(splitLike(headers, REPLY_PART), headers);
  const blob = presetFixture(7);
  const r = new Reassembler();
  const done = splitParts(blob, REPLY_PART).map((p) => r.push(parseChunk(chunk(0x1e, 3, 0x01, p)))).filter(Boolean);
  assert.equal(done.length, 1);
  assert.equal(done[0].parts, Math.ceil(blob.length / REPLY_PART));
  assert.equal(toHex(done[0].payload), toHex(blob));
});

test('part 0 starts a new message, so a partial message is never mixed into a later one', () => {
  const r = new Reassembler();
  const parts = (fill) => splitParts(new Uint8Array(9).fill(fill), 3).map((p) => parseChunk(chunk(9, 3, 1, p)));
  const [old0, , old2] = parts(0xaa);
  assert.equal(r.push(old0), null);
  assert.equal(r.push(old2), null);
  const done = parts(0xbb).map((p) => r.push(p)).filter(Boolean);
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].payload, new Uint8Array(9).fill(0xbb));
});

test('uploads are split into parts the way the app splits them', () => {
  for (const headers of traffic.uploadParts.headers) assert.deepEqual(splitLike(headers, UPLOAD_PART), headers);
});

test('chunk headers and part counts must fit in a byte', () => {
  assert.throws(() => chunk(1, 0x01, 0x165), RangeError);
  assert.throws(() => chunk(1, 0x01, '4'), RangeError);
  assert.throws(() => chunk(0x80, 0x03, 0x01), RangeError);
  assert.equal(splitParts(new Uint8Array(255 * 10), 10).length, 255);
  assert.throws(() => splitParts(new Uint8Array(255 * 10 + 1), 10), RangeError);
});
