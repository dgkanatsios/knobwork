// Pictures of the amp and the effect pedals, drawn here so the app needs no image files. They are generic on purpose:
// effects are coloured by category and amps by Amp-selector position, and none is made to look like a real product
// (AGENTS.md). Their knobs, sliders and switches show the values of the parameters they stand for.

const NS = 'http://www.w3.org/2000/svg';

const CATEGORY_COLOURS = {
  Gate: '#7d8794',
  Comp: '#d6a536',
  Drive: '#d9483b',
  Mod: '#8f5fd8',
  Delay: '#2ba39a',
  Reverb: '#4a78d8',
  EQ: '#b9c0c8',
  Wah: '#c07a3c',
  'FX Loop': '#5a6470',
};
const OTHER = '#6b7280';
// Amp-selector positions 00-05 (Clean to Extreme); other amps are OTHER_AMP.
const AMP_COLOURS = ['#3d7ea6', '#3f9a8a', '#7f9a3f', '#c08a2e', '#c4562f', '#a83a5e'];
const OTHER_AMP = '#6c6f8a';

const clamp = (v) => (v > 0 ? Math.min(v, 1) : 0);

function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children.flat(Infinity));
  return node;
}

const rect = (x, y, width, height, rx, fill, more = {}) => s('rect', { x, y, width, height, rx, fill, ...more });
const circle = (cx, cy, r, fill, more = {}) => s('circle', { cx, cy, r, fill, ...more });
const line = (x1, y1, x2, y2, stroke, more = {}) => s('line', {
  x1, y1, x2, y2, stroke, 'stroke-linecap': 'round', ...more,
});
// A thin light line along the inside of a box's edge.
const edge = (x, y, width, height, rx, opacity) => rect(x + 0.5, y + 0.5, width - 1, height - 1, rx - 0.5, 'none', {
  stroke: '#fff', 'stroke-opacity': opacity,
});

function svg(width, height, className, parts) {
  const attrs = { viewBox: `0 0 ${width} ${height}`, width, height, class: className };
  return s('svg', { ...attrs, 'aria-hidden': 'true', focusable: 'false' }, parts);
}

// A part that shows a parameter: set(value) draws it, and updateArt in app.js calls it again when the value changes.
function live(node, key, set, value) {
  set(value);
  if (key) {
    node.setAttribute('data-art-param', key);
    node.setValue = set;
  }
  return node;
}

function knob(x, y, r, { key, value }, light = false) {
  const [face, mark, rim] = light ? ['#dfe2e6', '#1b1d21', '#000'] : ['#1b1d21', '#f4f5f6', '#fff'];
  const pointer = line(x, y - r * 0.2, x, y - r + 1.6, mark, { 'stroke-width': r > 7 ? 2 : 1.6 });
  const cap = circle(x, y, r, face, { stroke: rim, 'stroke-opacity': light ? 0.4 : 0.22 });
  const turn = (v) => pointer.setAttribute('transform', `rotate(${-135 + 270 * clamp(v)} ${x} ${y})`);
  return live(s('g', {}, cap, pointer), key, turn, value);
}

function toggle(x, y, { value }) {
  const lever = circle(x, value >= 0.5 ? y - 3.2 : y + 3.2, 2.5, '#e2e5e9');
  return s('g', {}, rect(x - 3, y - 6.5, 6, 13, 3, '#16181b'), lever);
}

function lamp(x, y, r, on) {
  if (!on) return [circle(x, y, r, '#3a1d1a', { stroke: '#000', 'stroke-opacity': 0.3 })];
  return [circle(x, y, r * 2.3, '#ff3b2f', { 'fill-opacity': 0.45 }), circle(x, y, r, '#ffe2dc')];
}

function footswitch(x, y) {
  return [circle(x, y, 10, '#2a2d31'), circle(x, y, 8, '#b9bec5'), circle(x, y, 5, '#e3e6e9')];
}

function enclosure(colour) {
  return [
    rect(4, 2, 72, 116, 9, colour),
    s('path', { d: 'M4 84H76V109A9 9 0 0 1 67 118H13A9 9 0 0 1 4 109Z', fill: '#000', 'fill-opacity': 0.16 }),
    edge(4, 2, 72, 116, 9, 0.2),
  ];
}

// Knobs in one or two rows, switches in a row below them.
function stompbox(colour, controls, active, extras = []) {
  const knobs = controls.filter((c) => c.kind !== 'switch');
  const switches = controls.filter((c) => c.kind === 'switch');
  const n = knobs.length;
  const rows = n <= 3 ? [n] : n === 4 ? [2, 2] : n <= 6 ? [3, n - 3] : [4, n - 4];
  const r = rows[0] === 4 ? 6.5 : 8;
  const step = rows[0] === 4 ? 16 : rows[0] === 3 ? 21 : 26;
  const ys = switches.length ? (rows.length === 1 ? [38] : [30, 52]) : (rows.length === 1 ? [44] : [32, 56]);
  const parts = [...enclosure(colour), ...extras, ...lamp(40, 12, 2.8, active)];
  let next = 0;
  rows.forEach((count, row) => {
    for (let i = 0; i < count; i++) {
      parts.push(knob(40 + (i - (count - 1) / 2) * step, ys[row], r, knobs[next++]));
    }
  });
  switches.forEach((c, i) => parts.push(toggle(40 + (i - (switches.length - 1) / 2) * 14, 72, c)));
  parts.push(...footswitch(40, 100));
  return svg(80, 120, 'pedal-art', parts);
}

function graphicEq(controls, active) {
  const parts = [...enclosure(CATEGORY_COLOURS.EQ), ...lamp(40, 12, 2.8, active)];
  const step = 64 / Math.max(controls.length, 1);
  controls.forEach((c, i) => {
    const x = 8 + step * (i + 0.5);
    const cap = rect(x - 3.2, -2.2, 6.4, 4.4, 1, '#1b1d21');
    parts.push(line(x, 24, x, 74, '#2a2d31', { 'stroke-width': 2 }));
    const slide = (v) => cap.setAttribute('transform', `translate(0 ${72 - 46 * clamp(v)})`);
    parts.push(live(cap, c.key, slide, c.value));
  });
  parts.push(...footswitch(40, 100));
  return svg(80, 120, 'pedal-art', parts);
}

function wah(active) {
  const parts = [
    rect(6, 2, 68, 116, 10, CATEGORY_COLOURS.Wah), edge(6, 2, 68, 116, 10, 0.2), ...lamp(40, 9, 2.8, active),
    rect(11, 17, 58, 97, 8, '#3a3e44'),
  ];
  for (let y = 25; y <= 106; y += 6) parts.push(line(17, y, 63, y, '#000', { 'stroke-opacity': 0.4, 'stroke-width': 2 }));
  return svg(80, 120, 'pedal-art', parts);
}

// An effect block. controls: the parameters shown for it, in order: { key, kind: 'knob' | 'switch', value 0..1 }.
export function pedalArt(category, controls, active) {
  if (category === 'Wah') return wah(active);
  if (category === 'EQ') return graphicEq(controls, active);
  const jacks = category === 'FX Loop' ? [20, 60].map((x) => rect(x - 5, 0, 10, 5, 1.5, '#9aa0a7')) : [];
  return stompbox(CATEGORY_COLOURS[category] ?? OTHER, controls, active, jacks);
}

// The amp: position = its Amp-selector position (0-5), or null for another amp. knobs: the five front-panel knobs,
// { key, value 0..1 }.
export function ampArt(position, knobs) {
  const colour = AMP_COLOURS[position] ?? OTHER_AMP;
  const parts = [
    rect(78, 1, 44, 10, 5, '#16181b'),
    rect(4, 7, 192, 99, 10, colour),
    edge(4, 7, 192, 99, 10, 0.18),
    rect(14, 16, 172, 30, 4, '#17191c'),
    ...lamp(28, 31, 3, true),
    rect(14, 54, 172, 43, 4, '#1d1f23'),
  ];
  for (let y = 58; y < 95; y += 4) {
    parts.push(line(18, y, 182, y, colour, { 'stroke-opacity': 0.3, 'stroke-linecap': 'butt' }));
  }
  knobs.forEach((c, i) => parts.push(knob(52 + 30 * i, 31, 9, c, true)));
  return svg(200, 110, 'amp-art', parts);
}
