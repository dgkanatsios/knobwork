import {
  AMP_KNOBS, AMPS, BLOCK_CODES, CATEGORIES, MODEL_BY_DSP, REACTOR_AMP, ReactorClient, Requests, TUNER_NOTES,
  floatToHalf, formatParam, halfToFloat, libraryAmp, modelsIn, paramChoices, parsePreset,
} from '../src/protocol/index.js';
import { WebBluetoothTransport } from '../src/transport/web-bluetooth.js';
import { fromPresetFile, toPresetFile } from '../src/preset-file.js';
import { ampArt, pedalArt } from './art.js';

const $ = (selector) => document.querySelector(selector);

const EXP_MODES = ['Auto', 'Wah only', 'Volume only'];
const CHARACTER = ['Smooth', 'Normal', 'Push'];
const HEAT = ['−2', '−1', '0', '+1', '+2'];
const ISSUES = 'https://github.com/dgkanatsios/knobwork/issues';

const state = {
  client: null,
  transport: null,
  connecting: false,
  info: null,
  slotNames: Array(8).fill(''),
  stored: Array(8).fill(null), // the stored presets, parsed; "edited" compares the current preset with these
  current: null, // { type, slot }; after a temporary load the amp reports the previous slot, edited
  edited: false,
  preset: null, // parsed current preset; parameters as half-float bits
  selectedCategory: null,
  tuner: { on: false, note: null, deviation: -1 },
  settings: null,
  plugged: null,
  dragging: null,
  paramFlush: null,
  lastBackup: null, // what the slot written by the last save held before: { slot, name, blob, ampVariants }
  busy: 0,
};

// ---------- DOM helpers

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  if (value !== undefined) node.value = String(value);
  return node;
}

function toast(message, kind = 'info') {
  const t = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 4000);
}

function setStatus(text) {
  $('#status').textContent = text;
}

async function run(label, action) {
  state.busy++;
  setStatus(`${label}…`);
  document.body.classList.add('busy');
  try {
    return await action();
  } catch (e) {
    console.error(e);
    toast(`${label} failed: ${e.message}`, 'error');
    return undefined;
  } finally {
    state.busy--;
    if (!state.busy) {
      setStatus('');
      document.body.classList.remove('busy');
    }
  }
}

const nearest = (values, v) => values.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(values[best] - v) ? i : best), 0);
const dspOf = (block) => BLOCK_CODES[block.code];
const isAmpBlock = (block) => dspOf(block) === REACTOR_AMP;

// ---------- connection

async function connect() {
  if (state.client || state.connecting) return;
  state.connecting = true;
  $('#connect').disabled = true;
  const ok = await run('Connecting', async () => {
    let transport;
    try {
      transport = await WebBluetoothTransport.request();
    } catch (e) {
      if (e.name === 'NotFoundError' && /cancel/i.test(e.message)) return false;
      if (e.name === 'NotFoundError') throw new Error('no REACTOR found. Is it on, and disconnected from the phone app?');
      throw e;
    }
    const client = new ReactorClient(transport, { log: (...args) => console.debug('[reactor]', ...args) });
    transport.onDisconnect = () => onDisconnected(transport);
    client.on(onEvent);
    Object.assign(state, { transport, client });
    state.info = await client.info();
    setStatus('Reading presets…');
    for (let s = 0; s < 8; s++) {
      state.stored[s] = await client.preset(s);
      state.slotNames[s] = state.stored[s].name;
    }
    state.settings = await readSettings();
    state.plugged = (await client.send(Requests.inputState()))?.plugged ?? null;
    await reloadCurrent();
    return true;
  });
  state.connecting = false;
  if (!ok && state.transport) await disconnect();
  render();
}

function forgetConnection() {
  clearTimeout(reloadTimer);
  Object.assign(state, { transport: null, client: null, preset: null, current: null, info: null, dragging: null, paramFlush: null });
}

async function disconnect() {
  const { transport, client } = state;
  const tunerOn = state.tuner.on;
  forgetConnection();
  // Do not leave the amp in tuner mode.
  if (client && tunerOn) await client.send(Requests.setTuner(false)).catch(() => {});
  client?.failAll();
  await transport?.close();
  render();
}

function onDisconnected(transport) {
  if (!state.client || transport !== state.transport) return;
  state.client.failAll();
  forgetConnection();
  render();
  toast('The amp disconnected.', 'error');
}

async function readSettings() {
  const c = state.client;
  const [impedance] = await c.send(Requests.impedance());
  return { hiz: impedance?.mode === 1, lineOutMute: await c.send(Requests.lineOutMute()), expMode: await c.send(Requests.expMode()) };
}

async function reloadCurrent() {
  const c = state.client;
  state.current = await c.currentSlot();
  state.preset = await c.currentPreset();
  state.tuner.on = await c.send(Requests.tuner());
  updateEdited();
}

// Same sound: same tempo, amp and blocks (order, on/off, models, parameters). Names and other metadata do not count.
function sameSound(a, b) {
  const sameBlocks = (xs, ys) => xs.length === ys.length && xs.every((x, i) => x.code === ys[i].code && x.active === ys[i].active
    && x.params.length === ys[i].params.length && x.params.every((bits, j) => bits === ys[i].params[j]));
  return a.bpm === b.bpm && a.amp.id.every((x, i) => x === b.amp.id[i]) && sameBlocks(a.amp.blocks, b.amp.blocks) && sameBlocks(a.blocks, b.blocks);
}

// "Edited" means the current preset sounds different from the stored slot the amp reports (a temporary preset counts
// as an edit of that slot). The amp's own flag is not used: 02 1A lags behind preset changes, and turning a knob on
// the amp does not always send 03 1A.
function updateEdited() {
  const stored = state.current ? state.stored[state.current.slot] : null;
  const edited = Boolean(state.preset && (!stored || !sameSound(state.preset, stored)));
  if (edited === state.edited) return;
  state.edited = edited;
  renderPresets();
}

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    if (!state.client) return;
    // A control that was removed or lost its pointer must not hold off reloads for ever.
    if (state.dragging && !document.querySelector(`[data-param="${CSS.escape(state.dragging)}"]`)) state.dragging = null;
    if (state.dragging || state.busy) return scheduleReload();
    await run('Refreshing', reloadCurrent);
    renderPresets();
    renderEditor();
    renderTuner();
  }, 250);
}

// ---------- amp events

function onEvent(e) {
  switch (e.type) {
    case 'paramChanged':
      applyParam(e.dsp, e.index, e.value);
      updateEdited();
      break;
    case 'effectActive': {
      const block = state.preset?.blocks.find((b) => dspOf(b) === e.dsp);
      if (block) block.active = e.active;
      rerenderBlock(e.dsp);
      updateEdited();
      break;
    }
    case 'presetState':
      // Re-read when the amp's flag disagrees with ours, e.g. after an edit that sent no other event.
      if (e.states.length && e.states[0].edited !== state.edited) scheduleReload();
      break;
    case 'presetSaved':
      refreshStored(e.slot);
      scheduleReload();
      break;
    case 'presetSelected':
    case 'ampSelected':
    case 'tap':
      scheduleReload();
      break;
    case 'tunerActive':
      state.tuner.on = e.active;
      renderTuner();
      break;
    case 'tuner':
      Object.assign(state.tuner, { note: e.note, deviation: e.deviation });
      renderTunerReading();
      break;
    case 'inputState':
      if (e.inputs.length) state.plugged = e.inputs[0].plugged;
      renderTuner();
      break;
    case 'categorySelected':
      state.selectedCategory = e.selected ? e.category : null;
      for (const card of document.querySelectorAll('.block[data-category]')) {
        card.classList.toggle('selected', Number(card.dataset.category) === state.selectedCategory);
      }
      break;
    default:
      break;
  }
}

async function refreshStored(slot) {
  if (!(slot >= 0 && slot < 8) || !state.client) return;
  const p = await run('Reading preset', () => state.client.preset(slot));
  if (p) {
    state.stored[slot] = p;
    state.slotNames[slot] = p.name;
  }
  updateEdited();
  renderPresets();
}

// A parameter changed on the amp (front-panel knob, TAP, …): update the model and the control showing it.
function applyParam(dsp, index, value) {
  const p = state.preset;
  if (!p) return;
  const block = [...p.amp.blocks, ...p.blocks].find((b) => dspOf(b) === dsp);
  if (!block || index >= block.params.length) return;
  block.params[index] = floatToHalf(value);
  const key = `${dsp}/${index}`;
  if (state.dragging === key) return;
  if (p.blocks.includes(block) && paramChoices(dsp, index, block.params.map(halfToFloat))) return rerenderBlock(dsp);
  const control = document.querySelector(`[data-param="${CSS.escape(key)}"]`);
  if (control) control.update(value);
  updateArt(key, value);
  if (MODEL_BY_DSP[dsp]?.params.some((x) => x.kind === 'time')) rerenderBlock(dsp);
}

// ---------- actions

// While a request sequence is running (e.g. the half second a preset change takes), other actions are ignored:
// an export in that window would read a mix of the old and the new preset.
async function selectSlot(slot) {
  if (state.busy) return;
  if (state.edited && !confirm('The current preset has unsaved changes. Switch presets and discard them?')) return;
  await run('Selecting preset', async () => {
    await state.client.selectPreset(slot);
    await reloadCurrent();
  });
  renderPresets();
  renderEditor();
}

function setParam(dsp, block, index, value, rerender = false) {
  block.params[index] = floatToHalf(value);
  updateEdited();
  updateArt(`${dsp}/${index}`, value);
  // Changes within one interval share a promise: report a failure once.
  const pending = state.client.setParamLive(dsp, index, value);
  if (pending !== state.paramFlush) {
    state.paramFlush = pending;
    pending.catch((e) => toast(`Setting a parameter failed: ${e.message}`, 'error'));
  }
  if (rerender) rerenderBlock(dsp);
}

async function toggleBlock(pos) {
  if (state.busy) return;
  const block = state.preset.blocks[pos];
  const on = !block.active;
  await run(on ? 'Turning on' : 'Turning off', async () => {
    await state.client.setActive(dspOf(block), on);
    block.active = on;
    updateEdited();
  });
  rerenderBlock(dspOf(block));
}

async function changeModel(pos, dsp) {
  if (state.busy) return renderEditor();
  const block = state.preset.blocks[pos];
  const from = dspOf(block);
  if (from === dsp) return;
  const category = CATEGORIES.indexOf(MODEL_BY_DSP[dsp].category);
  await run('Changing model', async () => {
    await state.client.replaceModel(from, dsp, { category, wasActive: block.active });
    // The amp does not echo the category selection the change ends with (01 B3), so mark it here.
    state.selectedCategory = category;
    await reloadCurrent();
  });
  renderPresets();
  renderEditor();
}

async function moveBlock(from, to) {
  if (state.busy) return;
  await run('Moving block', async () => {
    await state.client.swapBlocks(from, to);
    await reloadCurrent();
  });
  renderPresets();
  renderEditor();
}

async function selectAmp(bank) {
  if (state.busy) return renderEditor();
  await run('Changing amp', async () => {
    await state.client.selectAmp(bank);
    await reloadCurrent();
  });
  renderPresets();
  renderEditor();
}

function knobValues() {
  const amp = state.preset.amp;
  return AMP_KNOBS.map((k) => halfToFloat(amp.blocks.find((b) => dspOf(b) === k.dsp).params[k.index]));
}

async function setVariant(k) {
  if (state.busy) return;
  const reactorAmp = state.preset.blocks.find(isAmpBlock);
  await run('Changing amp character', async () => {
    await state.client.setAmpVariant(k, knobValues());
    reactorAmp.params[0] = floatToHalf(k);
    updateEdited();
  });
  renderEditor();
  scheduleReload();
}

async function setBpm(bpm) {
  if (state.busy) return;
  if (!(bpm >= 40 && bpm <= 250)) return toast('BPM must be between 40 and 250.', 'error');
  await run('Setting tempo', async () => {
    await state.client.setBpm(bpm);
    state.preset.bpm = Math.fround(bpm);
    updateEdited();
  });
  // The amp also switches BPM sync on for every tempo effect; reload to show it.
  scheduleReload();
}

const taps = [];
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length < 2) return;
  const interval = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  setBpm(Math.min(250, Math.max(40, Math.round(60000 / interval))));
}

async function setTuner(on) {
  if (state.busy) return renderTuner();
  await run(on ? 'Starting tuner' : 'Stopping tuner', async () => {
    await state.client.send(Requests.setTuner(on));
    state.tuner.on = on;
    if (!on) Object.assign(state.tuner, { note: null, deviation: -1 });
  });
  renderTuner();
}

async function changeSetting(name, value) {
  if (state.busy) return renderSettings();
  const c = state.client;
  await run('Changing setting', async () => {
    if (name === 'hiz') await c.send(Requests.setImpedance(0, value ? 1 : 0));
    if (name === 'lineOutMute') await c.send(Requests.setLineOutMute(value));
    if (name === 'expMode') await c.send(Requests.setExpMode(value));
    state.settings = await readSettings();
  });
  renderSettings();
}

// ---------- save, export, import

function openSaveDialog() {
  const dialog = $('#save-dialog');
  const nameInput = $('#save-name');
  const confirmButton = $('#save-confirm');
  const slots = $('#save-slots');
  let chosen = state.current?.slot < 8 ? state.current.slot : null;
  nameInput.value = state.preset.name;
  const refresh = () => {
    for (const b of slots.children) {
      const isChosen = Number(b.dataset.slot) === chosen;
      b.classList.toggle('chosen', isChosen);
      b.setAttribute('aria-checked', String(isChosen));
    }
    confirmButton.disabled = chosen === null || !nameInput.value.trim();
    $('#save-warning').textContent = chosen === null ? 'Choose a slot.' : `Replaces slot ${chosen + 1}: “${state.slotNames[chosen]}”.`;
  };
  slots.replaceChildren(...state.slotNames.map((name, slot) => h('button', {
    type: 'button', class: 'slot', role: 'radio', dataset: { slot }, onclick: () => { chosen = slot; refresh(); },
  }, h('span', { class: 'slot-no' }, slot + 1), h('span', { class: 'slot-name' }, name))));
  nameInput.oninput = refresh;
  $('#save-cancel').onclick = () => dialog.close('cancel');
  refresh();
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'save' || chosen === null) return;
    const slot = chosen;
    const name = nameInput.value.trim();
    const saved = await run('Saving', async () => {
      // Keep what the slot holds now, so the save can be undone; saveCurrent reads the slot back to check it.
      const backup = await state.client.backupSlot(slot);
      state.lastBackup = { ...backup, name: parsePreset(backup.blob).name };
      await state.client.saveCurrent(slot, { name });
      state.stored[slot] = await state.client.preset(slot);
      state.slotNames[slot] = state.stored[slot].name;
      await reloadCurrent();
      return true;
    });
    if (saved) toast(`Saved “${name}” to slot ${slot + 1}.`);
    renderPresets();
    renderEditor();
  };
  dialog.returnValue = '';
  dialog.showModal();
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const fileName = (name) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'preset';

async function exportPreset() {
  if (state.busy) return;
  await run('Exporting', async () => {
    const { blob, preset, ampVariants } = await state.client.currentWithAmp();
    download(`${fileName(preset.name)}.knobwork.json`, `${JSON.stringify(toPresetFile(blob, ampVariants), null, 1)}\n`);
  });
}

async function undoSave() {
  const b = state.lastBackup;
  if (!b || state.busy) return;
  const discard = state.edited && state.current?.slot === b.slot ? ' Unsaved changes to the current preset are discarded.' : '';
  if (!confirm(`Put “${b.name}” back into slot ${b.slot + 1}?${discard}`)) return;
  const done = await run('Putting the old preset back', async () => {
    await state.client.writeSlot(b.slot, b.blob, b.ampVariants);
    state.stored[b.slot] = parsePreset(b.blob);
    state.slotNames[b.slot] = b.name;
    if (state.current?.slot === b.slot) await state.client.selectPreset(b.slot);
    await reloadCurrent();
    return true;
  });
  if (done) {
    state.lastBackup = null;
    toast(`Slot ${b.slot + 1} holds “${b.name}” again.`);
  }
  renderPresets();
  renderEditor();
}

function downloadBackup() {
  const b = state.lastBackup;
  if (b) download(`${fileName(b.name)}.knobwork.json`, `${JSON.stringify(toPresetFile(b.blob, b.ampVariants), null, 1)}\n`);
}

async function importPreset(file) {
  if (state.busy) return;
  if (state.edited && !confirm('The current preset has unsaved changes. Replace them with this file?')) return;
  const loaded = await run('Importing', async () => {
    const { name, preset, ampVariants } = fromPresetFile(JSON.parse(await file.text()));
    await state.client.loadTemporary(preset, ampVariants);
    await reloadCurrent();
    return name;
  });
  if (loaded) toast(`Loaded “${loaded}”. It is not stored on the amp until you save it.`);
  renderPresets();
  renderEditor();
}

// ---------- rendering

function render() {
  const connected = Boolean(state.client);
  $('#main').classList.toggle('disconnected', !connected);
  $('#connect').textContent = connected ? 'Disconnect' : 'Connect';
  $('#connect').disabled = !navigator.bluetooth;
  $('#device').textContent = connected ? `${state.info?.name ?? ''} · firmware ${state.info?.firmware ?? ''}` : 'Not connected';
  for (const id of ['#save', '#export', '#import']) $(id).disabled = !connected;
  renderPresets();
  renderTuner();
  renderSettings();
  renderEditor();
}

function renderPresets() {
  renderUndo();
  const root = $('#banks');
  root.replaceChildren();
  if (!state.client || !state.current) return;
  for (const bank of [0, 1]) {
    root.append(h('div', { class: 'bank-label' }, `Bank ${bank + 1}`));
    for (let i = 0; i < 4; i++) {
      const slot = bank * 4 + i;
      const current = state.current.slot === slot;
      root.append(h('button', { class: `slot${current ? ' current' : ''}`, 'aria-current': current ? 'true' : null, onclick: () => selectSlot(slot) },
        h('span', { class: 'slot-no' }, slot + 1), h('span', { class: 'slot-name' }, state.slotNames[slot]),
        current && state.edited ? h('span', { class: 'badge' }, 'edited') : null));
    }
  }
}

// After a save: what the slot held before, with Undo and a download.
function renderUndo() {
  const root = $('#undo');
  const b = state.client ? state.lastBackup : null;
  root.hidden = !b;
  if (!b) return root.replaceChildren();
  root.replaceChildren(
    h('span', { class: 'hint' }, `Before the last save, slot ${b.slot + 1} held “${b.name}”.`),
    h('div', { class: 'undo-actions' },
      h('button', { onclick: undoSave }, 'Undo save'),
      h('button', { onclick: downloadBackup }, 'Download it')));
}

function renderTuner() {
  const root = $('#tuner');
  root.replaceChildren(h('h2', {}, 'Tuner'));
  if (!state.client) return;
  const on = state.tuner.on;
  root.append(
    h('div', { class: 'tuner-display' },
      h('div', { class: 'note', id: 'tuner-note', 'aria-live': 'polite' }),
      h('div', { class: 'meter' }, h('div', { class: 'zone' }), h('div', { class: 'needle', id: 'tuner-needle' }))),
    h('div', { class: 'row' },
      h('button', { class: on ? 'active' : '', onclick: () => setTuner(!on) }, on ? 'Stop tuner' : 'Start tuner'),
      h('span', { class: 'hint' }, state.plugged === null ? '' : state.plugged ? 'Guitar plugged in' : 'No guitar plugged in')),
  );
  renderTunerReading();
}

function renderTunerReading() {
  const note = $('#tuner-note');
  const needle = $('#tuner-needle');
  if (!note || !needle) return;
  const { on, deviation } = state.tuner;
  const visible = on && deviation > 0.05;
  const inTune = visible && deviation >= 0.46 && deviation < 0.54;
  note.textContent = visible ? TUNER_NOTES[state.tuner.note] ?? '?' : on ? '—' : '';
  note.classList.toggle('in-tune', inTune);
  needle.style.left = `${(visible ? deviation : 0.5) * 100}%`;
  needle.classList.toggle('hidden', !visible);
  needle.classList.toggle('in-tune', inTune);
}

function renderSettings() {
  const root = $('#settings');
  root.replaceChildren(h('h2', {}, 'Amp settings'));
  const s = state.settings;
  if (!state.client || !s) return;
  root.append(
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.hiz, onchange: (e) => changeSetting('hiz', e.target.checked) }), 'Hi-Z input'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.lineOutMute, onchange: (e) => changeSetting('lineOutMute', e.target.checked) }), 'Line Out mutes the speaker'),
    h('label', { class: 'field' }, 'Expression pedal',
      h('select', { value: s.expMode, onchange: (e) => changeSetting('expMode', Number(e.target.value)) },
        EXP_MODES.map((label, i) => h('option', { value: i }, label)))),
  );
}

function renderEditor() {
  const root = $('#editor');
  if (!state.client || !state.preset) {
    if (!root.querySelector('.welcome')) root.replaceChildren(welcome());
    return;
  }
  root.replaceChildren(renderHeader(state.preset), renderAmp(state.preset), renderChain(state.preset));
}

function welcome() {
  const feedback = h('p', { class: 'hint' }, 'Found a problem? ',
    h('a', { href: ISSUES, target: '_blank', rel: 'noopener' }, 'Open an issue on GitHub'), '.');
  const notice = h('p', { class: 'hint' }, 'Knobwork is an independent project, not affiliated with or endorsed by Positive Grid. Positive Grid and REACTOR are trademarks of Positive Grid LLC.');
  if (!navigator.bluetooth) {
    return h('div', { class: 'welcome' }, h('h1', {}, 'This browser can’t use Bluetooth'),
      h('p', {}, 'Open this page in Chrome or Edge on a Mac, PC or Android device. On iPhone and iPad, use the Bluefy browser.'), feedback, notice);
  }
  return h('div', { class: 'welcome' }, h('h1', {}, 'Connect to your REACTOR'),
    h('p', {}, 'Turn the amp on, close the Positive Grid app on your phone or tablet (the amp accepts one Bluetooth connection at a time), then press Connect and pick the amp.'), feedback, notice);
}

function renderHeader(p) {
  return h('div', { class: 'preset-header' },
    h('div', { class: 'title' },
      h('h1', {}, p.name),
      h('div', { class: 'sub' }, [p.description, p.tags.join(' · ')].filter(Boolean).join(' — '))),
    h('div', { class: 'tempo' },
      h('label', { for: 'bpm' }, 'BPM'),
      h('input', { id: 'bpm', type: 'number', min: 40, max: 250, step: 1, value: Math.round(p.bpm), onchange: (e) => setBpm(Number(e.target.value)) }),
      h('button', { onclick: tap, title: 'Tap the tempo' }, 'Tap')));
}

function slider({ key, label, value, format, onChange, className = 'param' }) {
  const out = h('span', { class: 'pvalue' }, format(value));
  const input = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value, 'aria-label': label });
  const stop = () => {
    if (state.dragging === key) state.dragging = null;
  };
  input.addEventListener('pointerdown', () => (state.dragging = key));
  input.addEventListener('pointerup', stop);
  input.addEventListener('pointercancel', stop);
  input.addEventListener('change', stop);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onChange(v);
  });
  const node = h('label', { class: className, dataset: { param: key } }, h('span', { class: 'plabel' }, label), input, out);
  node.update = (v) => {
    input.value = String(v);
    out.textContent = format(v);
  };
  return node;
}

// The five front-panel knobs of an amp, for its picture.
function ampKnobs(amp) {
  return AMP_KNOBS.map((k) => {
    const block = amp.blocks.find((b) => dspOf(b) === k.dsp);
    return { key: `${k.dsp}/${k.index}`, value: halfToFloat(block.params[k.index]) };
  });
}

// Turns the knobs (and moves the sliders) of the pictures that show a parameter.
function updateArt(key, value) {
  for (const node of document.querySelectorAll(`[data-art-param="${CSS.escape(key)}"]`)) node.setValue(value);
}

function renderAmp(p) {
  const amp = p.amp;
  const library = libraryAmp(amp);
  const reactorAmp = p.blocks.find(isAmpBlock);
  const k = reactorAmp ? Math.round(halfToFloat(reactorAmp.params[0])) : 7;
  const row = Math.floor(k / 5);
  const col = k % 5;
  const knobs = AMP_KNOBS.map((knob) => {
    const block = amp.blocks.find((b) => dspOf(b) === knob.dsp);
    return slider({
      key: `${knob.dsp}/${knob.index}`, label: knob.label, value: halfToFloat(block.params[knob.index]), className: 'knob',
      format: (v) => (v * 10).toFixed(1),
      onChange: (v) => setParam(knob.dsp, block, knob.index, v),
    });
  });
  const segmented = (label, names, selected, onPick) => h('div', { class: 'segmented' },
    h('span', { class: 'plabel' }, label),
    h('div', { class: 'segments', role: 'group', 'aria-label': label }, names.map((name, i) => h('button', { class: i === selected ? 'active' : '', 'aria-pressed': String(i === selected), onclick: () => i !== selected && onPick(i) }, name))));
  return h('section', { class: 'amp-panel' },
    ampArt(library ? library.bank : null, ampKnobs(amp)),
    h('div', { class: 'amp-head' },
      h('div', {}, h('div', { class: 'cat' }, 'Amp'), h('div', { class: 'amp-name' }, ampLabel(amp))),
      h('label', { class: 'field' }, 'Amp selector',
        h('select', { value: library ? library.bank : '', onchange: (e) => selectAmp(Number(e.target.value)) },
          library ? null : h('option', { value: '', disabled: true }, `${amp.name} (custom)`),
          AMPS.map((a) => h('option', { value: a.bank }, `${a.selector} — ${a.label ?? a.name}`))))),
    h('div', { class: 'knobs' }, knobs),
    h('div', { class: 'character' },
      segmented('Character', CHARACTER, row, (r) => setVariant(5 * r + col)),
      segmented('Heat', HEAT, col, (c) => setVariant(5 * row + c))));
}

// An Amp-selector amp is shown under the official app's name for it.
function ampLabel(amp) {
  const library = libraryAmp(amp);
  return library && library.name === amp.name ? (library.label ?? library.name) : amp.name;
}

function renderChain(p) {
  return h('section', { class: 'chain-section' },
    h('h2', {}, 'Signal chain'),
    h('div', { class: 'chain' }, p.blocks.map((b, pos) => renderBlock(p, b, pos))));
}

function renderBlock(p, block, pos) {
  const dsp = dspOf(block);
  if (dsp === REACTOR_AMP) {
    const library = libraryAmp(p.amp);
    return h('div', { class: 'block amp-block', dataset: { dsp, category: CATEGORIES.indexOf('Amp') } },
      h('div', { class: 'block-head' }, h('span', { class: 'cat' }, 'Amp')),
      ampArt(library ? library.bank : null, ampKnobs(p.amp)),
      h('div', { class: 'amp-name' }, ampLabel(p.amp)));
  }
  const model = MODEL_BY_DSP[dsp];
  const category = model?.category ?? 'Unknown';
  const categoryIndex = CATEGORIES.indexOf(category);
  const neighbour = (i) => i >= 0 && i < p.blocks.length;
  const values = block.params.map(halfToFloat);
  // Parameters without a label are not shown (e.g. Studio Reverb's own on/off flag, which the power button switches).
  const shown = (model?.params ?? []).flatMap((x, index) => (x.label ? [{ ...x, index }] : []));
  const params = shown.map((x) => paramControl(dsp, block, x.index, values));
  const art = pedalArt(category, shown.map((x) => ({
    key: `${dsp}/${x.index}`, kind: x.kind === 'switch' ? 'switch' : 'knob', value: values[x.index],
  })), block.active);
  const classes = ['block', block.active ? 'on' : 'off', categoryIndex === state.selectedCategory ? 'selected' : ''].filter(Boolean);
  return h('div', { class: classes.join(' '), dataset: { dsp, category: categoryIndex } },
    h('div', { class: 'block-head' },
      h('button', { class: `power${block.active ? ' on' : ''}`, title: block.active ? 'Turn off' : 'Turn on', 'aria-label': `${category} on/off`, onclick: () => toggleBlock(pos) }),
      h('span', { class: 'cat' }, category),
      h('span', { class: 'moves' },
        h('button', { title: 'Move earlier in the chain', disabled: !neighbour(pos - 1), onclick: () => moveBlock(pos, pos - 1) }, '‹'),
        h('button', { title: 'Move later in the chain', disabled: !neighbour(pos + 1), onclick: () => moveBlock(pos, pos + 1) }, '›'))),
    art,
    h('select', { class: 'model-select', value: dsp, 'aria-label': `${category} model`, onchange: (e) => changeModel(pos, e.target.value) },
      model ? modelsIn(category).map((m) => h('option', { value: m.dspId }, m.name)) : h('option', { value: dsp }, dsp)),
    h('div', { class: 'params' }, params));
}

function paramControl(dsp, block, index, values) {
  const label = MODEL_BY_DSP[dsp].params[index].label;
  const key = `${dsp}/${index}`;
  const choices = paramChoices(dsp, index, values);
  if (choices) {
    const selected = nearest(choices.map((c) => c.value), values[index]);
    return h('label', { class: 'param choice', dataset: { param: key } },
      h('span', { class: 'plabel' }, label),
      h('select', { value: choices[selected].value, onchange: (e) => setParam(dsp, block, index, Number(e.target.value), true) },
        choices.map((c) => h('option', { value: c.value }, c.label))));
  }
  return slider({
    key, label, value: values[index],
    format: (v) => formatParam(dsp, index, values.map((x, i) => (i === index ? v : halfToFloat(block.params[i])))),
    onChange: (v) => setParam(dsp, block, index, v),
  });
}

function rerenderBlock(dsp) {
  const p = state.preset;
  if (!p) return;
  const pos = p.blocks.findIndex((b) => dspOf(b) === dsp);
  const old = document.querySelector(`.block[data-dsp="${CSS.escape(dsp)}"]`);
  if (pos < 0 || !old || old.contains(document.activeElement) && state.dragging) return;
  old.replaceWith(renderBlock(p, p.blocks[pos], pos));
}

// ---------- wiring

$('#connect').addEventListener('click', () => (state.client ? disconnect() : connect()));
$('#save').addEventListener('click', () => state.preset && !state.busy && openSaveDialog());
$('#export').addEventListener('click', exportPreset);
$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => {
  const [file] = e.target.files;
  e.target.value = '';
  if (file) importPreset(file);
});
// The tuner is switched off when the page closes, so the amp is not left in tuner mode (as far as the browser lets the
// write through before it drops the connection).
window.addEventListener('beforeunload', () => {
  const { client, transport } = state;
  const off = client && state.tuner.on ? client.send(Requests.setTuner(false)) : Promise.resolve();
  off.catch(() => {}).finally(() => transport?.close());
});

render();
navigator.bluetooth?.getAvailability?.().then((available) => {
  if (!available) toast('Bluetooth is off or not available on this computer.', 'error');
});
