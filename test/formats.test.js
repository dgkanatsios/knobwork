import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32record, crc32mpeg2 } from '../src/protocol/crc.js';
import { floatToHalf, halfToFloat } from '../src/protocol/half.js';
import { AMPS, BLOCK_CODES, MODEL_BY_DSP } from '../src/protocol/models.js';
import { applyAmpRecord, buildAmpBatch, parseAmp, parseAmpBatch, parsePreset, serializeAmp, serializePreset } from '../src/protocol/preset.js';
import { fromPresetFile, toPresetFile } from '../src/preset-file.js';
import { ampBatch17, bank17, presetFixture, toHex } from './helpers.js';

test('presets parse and serialize back to the same bytes', () => {
  for (let s = 0; s < 8; s++) {
    const blob = presetFixture(s);
    const p = parsePreset(blob);
    assert.ok(p.checksumOk, `slot ${s} checksum`);
    assert.equal(p.slot, s);
    assert.equal(p.blocks.length, 10);
    for (const b of p.blocks) assert.ok(BLOCK_CODES[b.code], `unknown block ${b.code.toString(16)}`);
    for (const b of p.blocks) {
      const model = MODEL_BY_DSP[BLOCK_CODES[b.code]];
      if (model) assert.equal(b.params.length, model.params.length, `${model.dspId} parameter count`);
    }
    assert.equal(toHex(serializePreset(p)), toHex(blob));
  }
});

test('amp data parses and serializes back to the same bytes', () => {
  for (const blob of bank17()) {
    const a = parseAmp(blob);
    assert.ok(a.checksumOk);
    assert.equal(a.name, AMPS[5].name);
    assert.deepEqual(a.blocks.map((b) => BLOCK_CODES[b.code]), ['Amp.Preamp', 'Amp.Tonestack', 'Amp.Poweramp', 'Amp.Transformer', 'CabCompensator', 'ReactorCabSim']);
    assert.equal(toHex(serializeAmp(a)), toHex(blob));
  }
});

test('the difference message built from a bank is byte for byte the expected one', () => {
  assert.equal(toHex(buildAmpBatch(0x17, bank17())), toHex(ampBatch17()));
});

test('a variant that differs from variant 0 in more than its parameters is refused', () => {
  const variants = bank17();
  variants[7] = serializeAmp({ ...parseAmp(variants[7]), name: 'Other Amp' });
  assert.throws(() => buildAmpBatch(0x17, variants), /variant 7 differs from variant 0/);
});

test('applying each difference record to the base rebuilds every variant', () => {
  const variants = bank17();
  const batch = parseAmpBatch(ampBatch17());
  assert.ok(batch.checksumOk);
  assert.equal(batch.bank, 0x17);
  assert.equal(batch.records.length, 14);
  for (const rec of batch.records) {
    assert.equal(rec.crc, rec.crcAfter);
    assert.equal(rec.crc, crc32record(variants[rec.variant].subarray(2, -4)));
    assert.equal(toHex(applyAmpRecord(variants[0], rec)), toHex(variants[rec.variant]));
  }
});

test('half floats round-trip and round ties away from zero', () => {
  assert.equal(floatToHalf(21000), 0x7521);
  assert.equal(floatToHalf(-21000), 0xf521);
  assert.equal(halfToFloat(0x4700), 7);
  assert.equal(floatToHalf(7), 0x4700);
  assert.equal(floatToHalf(0), 0);
  // Just below the midpoint between 0 and the smallest half: rounds down, in both signs.
  assert.equal(floatToHalf(2 ** -25 - 2 ** -78), 0);
  assert.equal(floatToHalf(-(2 ** -25 - 2 ** -78)), 0x8000);
  for (let bits = 0; bits <= 0xffff; bits++) {
    if ((bits & 0x7c00) === 0x7c00) continue; // infinities and NaNs
    assert.equal(floatToHalf(halfToFloat(bits)), bits, `0x${bits.toString(16)}`);
  }
});

test('CRC routines match their reference values', () => {
  const data = new TextEncoder().encode('123456789');
  assert.equal(crc32mpeg2(data), 0x0376e6e7);
  assert.equal(crc32record(data), 0xcbf43926);
});

test('preset files are checked before anything from them is sent to the amp', () => {
  const file = toPresetFile(presetFixture(7), bank17());
  assert.equal(fromPresetFile(file).name, parsePreset(presetFixture(7)).name);
  assert.equal(fromPresetFile({ ...file, format: 'reactor-preset' }).name, file.name, 'files saved under the old format name');
  const editBlocks = (edit) => {
    const p = parsePreset(presetFixture(7));
    edit(p.blocks);
    return toPresetFile(serializePreset(p), bank17());
  };
  assert.throws(() => fromPresetFile(editBlocks((b) => (b[0].code = 0x7777))), /unknown block 7777/);
  assert.throws(() => fromPresetFile(editBlocks((b) => b.find((x) => x.code === 0x0309).params.push(0))), /parameters instead of/);
  assert.throws(() => fromPresetFile({ ...file, preset: '00'.repeat(9000) }), /too long/);
});
