// Writes the made-up presets and amp data the tests use: presets/, amp-bank-17/ and amp-batch-17.hex. Nothing in them
// comes from a real amp. The values come from a seeded random generator; only the layout is real (docs/protocol.md,
// sections 6-8). The files are frozen on purpose: the tests compare the library with these bytes, so a change that
// breaks reading and writing in the same way still fails. They were made while the library reproduced real amp data
// byte for byte. Run this again only when the format itself changes:
//
//   node test/fixtures/make-fixtures.js

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { floatToHalf } from '../../src/protocol/half.js';
import { AMPS, CATEGORIES, MODELS } from '../../src/protocol/models.js';
import { VARIANTS, buildAmpBatch, serializeAmp, serializePreset } from '../../src/protocol/preset.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const BANK = 0x17; // slot 7's amp bank
const VARIANT = 7; // the amp variant every preset selects: centre Character, Heat 0
const REACTOR_AMP = 0x040d;

// mulberry32, so every run writes the same bytes.
let seed = 0x4b4e4f42;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
}

function param() {
  const r = random();
  return floatToHalf(r < 0.1 ? 0 : r > 0.9 ? 1 : Math.round(random() * 1000) / 1000);
}

// The amp borrows the meta id and name of Amp-selector amp 05, so the client treats it as that amp. Its blocks and
// their parameter counts follow the amp's layout; the values are made up.
const AMP_META = {
  id: Uint8Array.from(Buffer.from(AMPS[5].id, 'hex')),
  name: AMPS[5].name,
  version: '0.1',
  description: '',
  icon: 'made-up-amp.png',
  gainStage: 4,
  tags: ['made-up', 'test'],
};
const AMP_BLOCKS = [[0x0502, 145], [0x0503, 4], [0x0505, 110], [0x0506, 11], [0x0434, 30], [0x0435, 30]];
const HEAT = [3, 20, 77]; // Amp.Preamp parameters that change with Heat
const CHARACTER = [9, 52]; // Amp.Poweramp parameters that change with Character
const KNOBS = [[0, 0, 0.62], [1, 1, 0.35], [1, 3, 0.8]]; // [block, parameter, value]: knob settings saved with the slot

const base = AMP_BLOCKS.map(([code, n]) => ({ code, active: true, params: Array.from({ length: n }, param) }));

// Variant k = 5 x row (Character) + column (Heat). The variant a slot selects also holds the slot's knob settings.
function ampBlocks(k) {
  const [row, column] = [Math.floor(k / 5), k % 5];
  const blocks = base.map((b) => ({ ...b, params: b.params.slice() }));
  if (column) for (const i of HEAT) blocks[0].params[i] = floatToHalf(1 + column / 8);
  if (row) for (const i of CHARACTER) blocks[2].params[i] = floatToHalf(1 + row / 4);
  if (k === VARIANT) for (const [b, i, value] of KNOBS) blocks[b].params[i] = floatToHalf(value);
  return blocks;
}

const variants = Array.from({ length: VARIANTS }, (_, k) => serializeAmp({ ...AMP_META, blocks: ampBlocks(k) }, BANK, k));

// One block per category: the gate first, the FX loop last, the rest in a random order. Across the 8 slots every
// model appears at least once.
function preset(slot) {
  const middle = CATEGORIES.filter((c) => c !== 'Gate' && c !== 'FX Loop');
  for (let i = middle.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [middle[i], middle[j]] = [middle[j], middle[i]];
  }
  const blocks = ['Gate', ...middle, 'FX Loop'].map((category) => {
    if (category === 'Amp') return { code: REACTOR_AMP, active: true, params: [floatToHalf(VARIANT)] };
    const models = MODELS.filter((m) => m.category === category);
    const model = models[slot % models.length];
    return { code: model.code, active: random() < 0.5, params: Array.from({ length: model.params.length }, param) };
  });
  return serializePreset({
    type: 0x00,
    slot,
    id: Uint8Array.from({ length: 16 }, () => Math.floor(random() * 256)),
    name: `Made-up Preset ${slot + 1}`,
    version: '1.0',
    description: slot === 7 ? 'A made-up preset, with a description longer than 31 bytes' : '',
    icon: `made-up-preset-${slot + 1}.png`,
    gainStage: (slot % 4) + 1,
    tags: ['made-up', 'test', `slot ${slot + 1}`],
    bpm: 80 + 10 * slot,
    amp: { ...AMP_META, blocks: ampBlocks(VARIANT) },
    blocks,
  });
}

const hex = (bytes) => `${Buffer.from(bytes).toString('hex')}\n`;
for (const dir of ['presets', 'amp-bank-17']) {
  rmSync(join(DIR, dir), { recursive: true, force: true });
  mkdirSync(join(DIR, dir));
}
for (let slot = 0; slot < 8; slot++) writeFileSync(join(DIR, 'presets', `slot-${slot}.hex`), hex(preset(slot)));
variants.forEach((blob, k) => writeFileSync(join(DIR, 'amp-bank-17', `variant-${String(k).padStart(2, '0')}.hex`), hex(blob)));
writeFileSync(join(DIR, 'amp-batch-17.hex'), hex(buildAmpBatch(BANK, variants)));
