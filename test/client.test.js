import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReactorClient, TimeoutError } from '../src/protocol/client.js';
import { parseChunk } from '../src/protocol/framing.js';
import { Writer } from '../src/protocol/codec.js';
import { Requests, UPLOAD_PART } from '../src/protocol/messages.js';
import { buildAmpBatch, parseAmp, parsePreset, serializeAmp, serializePreset, withHeader } from '../src/protocol/preset.js';
import { MockAmp } from './mock-amp.js';
import { ampBatch17, bank17, hex, joinParts, presetFixture, toHex } from './helpers.js';

function connect(options = {}) {
  const amp = new MockAmp();
  const client = new ReactorClient(amp.transport, { timeout: 200, uploadTimeout: 200, variantSettle: 0, presetSettle: 0, ...options });
  return { amp, client };
}

const chunkOf = (write) => parseChunk(write.subarray(16));

test('reads device info and presets', async () => {
  const { amp, client } = connect();
  assert.deepEqual(await client.info(), { name: 'Reactor 50 BT Control', firmware: '0.2.5.108', firmwareRaw: 0x0002056c });
  const p = await client.preset(3);
  assert.equal(toHex(await client.presetBlob(3)), toHex(presetFixture(3)));
  assert.equal(p.slot, 3);
  assert.deepEqual(await client.currentSlot(), { type: 0, slot: 7 });
  assert.equal(toHex(await client.ampBlob(0x17, 4)), toHex(bank17()[4]));
  assert.deepEqual(amp.writes.map((w) => chunkOf(w).seq), [1, 2, 3, 4, 5, 6]);
});

test('request sequence numbers stay within 01-3F and wrap', async () => {
  const { amp, client } = connect();
  for (let i = 0; i < 70; i++) await client.currentSlot();
  const seqs = amp.writes.map((w) => chunkOf(w).seq);
  assert.equal(seqs[62], 0x3f);
  assert.equal(seqs[63], 0x01);
  assert.ok(seqs.every((s) => s >= 1 && s <= 0x3f));
});

test('amp events reach listeners; a missing reply times out without blocking later requests', async () => {
  const { amp, client } = connect();
  const events = [];
  client.on((e) => events.push(e));
  amp.event(0x37, new Writer().pstr('Amp.Preamp').int(0).float(0.5).int(0).finish());
  amp.event(0x38, hex('0004'));
  await assert.rejects(client.presetBlob(0x7f), TimeoutError);
  assert.deepEqual(await client.currentSlot(), { type: 0, slot: 7 });
  assert.deepEqual(events.map((e) => [e.type, e.seq]), [['paramChanged', 0x40], ['presetSelected', 0x41]]);
  assert.equal(events[0].value, 0.5);
});

test('a failed write fails its request and frees the queue', async () => {
  const { amp, client } = connect();
  const write = amp.transport.write;
  amp.transport.write = async () => {
    throw new Error('GATT write failed');
  };
  await assert.rejects(client.currentSlot(), /GATT write failed/);
  amp.transport.write = write;
  assert.deepEqual(await client.currentSlot(), { type: 0, slot: 7 });
  assert.equal(client.waiters.length, 0);
});

test('an upload stops when a part is not acknowledged', async () => {
  const { amp, client } = connect();
  amp.silent.add('01 01');
  await assert.rejects(client.uploadPreset(presetFixture(2), 2), TimeoutError);
  assert.equal(amp.writes.length, 1);
});

test('saving uploads the preset, the amp base and the difference message, as the app does', async () => {
  const { amp, client } = connect();
  await client.saveCurrent(7);
  const uploads = amp.writes.map(chunkOf).filter((c) => c.cmd === 0x01);
  const messages = [...new Set(uploads.map((c) => c.seq))].map((seq) => uploads.filter((c) => c.seq === seq));
  assert.deepEqual(messages.map((m) => m[0].sub), [0x01, 0xa7, 0xa7]);
  assert.equal(toHex(joinParts(messages[0])), toHex(presetFixture(7)));
  assert.equal(toHex(joinParts(messages[1])), toHex(withHeader(bank17()[0], 0x17, 0)));
  assert.equal(toHex(joinParts(messages[2])), toHex(ampBatch17()));
  assert.equal(toHex(amp.presets[7]), toHex(presetFixture(7)));
  amp.banks.get(0x17).forEach((v, i) => assert.equal(toHex(v), toHex(bank17()[i]), `variant ${i}`));
  assert.deepEqual(amp.current, { type: 0, slot: 7 }, 'saving the current slot does not reselect it');
});

test('saving into another slot stores the preset and amp there, then selects it', async () => {
  const { amp, client } = connect();
  await client.saveCurrent(2);
  assert.equal(toHex(amp.presets[2].subarray(2)), toHex(presetFixture(7).subarray(2)));
  assert.equal(amp.presets[2][1], 2);
  const bank = amp.banks.get(0x12);
  bank17().forEach((v, i) => assert.equal(toHex(bank[i].subarray(2)), toHex(v.subarray(2)), `variant ${i}`));
  assert.deepEqual(amp.current, { type: 0, slot: 2 });
});

test('saving a preset whose amp is not an Amp-selector amp keeps the variants of the bank the live amp came from', async () => {
  const { amp, client } = connect();
  const id = Uint8Array.from({ length: 16 }, (_, i) => i);
  const custom = bank17().map((v, i) => serializeAmp({ ...parseAmp(v), id, name: 'Dual Clean', bank: 0x7f, variant: i }));
  const live = withHeader(custom[3], 0x7d, 0);
  amp.banks.set(0x7f, custom);
  amp.banks.set(0x7d, [live, ...custom.slice(1).map((v, i) => withHeader(v, 0x7d, i + 1)), withHeader(live, 0x7d, 15)]);
  const p = parsePreset(presetFixture(7));
  const edited = serializePreset({ ...p, amp: { ...parseAmp(live) } }, 0x01, 0x00);
  amp.editBuffer = edited;
  await client.saveCurrent(3);
  assert.equal(toHex(amp.presets[3].subarray(2)), toHex(edited.subarray(2)));
  assert.deepEqual(amp.current, { type: 0, slot: 3 });
  const stored = amp.banks.get(0x13);
  custom.forEach((v, i) => assert.equal(toHex(stored[i].subarray(2)), toHex((i === 7 ? live : v).subarray(2)), `variant ${i}`));
});

test("a custom amp's variants are found in 7F even when 7D/1-14 differ from them", async () => {
  const { amp, client } = connect();
  const id = Uint8Array.from({ length: 16 }, (_, i) => i);
  const custom = bank17().map((v, i) => serializeAmp({ ...parseAmp(v), id, name: 'Dual Clean', bank: 0x7f, variant: i }));
  // As after selecting a stored preset: the amp can put the live knob values into 7D/1-14.
  const knobbed = custom.map((v, i) => {
    const a = parseAmp(v);
    const blocks = a.blocks.map((b, bi) => (bi === 0 ? { ...b, params: [b.params[0] ^ 1, ...b.params.slice(1)] } : b));
    return serializeAmp({ ...a, blocks }, 0x7d, i);
  });
  const live = knobbed[7];
  amp.banks.set(0x7f, custom);
  amp.banks.set(0x7d, [withHeader(live, 0x7d, 0), ...knobbed.slice(1), withHeader(live, 0x7d, 15)]);
  amp.editBuffer = serializePreset({ ...parsePreset(presetFixture(7)), amp: { ...parseAmp(live) } }, 0x01, 0x00);
  await client.saveCurrent(7);
  const stored = amp.banks.get(0x17);
  custom.forEach((v, i) => assert.equal(toHex(stored[i].subarray(2)), toHex((i === 7 ? live : v).subarray(2)), `variant ${i}`));
});

test('a library amp loaded under another name keeps the variants of the working bank', async () => {
  const { amp, client } = connect();
  // As when the app loads an Amp-selector amp under another name: same meta id, different name.
  const renamed = bank17().map((v, i) => serializeAmp({ ...parseAmp(v), name: 'Halo Renamed', bank: 0x7f, variant: i }));
  const live = withHeader(renamed[7], 0x7d, 0);
  amp.banks.set(0x7f, renamed);
  amp.banks.set(0x7d, [live, ...renamed.slice(1).map((v, i) => withHeader(v, 0x7d, i + 1)), withHeader(live, 0x7d, 15)]);
  amp.editBuffer = serializePreset({ ...parsePreset(presetFixture(7)), amp: { ...parseAmp(live) } }, 0x01, 0x00);
  await client.saveCurrent(3);
  const stored = amp.banks.get(0x13);
  renamed.forEach((v, i) => assert.equal(toHex(stored[i].subarray(2)), toHex((i === 7 ? live : v).subarray(2)), `variant ${i}`));
});

test('requests the library does not build, and out-of-range writes, are refused before anything is sent', async () => {
  const { amp, client } = connect();
  const none = new Uint8Array(0);
  await assert.rejects(client.send({ cmd: 0x05, sub: 0x10, payload: none }), /not a request this library builds/);
  await assert.rejects(client.send({ cmd: 0x01, sub: 0x7e, payload: none }), /not a request this library builds/);
  // Values that are not bytes would otherwise be cut to one: 0x165 to 65.
  await assert.rejects(client.send({ cmd: 0x01, sub: 0x165, payload: none }), /not a byte/);
  await assert.rejects(client.send({ cmd: 0x01, sub: '101', payload: none }), /not a byte/);
  await assert.rejects(client.send({ cmd: 0x01, sub: 101.5, payload: none }), /not a byte/);
  // Uploads are checked where they go, also when built by hand.
  await assert.rejects(client.send(Requests.uploadAmp(withHeader(bank17()[0], 0x05, 0))), /refusing to write amp bank 05/);
  await assert.rejects(client.send(Requests.uploadAmp(buildAmpBatch(0x02, bank17()))), /refusing to write amp bank 02/);
  await assert.rejects(client.send(Requests.uploadPreset(withHeader(presetFixture(2), 0x00, 0x20))), /refusing to upload a preset/);
  await assert.rejects(client.send(Requests.uploadPreset(new Uint8Array(9000))), /refusing an upload of 9000 bytes/);
  assert.throws(() => client.setParam('Amp.Preamp', 0, 1.5), RangeError);
  assert.throws(() => client.setParam('Amp.Preamp', 0, NaN), RangeError);
  await assert.rejects(client.uploadAmpBank(0x05, bank17()), /refusing to write amp bank 5/);
  await assert.rejects(client.uploadAmpBank({ valueOf: () => 0x17 }, bank17()), /refusing to write amp bank/);
  const corrupt = presetFixture(2).slice();
  corrupt[40] ^= 1;
  assert.throws(() => client.uploadPreset(corrupt, 2), /fails its checksum/);
  assert.equal(amp.writes.length, 0);
});

test('a request is sent exactly as it was checked, even if the caller changes it while it is being sent', async () => {
  const { amp, client } = connect();
  const request = Requests.uploadPreset(withHeader(presetFixture(3), 0x00, 3));
  const original = request.payload.slice();
  const sending = client.send(request);
  while (amp.writes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  Object.assign(request, { cmd: 0x05, sub: 0x7e });
  request.payload.fill(0);
  await sending;
  assert.ok(amp.writes.map(chunkOf).every((c) => c.cmd === 0x01 && c.sub === 0x01));
  assert.equal(toHex(amp.presets[3]), toHex(original));
});

test('a save the amp did not store exactly is reported', async () => {
  const { amp, client } = connect();
  const store = amp.store.bind(amp);
  amp.store = (sub, payload) => {
    store(sub, payload);
    if (sub === 0xa7 && payload[0] === 0x03) amp.banks.get(payload[1])[3] = withHeader(bank17()[0], payload[1], 3);
  };
  await assert.rejects(client.saveCurrent(2), /does not hold what was written \(amp variant 3\)/);
});

test('a backup of a slot can be written back after a save', async () => {
  const { amp, client } = connect();
  const backup = await client.backupSlot(7);
  await client.saveCurrent(7, { name: 'Overwritten' });
  assert.equal(parsePreset(amp.presets[7]).name, 'Overwritten');
  await client.writeSlot(7, backup.blob, backup.ampVariants);
  assert.equal(toHex(amp.presets[7]), toHex(presetFixture(7)));
  amp.banks.get(0x17).forEach((v, i) => assert.equal(toHex(v), toHex(bank17()[i]), `variant ${i}`));
});

test('loading a temporary preset sends what the app sends, in order', async () => {
  const { amp, client } = connect();
  const preset = presetFixture(3);
  const variants = bank17();
  await client.loadTemporary(preset, variants);
  const sent = amp.writes.map(chunkOf);
  const parts = (bytes) => Math.ceil(bytes.length / UPLOAD_PART);
  const [presetParts, baseParts, batchParts] = [parts(preset), parts(variants[0]), parts(buildAmpBatch(0x7f, variants))];
  assert.deepEqual(sent.map((c) => [c.cmd, c.sub]), [
    ...Array(presetParts).fill([1, 0x01]), [1, 0x38], ...Array(baseParts).fill([1, 0xa7]), ...Array(batchParts).fill([1, 0xa7]),
  ]);
  // First part of each upload: <count> <index> <len> <len>, then the data's own header.
  assert.equal(toHex(sent[0].payload.subarray(4, 6)), '007f');
  assert.equal(toHex(sent[presetParts].payload), '007f');
  assert.equal(toHex(sent[presetParts + 1].payload.subarray(4, 6)), '7f00');
  assert.equal(toHex(sent[presetParts + 1 + baseParts].payload.subarray(4, 8)), '037f0e00');
  assert.equal(amp.temp[0], 0x00);
  assert.equal(amp.temp[1], 0x7f);
  assert.equal(toHex(amp.temp.subarray(2)), toHex(preset.subarray(2)));
  assert.deepEqual(amp.current, { type: 0, slot: 0x7f });
  amp.banks.get(0x7f).forEach((v, i) => assert.equal(toHex(v.subarray(2)), toHex(variants[i].subarray(2))));
  assert.equal(parsePreset(await client.currentPresetBlob()).name, parsePreset(preset).name);
});

test('live parameter changes are coalesced per parameter', async () => {
  const { amp, client } = connect({ paramInterval: 20 });
  for (let i = 0; i <= 10; i++) client.setParamLive('Amp.Preamp', 0, i / 10);
  client.setParamLive('Delay', 1, 0.25);
  await client.setParamLive('Amp.Preamp', 0, 0.75);
  assert.deepEqual(amp.params, [['Amp.Preamp', 0, 0.75], ['Delay', 1, 0.25]]);
});

test('changing the amp variant sends the variant, then the five knobs', async () => {
  const { amp, client } = connect();
  await client.setAmpVariant(12, [0.5, 0.25, 0.5, 0.75, 1]);
  await client.currentSlot();
  assert.deepEqual(amp.params, [
    ['ReactorAmp', 0, Math.fround(12 / 14)],
    ['Amp.Preamp', 0, 0.5],
    ['Amp.Tonestack', 1, 0.25],
    ['Amp.Tonestack', 2, 0.5],
    ['Amp.Tonestack', 3, 0.75],
    ['Amp.Poweramp', 0, 1],
  ]);
});
