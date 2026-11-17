// Commands and events (docs/protocol.md, sections 4 and 5). A request is
// { cmd, sub, payload, reply: { cmd, sub } | null, parse(reader, message), sliced, partSize }.

import { Reader, Writer } from './codec.js';

export const CMD = { SET: 0x01, GET: 0x02, REPLY: 0x03, ACK: 0x04 };
export const CHAIN = 0;
// Part size the app uses for 01 01 and 01 A7 uploads (the amp's own parts are at most 350 bytes).
export const UPLOAD_PART = 396;

function bytesOf(fill) {
  const w = new Writer();
  fill(w);
  return w.finish();
}

function pad32(bytes) {
  const out = new Uint8Array(Math.max(32, bytes.length));
  out.set(bytes);
  return out;
}

const get = (sub, payload, parse, extra = {}) => ({ cmd: CMD.GET, sub, payload, reply: { cmd: CMD.REPLY, sub }, parse, ...extra });
const set = (sub, payload, parse = null) => ({ cmd: CMD.SET, sub, payload, reply: { cmd: CMD.ACK, sub }, parse });
const empty = new Uint8Array(0);

function structArray(r, readOne) {
  const out = [];
  for (let n = r.array(); n > 0; n--) out.push(readOne(r));
  return out;
}

const intArray = (r) => structArray(r, (x) => x.int());

// The first struct of an array; the rest of the payload is skipped without being decoded.
function firstEntry(r, readOne) {
  const value = r.array() > 0 ? readOne(r) : null;
  r.i = r.b.length;
  return value;
}

export function firmwareText(v) {
  return [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

export const Requests = {
  // Device
  name: () => get(0x11, empty, (r) => r.pstr()),
  firmware: () => get(0x2f, empty, (r) => r.int()),

  // Presets
  presetBlob: (slot) => get(0x01, pad32(Uint8Array.of(0x00, slot)), null, { raw: true }),
  currentPresetBlob: () => get(0x01, pad32(Uint8Array.of(0x01, 0x00)), null, { raw: true }),
  uploadPreset: (blob) => ({ cmd: CMD.SET, sub: 0x01, payload: blob, sliced: true, partSize: UPLOAD_PART }),
  selectPreset: (slot) => set(0x38, bytesOf((w) => w.int(0).int(slot))),
  currentSlot: () => get(0x10, empty, (r) => ({ type: r.int(), slot: r.int() })),
  // REACTOR answers with 4 entries; only the first is meaningful.
  slotState: () => get(0x1a, bytesOf((w) => w.array(1).int(CHAIN)), (r) => firstEntry(r, readSlotState)),
  presetChecksums: () => get(0x2b, bytesOf((w) => w.int(0)), intArray),

  // Amp data
  ampBlob: (bank, variant) => get(0xa7, pad32(Uint8Array.of(bank, variant)), null, { raw: true }),
  uploadAmp: (bytes) => ({ cmd: CMD.SET, sub: 0xa7, payload: bytes, sliced: true, partSize: UPLOAD_PART }),
  ampChecksums: () => get(0xab, bytesOf((w) => w.int(0)), intArray),
  switchAmp: (bank, variant) => set(0xb1, bytesOf((w) => w.int(bank).int(variant))),

  // Effects
  // Values on the wire are 0..1 for every parameter (ReactorAmp parameter 0 is written as variant ÷ 14).
  setParam: (dsp, index, value) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`parameter value out of range (0-1): ${value}`);
    return { cmd: CMD.SET, sub: 0x04, payload: bytesOf((w) => w.pstr(dsp).int(index).float(value).int(CHAIN)), reply: null };
  },
  param: (dsp, index) => get(0x04, bytesOf((w) => w.pstr(dsp).int(index).int(CHAIN)), (r) => r.number()),
  setActive: (dsp, on) => set(0x15, bytesOf((w) => w.pstr(dsp).bool(on).int(CHAIN))),
  active: (dsp) => get(0x15, bytesOf((w) => w.pstr(dsp).int(CHAIN)), (r) => r.bool()),
  replaceModel: (from, to) => set(0x06, bytesOf((w) => w.pstr(from).pstr(to).int(CHAIN))),
  swapBlocks: (a, b) => set(0xa6, bytesOf((w) => w.array(2).int(a).int(b))),
  selectCategory: (category, selected = true) => set(0xb3, bytesOf((w) => w.int(category).bool(selected))),

  // Tempo and tuner
  // The amp ignores tempos below 40 BPM (it acknowledges them) and needs a float; 300 was the highest value tested.
  setBpm: (bpm) => {
    if (!(bpm >= 40 && bpm <= 300)) throw new RangeError(`tempo out of range (40-300 BPM): ${bpm}`);
    return set(0x62, bytesOf((w) => w.float(bpm)));
  },
  setTuner: (on) => set(0x65, bytesOf((w) => w.bool(on))),
  tuner: () => get(0x65, empty, (r) => r.bool()),

  // Settings
  setImpedance: (input, mode) => set(0x74, bytesOf((w) => w.array(1).int(input).int(mode))),
  impedance: () => get(0x74, bytesOf((w) => w.array(1).int(0)), (r) => structArray(r, (x) => ({ input: x.int(), mode: x.int() }))),
  setLineOutMute: (on) => set(0xa2, bytesOf((w) => w.bool(on)), (r) => r.int()),
  lineOutMute: () => get(0xa2, empty, (r) => r.bool()),
  setExpMode: (mode) => set(0xb2, bytesOf((w) => w.int(mode))),
  expMode: () => get(0xb2, empty, (r) => r.int()),
  // REACTOR answers with 4 entries; only the first is meaningful, and the other three sometimes hold leftover memory
  // of any type and length.
  inputState: () => get(0x73, bytesOf((w) => w.array(1).int(0)), (r) => firstEntry(r, readInputState)),
};

// The 01 commands built above. The client sends reads (02) and these, and refuses anything else (docs/protocol.md,
// section 4.9).
export const SET_SUBS = new Set([0x01, 0x04, 0x06, 0x15, 0x38, 0x62, 0x65, 0x74, 0xa2, 0xa6, 0xa7, 0xb1, 0xb2, 0xb3]);

function readSlotState(r) {
  return { chain: r.int(), slot: r.int(), edited: r.bool() };
}

// An input's entry: the input number, an int that was always 0, and whether a cable is plugged in.
function readInputState(r) {
  const input = r.int();
  r.int();
  return { input, plugged: r.bool() };
}

// The events received from the amp (docs/protocol.md, section 5). Other subs decode as 'unknown'.
const EVENTS = {
  0x15: (r) => ({ type: 'effectActive', dsp: r.pstr(), active: r.bool(), chain: r.int() }),
  0x1a: (r) => ({ type: 'presetState', states: structArray(r, readSlotState) }),
  0x27: (r) => ({ type: 'presetSaved', presetType: r.int(), slot: r.int() }),
  0x37: (r) => ({ type: 'paramChanged', dsp: r.pstr(), index: r.int(), value: r.number(), chain: r.int() }),
  0x38: (r) => ({ type: 'presetSelected', presetType: r.int(), slot: r.int() }),
  0x63: (r) => ({ type: 'tap', bpm: r.number() }),
  0x64: (r) => ({ type: 'tuner', note: r.int(), deviation: r.number() }),
  0x65: (r) => ({ type: 'tunerActive', active: r.bool() }),
  0x73: (r) => ({ type: 'inputState', inputs: structArray(r, readInputState) }),
  0xb1: (r) => ({ type: 'ampSelected', bank: r.int(), variant: r.int() }),
  0xb3: (r) => ({ type: 'categorySelected', category: r.int(), selected: r.bool() }),
};

export const TUNER_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function parseEvent(message) {
  const decode = message.cmd === CMD.REPLY ? EVENTS[message.sub] : null;
  if (decode) {
    try {
      const r = new Reader(message.payload);
      const event = { ...decode(r), seq: message.seq };
      if (r.remaining) event.trailing = message.payload.slice(r.i);
      return event;
    } catch (e) {
      return { type: 'malformed', sub: message.sub, error: String(e), payload: message.payload, seq: message.seq };
    }
  }
  return { type: 'unknown', cmd: message.cmd, sub: message.sub, payload: message.payload, seq: message.seq };
}
