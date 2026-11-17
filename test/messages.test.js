import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reader } from '../src/protocol/codec.js';
import { CMD, Requests, SET_SUBS, TUNER_NOTES, firmwareText, parseEvent } from '../src/protocol/messages.js';
import { parseChunk } from '../src/protocol/framing.js';
import { hex, parseWrite, toHex, traffic } from './helpers.js';

// A read with no arguments, for the reads the app sends that the library has no builder for.
const read = (sub) => ({ cmd: CMD.GET, sub, payload: new Uint8Array(0) });

// Decodes the arguments of an app write and rebuilds it with the matching request builder.
const REBUILD = {
  '02 01': (r) => (r.int() === 1 ? (r.int(), Requests.currentPresetBlob()) : Requests.presetBlob(r.int())),
  '02 a7': (r) => Requests.ampBlob(r.u8(), r.u8()),
  '02 11': () => Requests.name(),
  '02 23': () => read(0x23),
  '02 2f': () => Requests.firmware(),
  '02 2b': (r) => (assert.equal(r.int(), 0), Requests.presetChecksums()),
  '02 ab': (r) => (assert.equal(r.int(), 0), Requests.ampChecksums()),
  '02 1a': (r) => (assert.equal(r.array(), 1), assert.equal(r.int(), 0), Requests.slotState()),
  '02 65': () => Requests.tuner(),
  '02 74': (r) => (assert.equal(r.array(), 1), assert.equal(r.int(), 0), Requests.impedance()),
  '02 a2': () => Requests.lineOutMute(),
  '02 b2': () => Requests.expMode(),
  '02 96': () => read(0x96),
  '01 04': (r) => {
    const req = Requests.setParam(r.pstr(), r.int(), r.float());
    assert.equal(r.int(), 0);
    return req;
  },
  '01 15': (r) => {
    const req = Requests.setActive(r.pstr(), r.bool());
    assert.equal(r.int(), 0);
    return req;
  },
  '01 06': (r) => {
    const req = Requests.replaceModel(r.pstr(), r.pstr());
    assert.equal(r.int(), 0);
    return req;
  },
  '01 b3': (r) => Requests.selectCategory(r.int(), r.bool()),
  '01 38': (r) => (assert.equal(r.int(), 0), Requests.selectPreset(r.int())),
  '01 b1': (r) => Requests.switchAmp(r.int(), r.int()),
  '01 65': (r) => Requests.setTuner(r.bool()),
  '01 74': (r) => (assert.equal(r.array(), 1), Requests.setImpedance(r.int(), r.int())),
  '01 a2': (r) => Requests.setLineOutMute(r.bool()),
  '01 b2': (r) => Requests.setExpMode(r.int()),
};

const f32 = (h) => new DataView(hex(h).buffer).getFloat32(0);
const key = (cmd, sub) => `${cmd.toString(16).padStart(2, '0')} ${sub.toString(16).padStart(2, '0')}`;

test('every distinct request the app sent is rebuilt byte for byte', () => {
  const seen = new Set();
  for (const w of traffic.appWrites) {
    const c = parseWrite(w);
    const k = key(c.cmd, c.sub);
    const rebuild = REBUILD[k];
    assert.ok(rebuild, `no rebuild rule for ${k}`);
    const r = new Reader(c.payload);
    const req = rebuild(r);
    const rest = c.payload.subarray(r.i);
    // 02 01 and 02 A7 are padded to 32 bytes with zeros; nothing else may be left over.
    if (k === '02 01' || k === '02 a7') assert.equal(c.payload.length, 32);
    assert.ok(rest.every((b) => b === 0) && (rest.length === 0 || c.payload.length === 32), `${k}: unparsed bytes`);
    assert.equal(key(req.cmd, req.sub), k);
    assert.equal(toHex(req.payload), toHex(c.payload), k);
    seen.add(k);
  }
  assert.equal(seen.size, Object.keys(REBUILD).length);
});

// Requests checked by sending them to the amp directly, with the payloads it answered.
const DIRECT = [
  [Requests.param('MonoReverb', 0), '0aaa4d6f6e6f5265766572620000'],
  [Requests.active('MonoReverb'), '0aaa4d6f6e6f52657665726200'],
  [Requests.currentSlot(), ''],
  [Requests.setBpm(100), 'ca42c80000'],
  [Requests.swapBlocks(7, 8), '920708'],
  [Requests.swapBlocks(5, 7), '920507'],
  [Requests.inputState(), '9100'],
];

test('requests verified by sending them directly have the verified payloads', () => {
  for (const [req, payload] of DIRECT) assert.equal(toHex(req.payload), payload, key(req.cmd, req.sub));
});

test('tempos the amp would ignore are refused', () => {
  assert.throws(() => Requests.setBpm(39.9), RangeError);
  assert.throws(() => Requests.setBpm(301), RangeError);
  assert.equal(toHex(Requests.setBpm(40).payload), 'ca42200000');
});

// Replies in the amp's format, and what they decode to. The checksum values are made up.
const REPLIES = [
  [Requests.name(), '15b552656163746f7220353020425420436f6e74726f6c', 'Reactor 50 BT Control'],
  [Requests.firmware(), 'ce0002056c', 132460],
  [Requests.currentSlot(), '0007', { type: 0, slot: 7 }],
  [Requests.slotState(), '940007c30007c30007c30007c3', { chain: 0, slot: 7, edited: true }],
  [Requests.presetChecksums(), '98ceffffffffce12345678ce9abcdef0ce0fedcba9ce87654321ce13579bdfce2468ace0ce0badf00d',
    [0xffffffff, 0x12345678, 0x9abcdef0, 0x0fedcba9, 0x87654321, 0x13579bdf, 0x2468ace0, 0x0badf00d]],
  [Requests.ampChecksums(), `9e${['11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777', '33333333',
    '44444444', '55555555', '22222222', '22222222', '44444444', '66666666'].map((x) => `ce${x}`).join('')}`,
    [0x11111111, 0x22222222, 0x33333333, 0x44444444, 0x55555555, 0x66666666, 0x77777777, 0x33333333, 0x44444444,
      0x55555555, 0x22222222, 0x22222222, 0x44444444, 0x66666666]],
  [Requests.param('MonoReverb', 0), 'ca3df5c000', 0.1199951171875],
  [Requests.active('MonoReverb'), 'c2', false],
  [Requests.tuner(), 'c3', true],
  [Requests.impedance(), '910000', [{ input: 0, mode: 0 }]],
  [Requests.inputState(), '940000c30000c20000c20000c2', { input: 0, plugged: true }],
  // Leftover memory after the first entry, as captured in 6 of 300 reads.
  [Requests.inputState(), '940000c3ceffffffff01d2ce24015310cc82d6ce90022c4fce900228f2c2', { input: 0, plugged: true }],
  [Requests.setLineOutMute(true), '00', 0],
  [Requests.lineOutMute(), 'c2', false],
  [Requests.expMode(), '00', 0],
];

test('replies decode completely to the expected values', () => {
  for (const [req, payload, expected] of REPLIES) {
    const r = new Reader(hex(payload));
    assert.deepEqual(req.parse(r), expected, key(req.cmd, req.sub));
    assert.equal(r.remaining, 0, `${key(req.cmd, req.sub)}: unparsed bytes`);
  }
  assert.equal(firmwareText(132460), '0.2.5.108');
});

test('every request expects the documented reply', () => {
  for (const make of Object.values(Requests)) {
    const req = make.length === 0 ? make() : null;
    if (!req || req.sliced) continue;
    if (req.cmd === CMD.GET) assert.deepEqual(req.reply, { cmd: CMD.REPLY, sub: req.sub });
    else assert.deepEqual(req.reply, { cmd: CMD.ACK, sub: req.sub });
  }
  assert.equal(Requests.setParam('Delay', 0, 0.5).reply, null);
});

test('the client allowlist is exactly the set commands Requests builds', () => {
  const built = [
    Requests.uploadPreset(Uint8Array.of(0, 0)), Requests.selectPreset(0), Requests.uploadAmp(Uint8Array.of(0x10, 0)),
    Requests.switchAmp(0, 7), Requests.setParam('Delay', 0, 0.5), Requests.setActive('Delay', true),
    Requests.replaceModel('Delay', 'DelayDM2'), Requests.swapBlocks(1, 2), Requests.selectCategory(1), Requests.setBpm(120),
    Requests.setTuner(true), Requests.setImpedance(0, 1), Requests.setLineOutMute(true), Requests.setExpMode(0),
  ];
  assert.deepEqual(new Set(built.map((r) => r.cmd)), new Set([CMD.SET]));
  assert.deepEqual(new Set(built.map((r) => r.sub)), SET_SUBS);
  const setBuilders = Object.values(Requests).filter((make) => make.length === 0).map((make) => make()).filter((r) => r.cmd === CMD.SET);
  assert.deepEqual(setBuilders, []);
});

test('captured amp events decode completely', () => {
  const types = new Set();
  for (const n of traffic.events) {
    const m = parseChunk(hex(n));
    assert.ok(m.seq >= 0x40, 'events use the amp sequence numbers');
    const e = parseEvent(m);
    assert.ok(!['unknown', 'malformed'].includes(e.type), `${n}: ${e.type}`);
    assert.equal(e.trailing, undefined, `${n}: trailing bytes`);
    types.add(e.type);
  }
  assert.deepEqual([...types].sort(), ['ampSelected', 'categorySelected', 'effectActive', 'inputState', 'paramChanged', 'presetSaved', 'presetSelected', 'presetState', 'tap', 'tuner', 'tunerActive']);
});

test('events decode to the documented fields', () => {
  const ev = (sub, payload) => parseEvent({ cmd: 3, sub, seq: 0x40, payload: hex(payload) });
  assert.deepEqual(ev(0x37, '0aaa416d702e507265616d7000ca3f18484800'), { type: 'paramChanged', dsp: 'Amp.Preamp', index: 0, value: f32('3f184848'), chain: 0, seq: 0x40 });
  assert.deepEqual(ev(0xb1, '050c'), { type: 'ampSelected', bank: 5, variant: 12, seq: 0x40 });
  assert.deepEqual(ev(0x15, '0aaa44656c61795245323031c300'), { type: 'effectActive', dsp: 'DelayRE201', active: true, chain: 0, seq: 0x40 });
  assert.deepEqual(ev(0x1a, '910007c3'), { type: 'presetState', states: [{ chain: 0, slot: 7, edited: true }], seq: 0x40 });
  assert.deepEqual(ev(0x38, '0004'), { type: 'presetSelected', presetType: 0, slot: 4, seq: 0x40 });
  assert.deepEqual(ev(0x27, '0004'), { type: 'presetSaved', presetType: 0, slot: 4, seq: 0x40 });
  assert.deepEqual(ev(0x63, 'ca42800000'), { type: 'tap', bpm: 64, seq: 0x40 });
  assert.deepEqual(ev(0x64, '00cabf800000'), { type: 'tuner', note: 0, deviation: -1, seq: 0x40 });
  assert.deepEqual(ev(0x73, '910000c3'), { type: 'inputState', inputs: [{ input: 0, plugged: true }], seq: 0x40 });
  assert.deepEqual(ev(0xb3, '02c3'), { type: 'categorySelected', category: 2, selected: true, seq: 0x40 });
  assert.equal(ev(0x64, '09ca3ee26580').note, 9);
  assert.equal(TUNER_NOTES[9], 'A');
  assert.equal(ev(0x37, '').type, 'malformed');
  assert.equal(parseEvent({ cmd: 3, sub: 0x5a, seq: 0x40, payload: hex('00') }).type, 'unknown');
});
