// Transport-independent client: sequence numbers, request/reply matching, acked multi-part uploads and events.
// A transport is { write(bytes): Promise, onData: (bytes) => void (set by the client), close?() }.

import { Reader } from './codec.js';
import { ChunkSplitter, Reassembler, frame, parseChunk, splitParts } from './framing.js';
import { CMD, Requests, SET_SUBS, firmwareText, parseEvent } from './messages.js';
import { AMP_KNOBS, AMPS, REACTOR_AMP } from './models.js';
import { LIVE_BANK, TEMP_BANK, TEMP_SLOT, VARIANTS, buildAmpBatch, parseAmp, parsePreset, paramValue, serializePreset, withHeader } from './preset.js';

export class TimeoutError extends Error {}
export class DisconnectedError extends Error {}

const MAX_REQUEST_SEQ = 0x3f; // the amp numbers its own events 0x40-0x7F

export class ReactorClient {
  constructor(transport, { timeout = 3000, uploadTimeout = 5000, paramInterval = 25, variantSettle = 250, presetSettle = 500, log = null } = {}) {
    this.transport = transport;
    this.timeout = timeout;
    this.uploadTimeout = uploadTimeout;
    this.paramInterval = paramInterval;
    this.variantSettle = variantSettle;
    this.presetSettle = presetSettle;
    this.log = log;
    this.seq = 0;
    this.waiters = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.pendingParams = new Map();
    this.paramFlush = null;
    this.splitter = new ChunkSplitter((b) => this.log?.('stray byte', b));
    this.reassembler = new Reassembler();
    transport.onData = (bytes) => this.receive(bytes);
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        this.log?.('listener error', e);
      }
    }
  }

  receive(bytes) {
    for (const raw of this.splitter.push(bytes)) {
      let message;
      try {
        message = this.reassembler.push(parseChunk(raw));
      } catch (e) {
        this.log?.('bad chunk', e);
        continue;
      }
      if (message) this.dispatch(message);
    }
  }

  dispatch(m) {
    const i = this.waiters.findIndex((w) => w.seq === m.seq && w.cmd === m.cmd && w.sub === m.sub);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
      return;
    }
    if (m.seq > MAX_REQUEST_SEQ) this.emit(parseEvent(m));
    else this.log?.('unmatched reply', m.cmd, m.sub, m.seq);
  }

  nextSeq() {
    this.seq = (this.seq % MAX_REQUEST_SEQ) + 1;
    return this.seq;
  }

  waitFor(seq, cmd, sub, timeout) {
    let w;
    const promise = new Promise((resolve, reject) => {
      w = { seq, cmd, sub, resolve, reject };
      w.timer = setTimeout(() => this.dropWaiter(w, new TimeoutError(`no ${hex(cmd)} ${hex(sub)} reply to seq ${seq}`)), timeout);
    });
    this.waiters.push(w);
    promise.catch(() => {});
    promise.cancel = (error) => this.dropWaiter(w, error);
    return promise;
  }

  dropWaiter(w, error) {
    const i = this.waiters.indexOf(w);
    if (i < 0) return;
    this.waiters.splice(i, 1);
    clearTimeout(w.timer);
    w.reject(error);
  }

  // Fails every outstanding request, e.g. after the connection was lost.
  failAll(error = new DisconnectedError('disconnected')) {
    for (const w of [...this.waiters]) this.dropWaiter(w, error);
  }

  // The only place that writes to the transport. execute() calls it with requests that checked() has approved.
  async #write(bytes, reply) {
    try {
      await this.transport.write(bytes);
    } catch (e) {
      reply?.cancel(e);
      throw e;
    }
  }

  // Runs requests one at a time, in order.
  send(request, { timeout = this.timeout } = {}) {
    const run = this.queue.then(() => this.execute(request, timeout));
    this.queue = run.catch(() => {});
    return run;
  }

  async execute(request, timeout) {
    const req = checked(request);
    const seq = this.nextSeq();
    if (req.sliced) {
      for (const part of splitParts(req.payload, req.partSize)) {
        const ack = this.waitFor(seq, CMD.ACK, req.sub, timeout);
        await this.#write(frame(seq, req.cmd, req.sub, part), ack);
        await ack;
      }
      return null;
    }
    const reply = req.reply ? this.waitFor(seq, req.reply.cmd, req.reply.sub, timeout) : null;
    await this.#write(frame(seq, req.cmd, req.sub, req.payload), reply);
    if (!reply) return null;
    const m = await reply;
    if (req.raw || !req.parse) return m.payload;
    const r = new Reader(m.payload);
    let value;
    try {
      value = req.parse(r, m);
    } catch (e) {
      throw new Error(`cannot decode the ${hex(req.cmd)} ${hex(req.sub)} reply (${m.payload.length} bytes): ${e.message}`);
    }
    if (r.remaining) this.log?.(`${hex(req.cmd)} ${hex(req.sub)} reply has ${r.remaining} unparsed bytes`);
    return value;
  }

  // Parameter changes while a control moves: only the latest value per parameter is sent, at most every paramInterval ms.
  setParamLive(dsp, index, value) {
    this.pendingParams.set(`${dsp}\u0000${index}`, [dsp, index, value]);
    if (this.paramFlush) return this.paramFlush;
    this.paramFlush = new Promise((resolve) => setTimeout(resolve, this.paramInterval)).then(() => {
      const batch = [...this.pendingParams.values()];
      this.pendingParams.clear();
      this.paramFlush = null;
      return Promise.all(batch.map(([d, i, v]) => this.send(Requests.setParam(d, i, v))));
    });
    return this.paramFlush;
  }

  // ---- reads

  async info() {
    const firmware = await this.send(Requests.firmware());
    return { name: await this.send(Requests.name()), firmware: firmwareText(firmware), firmwareRaw: firmware };
  }

  presetBlob(slot) {
    return this.send(Requests.presetBlob(slot));
  }

  currentPresetBlob() {
    return this.send(Requests.currentPresetBlob());
  }

  async preset(slot) {
    return parsePreset(await this.presetBlob(slot));
  }

  async currentPreset() {
    return parsePreset(await this.currentPresetBlob());
  }

  currentSlot() {
    return this.send(Requests.currentSlot());
  }

  async edited() {
    const state = await this.send(Requests.slotState());
    return state ? state.edited : false;
  }

  ampBlob(bank, variant) {
    return this.send(Requests.ampBlob(bank, variant));
  }

  async ampBank(bank) {
    const out = [];
    for (let v = 0; v < VARIANTS; v++) out.push(await this.ampBlob(bank, v));
    return out;
  }

  // ---- edits of the current preset

  setParam(dsp, index, value) {
    return this.send(Requests.setParam(dsp, index, value));
  }

  param(dsp, index) {
    return this.send(Requests.param(dsp, index));
  }

  setActive(dsp, on) {
    return this.send(Requests.setActive(dsp, on));
  }

  active(dsp) {
    return this.send(Requests.active(dsp));
  }

  // Replaces an effect model the way the app does. The new block keeps the old one's on/off state (and a delay keeps its
  // BPM switch); its other parameters start at the model's defaults.
  async replaceModel(from, to, { category, wasActive = false } = {}) {
    await this.send(Requests.replaceModel(from, to));
    if (wasActive) await this.send(Requests.setActive(to, true));
    if (category !== undefined) await this.send(Requests.selectCategory(category, true));
  }

  swapBlocks(a, b) {
    return this.send(Requests.swapBlocks(a, b));
  }

  selectCategory(category) {
    return this.send(Requests.selectCategory(category, true));
  }

  setBpm(bpm) {
    return this.send(Requests.setBpm(bpm));
  }

  // Amp variant k = 5 x row (0 Smooth, 1 centre, 2 Push) + column (Heat -2..+2 -> 0..4). The amp keeps the current knob
  // values. Like the app, this re-sends them afterwards, but only once the amp has loaded the variant: knob values that
  // arrive within about 100 ms of the change can be overwritten by the variant's own (the latest seen: 92 ms).
  async setAmpVariant(k, knobValues) {
    await this.send(Requests.setParam(REACTOR_AMP, 0, k / 14));
    if (!knobValues) return;
    await new Promise((resolve) => setTimeout(resolve, this.variantSettle));
    for (const [i, knob] of AMP_KNOBS.entries()) await this.send(Requests.setParam(knob.dsp, knob.index, knobValues[i]));
  }

  // Makes an Amp-selector amp (bank 0-5) the live amp, centre variant, as the app's amp picker does. The knob values are
  // kept if that amp was already live, otherwise they become the variant's own. Afterwards bank 7F does not answer until
  // a preset is selected or 7F is written (docs/protocol.md, section 4.3).
  selectAmp(bank, variant = 7) {
    const selectable = Number.isInteger(bank) && ((bank >= 0 && bank <= 5) || bank === TEMP_BANK);
    if (!selectable) throw new RangeError(`no Amp-selector amp in bank ${bank}`);
    if (!(Number.isInteger(variant) && variant >= 0 && variant < VARIANTS)) throw new RangeError(`no amp variant ${variant}`);
    return this.send(Requests.switchAmp(bank, variant));
  }

  // Resolves once the amp has switched: a 02 1A read sent right after the ack can still report the previous preset's
  // edited flag.
  async selectPreset(slot) {
    checkSlot(slot);
    await this.send(Requests.selectPreset(slot));
    await new Promise((resolve) => setTimeout(resolve, this.presetSettle));
  }

  // ---- uploads

  // Stores a preset into slot 0-7, or loads it into the temporary slot (TEMP_SLOT). Refuses data that fails its
  // checksum.
  uploadPreset(blob, slot) {
    checkSlot(slot);
    if (!parsePreset(blob).checksumOk) throw new Error('refusing to upload a preset that fails its checksum');
    return this.send(Requests.uploadPreset(withHeader(blob, 0x00, slot)), { timeout: this.uploadTimeout });
  }

  // Writes all 15 variants of an amp bank: variant 0 in full, then 1-14 as differences. Only the banks the official
  // app writes are allowed: a slot's bank (10-17) and the working bank (7F), never the built-in amps (00-05).
  async uploadAmpBank(bank, variants) {
    if (!isWritableBank(bank)) throw new RangeError(`refusing to write amp bank ${bank}`);
    if (!parseAmp(variants[0]).checksumOk) throw new Error('refusing to upload amp data that fails its checksum');
    const batch = buildAmpBatch(bank, variants);
    await this.send(Requests.uploadAmp(withHeader(variants[0], bank, 0)), { timeout: this.uploadTimeout });
    await this.send(Requests.uploadAmp(batch), { timeout: this.uploadTimeout });
  }

  // Loads a preset and its amp into the temporary slot and makes it current (what the app does for library and
  // ToneCloud presets). Nothing is stored.
  async loadTemporary(presetBlob, ampVariants) {
    await this.uploadPreset(presetBlob, TEMP_SLOT);
    await this.selectPreset(TEMP_SLOT);
    await this.uploadAmpBank(TEMP_BANK, ampVariants);
  }

  // The bank with the 15 variants of a custom amp (not an Amp-selector amp, e.g. one from ToneCloud): the first
  // candidate whose variants are all that amp (same meta id and name). 7D/1-14 cannot tell: the amp refreshes them on a
  // temporary load, but not when 7F is written while a stored slot is current, and selecting a stored slot can put the
  // live knob values into them. Returns { bank, variants } or null.
  async customAmpBank(amp, candidates) {
    for (const bank of candidates) {
      const variants = [await this.ampBlob(bank, 0)];
      if (!sameModel(parseAmp(variants[0]), amp)) continue;
      for (let v = 1; v < VARIANTS; v++) variants.push(await this.ampBlob(bank, v));
      if (variants.every((blob) => sameModel(parseAmp(blob), amp))) return { bank, variants };
    }
    return null;
  }

  // The 15 amp variants to store with the current preset, assembled like the app's save: the variants of the
  // Amp-selector amp the preset uses, with the selected variant replaced by the live amp (which includes knob
  // changes). Other amps (e.g. from ToneCloud presets, or a library amp the app loaded under another name) keep the
  // variants the amp is working with (bank 7F). All 15 must be the same model: a variant whose metadata differs
  // from variant 0 cannot be written (section 8).
  async currentAmpVariants(preset) {
    const reactorAmp = preset.blocks.find((b) => b.code === REACTOR_AMP_CODE);
    if (!reactorAmp) throw new Error('the preset has no ReactorAmp block');
    const k = Math.round(paramValue(reactorAmp, 0));
    if (!(k >= 0 && k < VARIANTS)) throw new Error(`amp variant ${k} out of range`);
    const live = await this.ampBlob(LIVE_BANK, 0);
    const liveAmp = parseAmp(live);
    if (!sameModel(liveAmp, preset.amp)) {
      throw new Error('the live amp does not match the current preset');
    }
    const library = libraryAmp(preset.amp);
    let bank;
    let variants;
    if (library && library.name === preset.amp.name) {
      bank = library.bank;
      variants = await this.ampBank(bank);
    } else {
      // 7F is the amp's working copy of the current preset's amp: selecting a stored slot copies the slot's bank there,
      // and a temporary load writes it. The slot's own bank is the fallback.
      const { slot } = await this.currentSlot();
      const found = await this.customAmpBank(liveAmp, slot < 8 ? [TEMP_BANK, 0x10 + slot] : [TEMP_BANK]);
      if (!found) throw new Error(`cannot find the variants of the amp "${preset.amp.name}"`);
      ({ bank, variants } = found);
    }
    variants[k] = withHeader(live, bank, k);
    return variants;
  }

  // The current preset (with its edits) and the 15 amp variants that go with it: what a save stores and an export
  // writes. current = the amp's current preset ({ type, slot }).
  async currentWithAmp() {
    const current = await this.currentSlot();
    const blob = await this.currentPresetBlob();
    const preset = parsePreset(blob);
    if (!preset.checksumOk) throw new Error('the current preset failed its checksum');
    const ampVariants = await this.currentAmpVariants(preset);
    return { current, blob, preset, ampVariants };
  }

  // Stores the current preset (with its edits) and its amp into a slot, like the app's save, optionally under a new
  // name, then reads the slot back to check it (verify: false skips that). When the target is not the current slot, it
  // then selects the target, so the stored copy becomes current.
  async saveCurrent(slot, { name, verify = true } = {}) {
    if (!isStoredSlot(slot)) throw new RangeError(`no preset slot ${slot}`);
    const { current, blob, preset, ampVariants } = await this.currentWithAmp();
    const upload = name === undefined || name === preset.name ? blob : serializePreset({ ...preset, name });
    await this.uploadPreset(upload, slot);
    await this.uploadAmpBank(0x10 + slot, ampVariants);
    if (verify) await this.verifySlot(slot, upload, ampVariants);
    if (current.slot !== slot) await this.selectPreset(slot);
  }

  // What a slot holds now: its preset and its 15 amp variants, e.g. to put them back after a save.
  async backupSlot(slot) {
    if (!isStoredSlot(slot)) throw new RangeError(`no preset slot ${slot}`);
    return { slot, blob: await this.presetBlob(slot), ampVariants: await this.ampBank(0x10 + slot) };
  }

  // Writes a preset and its amp variants into a slot (e.g. a backup) and checks them.
  async writeSlot(slot, blob, ampVariants) {
    if (!isStoredSlot(slot)) throw new RangeError(`no preset slot ${slot}`);
    await this.uploadPreset(blob, slot);
    await this.uploadAmpBank(0x10 + slot, ampVariants);
    await this.verifySlot(slot, blob, ampVariants);
  }

  // Reads a slot back and throws unless it holds exactly this preset and these amp variants.
  async verifySlot(slot, blob, ampVariants) {
    const problems = [];
    if (!sameAfterHeader(await this.presetBlob(slot), blob)) problems.push('preset');
    const stored = await this.ampBank(0x10 + slot);
    stored.forEach((v, i) => {
      if (!sameAfterHeader(v, ampVariants[i])) problems.push(`amp variant ${i}`);
    });
    if (problems.length) throw new Error(`the amp does not hold what was written (${problems.join(', ')})`);
  }
}

const REACTOR_AMP_CODE = 0x040d;

const MAX_UPLOAD = 8192; // bytes; a preset is about 1.3 KB and an amp's data about 1 KB

const isByte = (v) => Number.isInteger(v) && v >= 0 && v <= 0xff;
const isStoredSlot = (slot) => Number.isInteger(slot) && slot >= 0 && slot < 8;
// The amp banks a client may write: a slot's bank (10-17) and the working bank (7F), never the built-in amps (00-05).
const isWritableBank = (bank) => Number.isInteger(bank) && ((bank >= 0x10 && bank <= 0x17) || bank === TEMP_BANK);

function checkSlot(slot) {
  if (!(isStoredSlot(slot) || slot === TEMP_SLOT)) throw new RangeError(`no preset slot ${slot}`);
}

// Checks a request and returns a frozen copy, so that what is sent is exactly what was checked. Only reads (02) and the
// 01 commands Requests builds (SET_SUBS) are sent; an unknown command may change the amp's settings or stored data
// (docs/protocol.md, section 4.9). Uploads may only go to a preset slot, the temporary slot, a slot's amp bank or the
// working bank.
function checked(request) {
  const { cmd, sub, payload, reply, parse, raw, sliced, partSize } = request;
  if (!isByte(cmd) || !isByte(sub)) throw new RangeError('refusing a request whose type or command is not a byte');
  if (cmd !== CMD.GET && !(cmd === CMD.SET && SET_SUBS.has(sub))) {
    throw new Error(`refusing to send ${hex(cmd)} ${hex(sub)}: not a request this library builds`);
  }
  if (!(payload instanceof Uint8Array)) throw new TypeError('the payload must be a Uint8Array');
  const replyCopy = reply ? { cmd: reply.cmd, sub: reply.sub } : null;
  const req = {
    cmd, sub, payload: payload.slice(), reply: replyCopy, parse, raw: Boolean(raw), sliced: Boolean(sliced), partSize,
  };
  if (cmd === CMD.SET && (sub === 0x01 || sub === 0xa7)) checkUpload(req);
  return Object.freeze(req);
}

function checkUpload({ sub, payload, sliced, partSize }) {
  if (!sliced || !Number.isInteger(partSize) || partSize < 1) throw new Error('an upload must be sent in parts');
  if (payload.length < 2 || payload.length > MAX_UPLOAD) {
    throw new RangeError(`refusing an upload of ${payload.length} bytes`);
  }
  const [a, b] = payload;
  if (sub === 0x01) {
    if (a !== 0x00 || !(b < 8 || b === TEMP_SLOT)) {
      throw new RangeError(`refusing to upload a preset to ${hex(a)} ${hex(b)}`);
    }
    return;
  }
  // 01 A7 carries either an amp's data (<bank> <variant> …) or a difference message (03 <bank> …).
  const bank = a === 0x03 ? b : a;
  if (!isWritableBank(bank)) throw new RangeError(`refusing to write amp bank ${hex(bank)}`);
  if (a !== 0x03 && b >= VARIANTS) throw new RangeError(`no amp variant ${b}`);
}

// Same data apart from the 2-byte header.
function sameAfterHeader(a, b) {
  return a.length === b.length && a.every((x, i) => i < 2 || x === b[i]);
}

function hex(n) {
  return n.toString(16).padStart(2, '0');
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Same amp model: same meta id and name.
function sameModel(a, b) {
  return toHex(a.id) === toHex(b.id) && a.name === b.name;
}

// The Amp-selector amp (bank 00-05) an amp is a copy of: the one with the same meta id. A custom amp can borrow a
// library amp's name, so the name alone does not count.
export function libraryAmp(amp) {
  const id = toHex(amp.id);
  return AMPS.find((a) => a.id === id) ?? null;
}
