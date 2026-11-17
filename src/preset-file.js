// Preset files: a preset plus the 15 variants of its amp, as JSON. Loading one into the amp's temporary slot sounds
// exactly like the preset it was exported from.

import { BLOCK_CODES, MODEL_BY_DSP, REACTOR_AMP } from './protocol/models.js';
import { buildAmpBatch, parseAmp, parsePreset, VARIANTS } from './protocol/preset.js';

export const FORMAT = 'knobwork-preset';
export const VERSION = 1;
const OLD_FORMAT = 'reactor-preset'; // files exported before the format was renamed
const MAX_BYTES = 8192; // a preset is about 1.3 KB and an amp's data about 1 KB

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function fromHex(s, what) {
  if (typeof s !== 'string' || s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error(`${what} is not hex`);
  if (s.length > 2 * MAX_BYTES) throw new Error(`${what} is too long`);
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

// Every block must be one REACTOR uses, and an effect must have its model's number of parameters.
function checkBlocks(blocks, what) {
  if (blocks.length < 1 || blocks.length > 16) throw new Error(`${what} has ${blocks.length} blocks`);
  for (const b of blocks) {
    const dsp = BLOCK_CODES[b.code];
    if (!dsp) throw new Error(`${what} has an unknown block ${b.code.toString(16).padStart(4, '0')}`);
    const expected = dsp === REACTOR_AMP ? 1 : MODEL_BY_DSP[dsp]?.params.length;
    if (expected !== undefined && b.params.length !== expected) {
      throw new Error(`${what}: ${dsp} has ${b.params.length} parameters instead of ${expected}`);
    }
  }
}

export function toPresetFile(presetBlob, ampVariants) {
  const preset = parsePreset(presetBlob);
  return {
    format: FORMAT,
    version: VERSION,
    name: preset.name,
    amp: preset.amp.name,
    preset: toHex(presetBlob),
    ampVariants: ampVariants.map(toHex),
  };
}

// Validates a parsed preset file and returns { name, preset, ampVariants } with the data as bytes.
export function fromPresetFile(file) {
  if (file?.format !== FORMAT && file?.format !== OLD_FORMAT) throw new Error('not a Knobwork preset file');
  if (file.version !== VERSION) throw new Error(`unsupported preset file version ${file.version}`);
  const preset = fromHex(file.preset, 'preset');
  const p = parsePreset(preset);
  if (!p.checksumOk) throw new Error('the preset failed its checksum');
  checkBlocks(p.blocks, 'the preset');
  checkBlocks(p.amp.blocks, "the preset's amp");
  if (!Array.isArray(file.ampVariants) || file.ampVariants.length !== VARIANTS) throw new Error(`expected ${VARIANTS} amp variants`);
  const ampVariants = file.ampVariants.map((h, i) => fromHex(h, `amp variant ${i}`));
  ampVariants.forEach((blob, i) => {
    const a = parseAmp(blob);
    if (!a.checksumOk) throw new Error(`amp variant ${i} failed its checksum`);
    if (a.variant !== i) throw new Error(`amp variant ${i} is labelled ${a.variant}`);
    checkBlocks(a.blocks, `amp variant ${i}`);
  });
  buildAmpBatch(0x7f, ampVariants); // throws unless variants 1-14 differ from variant 0 only in parameter values
  return { name: p.name, preset, ampVariants };
}
