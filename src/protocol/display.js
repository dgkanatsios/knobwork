// How parameter values are shown (docs/protocol.md, section 11.2). Values on the wire are always 0..1.

import { MODEL_BY_DSP } from './models.js';

// Index of the value nearest to v.
function nearest(values, v) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - v) < Math.abs(values[best] - v)) best = i;
  return best;
}

const stepValues = (steps) => steps.map(([value]) => value);

function scaled(min, max, unit, v) {
  const x = min + v * (max - min);
  const text = Math.abs(max - min) >= 100 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toFixed(1);
  return unit ? `${text} ${unit}` : text;
}

// values: all parameter values (0..1) of the block, needed where one parameter's meaning depends on another.
export function bpmOn(model, values) {
  const i = model.params.findIndex((x) => x.label === 'BPM' || x.label === 'BPM Sync');
  return i >= 0 ? values[i] >= 0.5 : false;
}

export function formatParam(dspId, index, values) {
  const model = MODEL_BY_DSP[dspId];
  const v = values[index];
  const p = model?.params[index];
  switch (p?.kind) {
    case 'scale':
      return scaled(p.min, p.max, p.unit, v);
    case 'switch':
      return v >= 0.5 ? p.on : p.off;
    case 'steps':
      return p.steps[nearest(stepValues(p.steps), v)][1];
    case 'time': {
      if (bpmOn(model, values)) return p.sync[nearest(stepValues(p.sync), v)][1];
      if (p.modes) {
        const modeIndex = model.params.findIndex((x) => x.label === 'Mode');
        const m = p.modes[nearest(stepValues(model.params[modeIndex].steps), values[modeIndex])];
        return scaled(m.min, m.max, m.unit, v);
      }
      return scaled(p.min, p.max, p.unit, v);
    }
    default:
      return v.toFixed(3);
  }
}

// Choices for a parameter shown as a list (switches, steps, BPM-synced times); null for continuous parameters.
export function paramChoices(dspId, index, values) {
  const model = MODEL_BY_DSP[dspId];
  const p = model?.params[index];
  if (p?.kind === 'switch') return [{ value: 1, label: p.on }, { value: 0, label: p.off }];
  if (p?.kind === 'steps') return p.steps.map(([value, label]) => ({ value, label }));
  if (p?.kind === 'time' && bpmOn(model, values)) return p.sync.map(([value, label]) => ({ value, label }));
  return null;
}
