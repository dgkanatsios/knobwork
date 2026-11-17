// Live hardware self-test (selftest.html). Exercises the protocol library against a real REACTOR and leaves the amp
// exactly as it found it: it snapshots every preset and amp bank, writes preset slots and their amp banks only with data
// identical to what is already stored, and compares a final snapshot with the first one. It puts back unsaved changes
// that were loaded as a temporary preset and refuses to start on any other unsaved changes. Settings and the working
// amp bank 7F (including deliberately corrupted difference messages) are changed only temporarily.

import {
  AMP_KNOBS, BLOCK_CODES, CATEGORIES, MODEL_BY_DSP, REACTOR_AMP, ReactorClient, Requests, TEMP_BANK, buildAmpBatch, crc32mpeg2, floatToHalf, halfToFloat, modelsIn, parseAmp, parseAmpBatch, parsePreset, serializeAmp,
  serializePreset,
} from '../src/protocol/index.js';
import { WebBluetoothTransport } from '../src/transport/web-bluetooth.js';
import { fromPresetFile, toPresetFile } from '../src/preset-file.js';

const LIVE = 0x7d;
const BANKS = [0, 1, 2, 3, 4, 5, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, TEMP_BANK];
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const body = (b) => b.subarray(2);
const same = (a, b) => hex(a) === hex(b);
const sameBodies = (a, b) => a.length === b.length && a.every((x, i) => same(body(x), body(b[i])));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dspOf = (block) => BLOCK_CODES[block.code];

class Abort extends Error {}

export async function runSelfTest({ onLog } = {}) {
  const log = (text) => {
    console.log(text);
    onLog?.(text);
  };
  const checks = [];
  const findings = {};
  const clientLog = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    return Boolean(ok);
  };
  const finding = (name, value) => {
    findings[name] = value;
    log(`note ${name}: ${JSON.stringify(value)}`);
  };

  log('Connecting…');
  const transport = await WebBluetoothTransport.request();
  const client = new ReactorClient(transport, { timeout: 5000, log: (...a) => clientLog.push(a.join(' ')) });
  const events = [];
  client.on((e) => events.push(e));
  const eventsSince = (n, type) => events.slice(n).filter((e) => e.type === type);
  let snap = null;
  let editBuffer = null; // unsaved changes found at the start, put back at the end
  let restoreFailed = false;

  async function snapshot() {
    const s = { presets: [], banks: new Map() };
    for (let i = 0; i < 8; i++) s.presets.push(await client.presetBlob(i));
    for (const bank of BANKS) s.banks.set(bank, await client.ampBank(bank));
    s.live = [...(await client.ampBank(LIVE)), await client.ampBlob(LIVE, 15)];
    s.presetChecksums = await client.send(Requests.presetChecksums());
    s.ampChecksums = await client.send(Requests.ampChecksums());
    s.current = await client.currentSlot();
    s.edited = await client.edited();
    s.currentBlob = await client.currentPresetBlob();
    s.impedance = await client.send(Requests.impedance());
    s.lineOutMute = await client.send(Requests.lineOutMute());
    s.expMode = await client.send(Requests.expMode());
    s.tuner = await client.send(Requests.tuner());
    return s;
  }

  // Puts the current preset back to `target` (same models in the same places) by re-sending what differs.
  async function restoreEdits(target) {
    const cur = await client.currentPreset();
    if (cur.bpm !== target.bpm) await client.setBpm(target.bpm);
    const after = cur.bpm !== target.bpm ? await client.currentPreset() : cur;
    const pairs = [...target.amp.blocks.map((b, i) => [b, after.amp.blocks[i]]), ...target.blocks.map((b, i) => [b, after.blocks[i]])];
    for (const [want, have] of pairs) {
      if (want.code !== have.code) throw new Error(`block ${dspOf(want)} is not where it was`);
      for (let i = 0; i < want.params.length; i++) {
        if (want.params[i] !== have.params[i]) await client.setParam(dspOf(want), i, halfToFloat(want.params[i]));
      }
      if (want.active !== have.active && dspOf(want) !== REACTOR_AMP && !dspOf(want).startsWith('Amp.')) await client.setActive(dspOf(want), want.active);
    }
    await sleep(100);
  }

  const currentBody = async () => body(await client.currentPresetBlob());

  try {
    // ---- 1. device and the reads the library uses
    const info = await client.info();
    check('device name', /reactor/i.test(info.name), info.name);
    check('firmware is the one the protocol was decoded on', info.firmware === '0.2.5.108', info.firmware);
    const reads = [
      ['02 11 name', Requests.name(), (v) => typeof v === 'string'],
      ['02 2F firmware', Requests.firmware(), (v) => v === info.firmwareRaw],
      ['02 10 current preset', Requests.currentSlot(), (v) => v.type === 0],
      ['02 1A preset state', Requests.slotState(), (v) => typeof v.edited === 'boolean'],
      ['02 2B preset checksums', Requests.presetChecksums(), (v) => v.length === 8],
      ['02 AB amp checksums', Requests.ampChecksums(), (v) => v.length === 14],
      ['02 04 parameter', Requests.param('Amp.Preamp', 0), (v) => v >= 0 && v <= 1],
      ['02 15 effect on/off', Requests.active('Amp.Preamp'), (v) => typeof v === 'boolean'],
      ['02 65 tuner', Requests.tuner(), (v) => typeof v === 'boolean'],
      ['02 74 impedance', Requests.impedance(), (v) => v.length === 1],
      ['02 73 input state', Requests.inputState(), (v) => typeof v.plugged === 'boolean'],
      ['02 A2 line out mute', Requests.lineOutMute(), (v) => typeof v === 'boolean'],
      ['02 B2 expression mode', Requests.expMode(), (v) => v >= 0 && v <= 2],
    ];
    for (const [name, req, valid] of reads) {
      const before = clientLog.length;
      const value = await client.send(req);
      check(`read ${name}`, valid(value) && clientLog.length === before);
    }

    // ---- 2. snapshot (also checks that every preset and amp blob round-trips byte for byte)
    log('Reading every preset and amp bank…');
    snap = await snapshot();
    if (snap.edited) {
      // After a temporary load (how the official app loads library and ToneCloud presets) 7D/1-14 equal 7F/1-14. In
      // that state the current preset and bank 7F are all there is to the unsaved changes, so loading them again as a
      // temporary preset puts everything back exactly. Otherwise 7D/1-14 cannot be recreated (section 12, item 8).
      const restorable = snap.banks.get(TEMP_BANK).slice(1).every((x, i) => same(body(x), body(snap.live[i + 1])));
      if (!restorable || snap.current.slot > 7) {
        snap = null; // nothing was changed, so there is nothing to restore
        throw new Abort('the current preset has unsaved changes this test cannot put back: save or discard them first');
      }
      editBuffer = snap;
      log(`The current preset has unsaved changes (“${parsePreset(snap.currentBlob).name}”); they will be put back at the end.`);
      await client.selectPreset(snap.current.slot);
      await sleep(300);
      snap = await snapshot();
      if (snap.edited) throw new Abort('selecting the stored preset did not clear its edits');
    }
    if (snap.current.slot > 7) {
      snap = null;
      throw new Abort('the current preset must be a stored slot');
    }
    const slot = snap.current.slot;
    const slotBank = 0x10 + slot;
    let roundTrips = 0;
    let blobs = 0;
    for (const blob of snap.presets) {
      const p = parsePreset(blob);
      blobs++;
      if (p.checksumOk && same(serializePreset(p), blob)) roundTrips++;
    }
    for (const variants of [...snap.banks.values(), snap.live]) {
      for (const blob of variants) {
        const a = parseAmp(blob);
        blobs++;
        if (a.checksumOk && same(serializeAmp(a), blob)) roundTrips++;
      }
    }
    check('every preset and amp variant passes its checksum and re-serializes byte for byte', roundTrips === blobs, `${roundTrips}/${blobs}`);

    // ---- 3. current preset, live amp and the slot's bank
    const original = parsePreset(snap.currentBlob);
    const k0 = Math.round(halfToFloat(original.blocks.find((b) => dspOf(b) === REACTOR_AMP).params[0]));
    check('the unedited current preset equals its stored slot', same(body(snap.currentBlob), body(snap.presets[slot])));
    check(`the live amp (7D/0) is variant ${k0} of bank ${slotBank.toString(16)}`, same(body(snap.live[0]), body(snap.banks.get(slotBank)[k0])));
    check('7D/15 equals 7D/0', same(body(snap.live[15]), body(snap.live[0])));
    finding('7F equals the slot bank', snap.banks.get(TEMP_BANK).every((v, i) => same(body(v), body(snap.banks.get(slotBank)[i]))));
    finding('7D/1-14 equal 7F/1-14 (not always, section 12 item 8)', snap.live.slice(1, 15).every((v, i) => same(body(v), body(snap.banks.get(TEMP_BANK)[i + 1]))));
    check("the preset's amp section is the live amp", same(serializeAmp({ ...original.amp, bank: 0, variant: 0 }).subarray(2), body(snap.live[0])));

    // ---- 4. one parameter
    const target = original.blocks.find((b) => MODEL_BY_DSP[dspOf(b)]?.params.some((x) => x.kind === 'scale'));
    const tDsp = dspOf(target);
    const tIdx = MODEL_BY_DSP[tDsp].params.findIndex((x) => x.kind === 'scale');
    const v0 = await client.param(tDsp, tIdx);
    check(`02 04 reads ${tDsp}[${tIdx}] as its stored half value`, v0 === halfToFloat(target.params[tIdx]), String(v0));
    const v1 = v0 < 0.5 ? v0 + 0.2345 : v0 - 0.2345;
    let n = events.length;
    await client.setParam(tDsp, tIdx, v1);
    await sleep(200);
    const got = await client.param(tDsp, tIdx);
    check('02 04 reads back the value as sent (float32)', got === Math.fround(v1), `${got}`);
    const storedBits = (await client.currentPreset()).blocks.find((b) => b.code === target.code).params[tIdx];
    check('the preset stores it as half precision, rounded like floatToHalf', storedBits === floatToHalf(v1), storedBits.toString(16));
    check('the preset is now edited', await client.edited());
    finding('events after an app-side 01 04', [...new Set(events.slice(n).map((e) => e.type))]);
    await client.setParam(tDsp, tIdx, v0);
    await sleep(100);
    check('01 04 puts the old value back exactly', (await client.param(tDsp, tIdx)) === v0);
    check('the current preset is back to the stored bytes', same(await currentBody(), body(snap.currentBlob)));

    // ---- 5. on/off
    n = events.length;
    await client.setActive(tDsp, !target.active);
    check('01 15 switches the effect', (await client.active(tDsp)) === !target.active);
    finding('events after 01 15', events.slice(n).map((e) => e.type));
    await client.setActive(tDsp, target.active);
    check('01 15 switches it back', (await client.active(tDsp)) === target.active);

    // ---- 6. model change and back
    const modPos = original.blocks.findIndex((b) => MODEL_BY_DSP[dspOf(b)] && modelsIn(MODEL_BY_DSP[dspOf(b)].category).length > 1);
    const modBlock = original.blocks[modPos];
    const from = dspOf(modBlock);
    const category = MODEL_BY_DSP[from].category;
    const to = modelsIn(category).find((m) => m.dspId !== from).dspId;
    n = events.length;
    await client.replaceModel(from, to, { category: CATEGORIES.indexOf(category), wasActive: modBlock.active });
    let cur = await client.currentPreset();
    check(`01 06 puts ${to} where ${from} was`, dspOf(cur.blocks[modPos]) === to);
    check(`${to} has its ${MODEL_BY_DSP[to].params.length} parameters`, cur.blocks[modPos].params.length === MODEL_BY_DSP[to].params.length);
    finding(`${to} after 01 06 (+01 15 if the old model was on)`, { active: cur.blocks[modPos].active, wasActive: modBlock.active, params: cur.blocks[modPos].params.map((x) => +halfToFloat(x).toFixed(4)) });
    finding('events after a model change', events.slice(n).map((e) => e.type));
    await client.replaceModel(to, from, { category: CATEGORIES.indexOf(category), wasActive: modBlock.active });
    await restoreEdits(original);
    check('model, parameters and on/off restored to the stored bytes', same(await currentBody(), body(snap.currentBlob)));

    // ---- 7. swap two neighbouring blocks after the amp, and back
    const ampPos = original.blocks.findIndex((b) => dspOf(b) === REACTOR_AMP);
    const a = original.blocks.length - 2;
    if (a > ampPos) {
      await client.swapBlocks(a, a + 1);
      cur = await client.currentPreset();
      check('01 A6 swaps two blocks with their settings', JSON.stringify(cur.blocks[a]) === JSON.stringify(original.blocks[a + 1]) &&
        JSON.stringify(cur.blocks[a + 1]) === JSON.stringify(original.blocks[a]));
      await client.swapBlocks(a, a + 1);
      check('swapping again restores the stored bytes', same(await currentBody(), body(snap.currentBlob)));
    }

    // ---- 8. tempo (and its BPM-sync side effect)
    const bpm = original.bpm + (original.bpm < 250 ? 1 : -1);
    await client.setBpm(bpm);
    cur = await client.currentPreset();
    check('01 62 sets the preset tempo', cur.bpm === Math.fround(bpm), String(cur.bpm));
    const synced = [];
    cur.blocks.forEach((b, i) => b.params.forEach((bits, j) => {
      if (bits !== original.blocks[i].params[j]) synced.push(`${dspOf(b)}[${j}] ${MODEL_BY_DSP[dspOf(b)]?.params[j]?.label} → ${halfToFloat(bits)}`);
    }));
    finding('parameters changed by 01 62', synced);
    check('01 62 only switches BPM sync on', cur.blocks.every((b, i) => b.params.every((bits, j) => bits === original.blocks[i].params[j] ||
      (/^BPM( Sync)?$/.test(MODEL_BY_DSP[dspOf(b)]?.params[j]?.label ?? '') && halfToFloat(bits) === 1))));
    await restoreEdits(original);
    check('tempo and BPM sync restored to the stored bytes', same(await currentBody(), body(snap.currentBlob)));

    // ---- 9. tuner
    n = events.length;
    await client.send(Requests.setTuner(true));
    await sleep(3000);
    const readings = eventsSince(n, 'tuner');
    check('01 65 on streams 03 64 readings', readings.length >= 3, `${readings.length} in 3 s`);
    check('tuner readings are in range', readings.every((r) => r.note >= 0 && r.note <= 11 && (r.deviation === -1 || (r.deviation >= 0 && r.deviation <= 1))));
    await client.send(Requests.setTuner(false));
    await sleep(200);
    check('01 65 off', (await client.send(Requests.tuner())) === false);

    // ---- 10. settings
    const hiz0 = snap.impedance[0].mode;
    await client.send(Requests.setImpedance(0, hiz0 ? 0 : 1));
    check('01 74 changes the input impedance', (await client.send(Requests.impedance()))[0].mode === (hiz0 ? 0 : 1));
    await client.send(Requests.setImpedance(0, hiz0));
    check('01 74 restores it', (await client.send(Requests.impedance()))[0].mode === hiz0);
    await client.send(Requests.setLineOutMute(!snap.lineOutMute));
    check('01 A2 changes line-out muting', (await client.send(Requests.lineOutMute())) === !snap.lineOutMute);
    await client.send(Requests.setLineOutMute(snap.lineOutMute));
    check('01 A2 restores it', (await client.send(Requests.lineOutMute())) === snap.lineOutMute);
    const exp1 = (snap.expMode + 1) % 3;
    await client.send(Requests.setExpMode(exp1));
    check('01 B2 changes the expression pedal mode', (await client.send(Requests.expMode())) === exp1);
    await client.send(Requests.setExpMode(snap.expMode));
    check('01 B2 restores it', (await client.send(Requests.expMode())) === snap.expMode);

    // ---- 11. amp character (variant) and back
    const knobs = AMP_KNOBS.map((kn) => halfToFloat(original.amp.blocks.find((b) => dspOf(b) === kn.dsp).params[kn.index]));
    const k1 = k0 === 12 ? 2 : 12;
    n = events.length;
    await client.setAmpVariant(k1, knobs);
    await sleep(300);
    check('02 04 reads ReactorAmp[0] back as the variant number', (await client.param(REACTOR_AMP, 0)) === k1);
    const expected = parseAmp(snap.banks.get(slotBank)[k1]);
    for (const kn of AMP_KNOBS) expected.blocks.find((b) => dspOf(b) === kn.dsp).params[kn.index] = original.amp.blocks.find((b) => dspOf(b) === kn.dsp).params[kn.index];
    const liveK1 = parseAmp(await client.ampBlob(LIVE, 0));
    const differences = [];
    liveK1.blocks.forEach((b, bi) => b.params.forEach((bits, i) => {
      if (bits !== expected.blocks[bi].params[i]) differences.push(`${dspOf(b)}[${i}] ${halfToFloat(expected.blocks[bi].params[i])} → ${halfToFloat(bits)}`);
    }));
    check(`the live amp becomes variant ${k1} with the preset's knob values`, differences.length === 0, differences.slice(0, 8).join(', '));
    finding('events after a variant change', [...new Set(events.slice(n).map((e) => e.type))]);
    await client.setAmpVariant(k0, knobs);
    await sleep(300);
    check('changing back restores the live amp', same(body(await client.ampBlob(LIVE, 0)), body(snap.live[0])));
    check('and the current preset', same(await currentBody(), body(snap.currentBlob)));

    // ---- 12. export, temporary load, saves
    const exported = await client.currentWithAmp();
    const file = fromPresetFile(JSON.parse(JSON.stringify(toPresetFile(exported.blob, exported.ampVariants))));
    check('export → import round trip', same(file.preset, exported.blob) && sameBodies(file.ampVariants, exported.ampVariants));
    const identicalSave = same(body(exported.blob), body(snap.presets[slot])) && sameBodies(exported.ampVariants, snap.banks.get(slotBank));
    finding(`saving slot ${slot + 1} unedited would store identical data`, identicalSave);
    await client.loadTemporary(file.preset, file.ampVariants);
    finding('02 10 and 02 1A while the temporary preset is current', { current: await client.currentSlot(), state: await client.send(Requests.slotState()) });
    check('the temporary preset is current', same(await currentBody(), body(exported.blob)));
    check('bank 7F holds the uploaded variants (base + difference records applied)', sameBodies(await client.ampBank(TEMP_BANK), file.ampVariants));
    check(`the live amp is variant ${k0} of the upload`, same(body(await client.ampBlob(LIVE, 0)), body(file.ampVariants[k0])));
    if (identicalSave) {
      await client.saveCurrent(slot);
      check('saving the temporary preset selects the slot', (await client.currentSlot()).slot === slot);
      check('the stored preset is unchanged', same(await client.presetBlob(slot), snap.presets[slot]));
      check('the stored amp bank is unchanged', sameBodies(await client.ampBank(slotBank), snap.banks.get(slotBank)));
      await client.saveCurrent(slot);
      check('saving the current slot keeps it current', (await client.currentSlot()).slot === slot);
      check('the stored preset is still unchanged', same(await client.presetBlob(slot), snap.presets[slot]));
      check('the stored amp bank is still unchanged', sameBodies(await client.ampBank(slotBank), snap.banks.get(slotBank)));
      check('stored checksums unchanged', JSON.stringify(await client.send(Requests.presetChecksums())) === JSON.stringify(snap.presetChecksums) &&
        JSON.stringify(await client.send(Requests.ampChecksums())) === JSON.stringify(snap.ampChecksums));
    } else {
      log(`skip save tests: the app's save rule would change bank ${slotBank.toString(16)}`);
    }
    await client.selectPreset(slot);

    // ---- 13. experiments on the temporary bank 7F (not the current preset's bank)
    const temp = await client.ampBank(TEMP_BANK);
    const liveBefore = await client.ampBlob(LIVE, 0);
    const altered = temp.slice();
    const a1 = parseAmp(temp[1]);
    a1.blocks[0].params[0] = floatToHalf(halfToFloat(a1.blocks[0].params[0]) < 0.5 ? 0.75 : 0.25);
    altered[1] = serializeAmp(a1);
    const flat = altered.map((v, i) => (i === 1 ? v : serializeAmp({ ...parseAmp(temp[0]), variant: i })));
    // (a) a difference message that fits one part (header count 1)
    const small = buildAmpBatch(TEMP_BANK, flat);
    check('test batch fits one part', small.length <= 396, `${small.length} bytes`);
    await client.send(Requests.uploadAmp(small));
    const afterSmall = await client.ampBank(TEMP_BANK);
    finding('single-part 01 A7 (count 1) accepted and applied', sameBodies(afterSmall, flat));
    check('a single-part upload is acknowledged and applied', sameBodies(afterSmall, flat));
    // (b) a difference message whose record CRCs are wrong
    const bad = corruptRecordCrcs(buildAmpBatch(TEMP_BANK, temp));
    let accepted = true;
    try {
      await client.send(Requests.uploadAmp(bad));
    } catch (e) {
      accepted = false;
      finding('upload with wrong record CRCs', String(e));
    }
    const afterBad = await client.ampBank(TEMP_BANK);
    finding('records with wrong CRCs were applied', accepted && sameBodies(afterBad, temp));
    finding('records with wrong CRCs left the bank as it was', sameBodies(afterBad, flat));
    check('writing bank 7F does not change the live amp', same(await client.ampBlob(LIVE, 0), liveBefore));
  } catch (e) {
    if (e instanceof Abort) check(e.message, false);
    else check('no unexpected error', false, e?.stack ?? String(e));
  } finally {
    const failedBefore = checks.filter((c) => !c.ok).length;
    if (snap) await restore().catch((e) => check('restore', false, e?.stack ?? String(e)));
    if (editBuffer) await restoreEditBuffer().catch((e) => check('putting the unsaved preset back', false, e?.stack ?? String(e)));
    restoreFailed = checks.filter((c) => !c.ok).length > failedBefore;
    await transport.close().catch(() => {});
  }
  return finish();

  async function restoreEditBuffer() {
    log('Putting the unsaved preset back…');
    await client.loadTemporary(editBuffer.currentBlob, editBuffer.banks.get(TEMP_BANK));
    await sleep(300);
    const current = await client.currentSlot();
    const state = await client.send(Requests.slotState());
    finding('02 10 and 02 1A after putting it back', { current, state });
    check('the unsaved preset is current again, byte for byte', same(body(await client.currentPresetBlob()), body(editBuffer.currentBlob)));
    check('with the same live amp (7D/0-15)', sameBodies([...(await client.ampBank(LIVE)), await client.ampBlob(LIVE, 15)], editBuffer.live));
    check('and the same bank 7F', sameBodies(await client.ampBank(TEMP_BANK), editBuffer.banks.get(TEMP_BANK)));
    check('reported as before (02 10, 02 1A)', current.slot === editBuffer.current.slot && state.edited === editBuffer.edited, JSON.stringify({ current, state }));
  }

  async function restore() {
    log('Restoring and comparing with the first snapshot…');
    await client.send(Requests.setTuner(snap.tuner));
    await client.send(Requests.setImpedance(0, snap.impedance[0].mode));
    await client.send(Requests.setLineOutMute(snap.lineOutMute));
    await client.send(Requests.setExpMode(snap.expMode));
    if (!sameBodies(await client.ampBank(TEMP_BANK), snap.banks.get(TEMP_BANK))) await client.uploadAmpBank(TEMP_BANK, snap.banks.get(TEMP_BANK));
    await client.selectPreset(snap.current.slot);
    await sleep(300);
    const end = await snapshot();
    check('all 8 presets unchanged', end.presets.every((p, i) => same(p, snap.presets[i])));
    for (const bank of BANKS) check(`amp bank ${bank.toString(16).padStart(2, '0')} unchanged`, sameBodies(end.banks.get(bank), snap.banks.get(bank)));
    check('live amp (7D) unchanged', sameBodies(end.live, snap.live));
    check('stored checksums unchanged', JSON.stringify(end.presetChecksums) === JSON.stringify(snap.presetChecksums) && JSON.stringify(end.ampChecksums) === JSON.stringify(snap.ampChecksums));
    check('same preset current, unedited', end.current.slot === snap.current.slot && !end.edited);
    check('current preset bytes unchanged', same(body(end.currentBlob), body(snap.currentBlob)));
    check('settings unchanged', JSON.stringify([end.impedance, end.lineOutMute, end.expMode, end.tuner]) ===
      JSON.stringify([snap.impedance, snap.lineOutMute, snap.expMode, snap.tuner]));
  }

  function finish() {
    const bad = events.filter((e) => e.type === 'unknown' || e.type === 'malformed' || e.trailing);
    check('every amp event decoded completely', bad.length === 0, bad.map((e) => `${e.type} ${e.sub}`).join(', '));
    check('no unparsed or unmatched replies', clientLog.length === 0, clientLog.slice(0, 5).join(' | '));
    const counts = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const failed = checks.filter((c) => !c.ok);
    return { ok: failed.length === 0, restored: !restoreFailed, passed: checks.length - failed.length, failed: failed.map((c) => `${c.name} ${c.detail}`), findings, events: counts };
  }
}

// Zeroes both copies of every record CRC in a difference message and fixes its trailer.
function corruptRecordCrcs(batch) {
  const b = batch.slice();
  let o = 4;
  for (let r = 0; r < b[2]; r++) {
    const len = b[o + 1] | (b[o + 2] << 8);
    b.fill(0, o + 6, o + 10);
    b.fill(0, o + 3 + len, o + 7 + len);
    o += 7 + len;
  }
  new DataView(b.buffer).setUint32(b.length - 4, crc32mpeg2(b.subarray(0, b.length - 4)));
  if (parseAmpBatch(b).records.some((rec) => rec.crc !== 0 || rec.crcAfter !== 0)) throw new Error('corruptRecordCrcs is wrong');
  return b;
}


// selftest.html
const button = document.querySelector('#run');
if (button) {
  const out = document.querySelector('#log');
  const write = (line) => {
    out.textContent += `${line}\n`;
    out.scrollTop = out.scrollHeight;
  };
  window.runSelfTest = () => runSelfTest({ onLog: write });
  if (!navigator.bluetooth) {
    button.disabled = true;
    write('This browser cannot use Bluetooth. Use Chrome or Edge.');
  }
  let running = false;
  window.addEventListener('beforeunload', (e) => {
    if (!running) return;
    e.preventDefault();
    e.returnValue = '';
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    running = true;
    out.textContent = '';
    const result = await runSelfTest({ onLog: write }).catch((e) => ({ ok: false, error: e?.stack ?? String(e) }));
    running = false;
    write(`\n${result.ok ? 'PASSED' : 'FAILED'}\n${JSON.stringify(result, null, 2)}`);
    if (result.restored === false) {
      write('\nThe amp could not be put back exactly; see the failed checks. Do not run the test again: its first snapshot would take the changed amp for the original.');
      return;
    }
    button.disabled = false;
  });
}
