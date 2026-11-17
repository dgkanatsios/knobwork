// Effect models, block codes and amps (docs/protocol.md, sections 7, 10 and 11).

export const CATEGORIES = ['Gate', 'Comp', 'Drive', 'Amp', 'Mod', 'Delay', 'Reverb', 'EQ', 'Wah', 'FX Loop'];

// Amp-selector amps = amp banks 00-05. id = the amp data's meta id (the same in all 15 variants and in presets
// using it); name = the name in the amp data; label = the name the official app shows, where it differs.
export const AMPS = [
  { bank: 0, selector: "Clean", name: "Classic Deluxe", label: "60's Clean", id: "fa82326a42a141fd96df7ff99cc50e82" },
  { bank: 1, selector: "Warm", name: "Vintage 45'", id: "faf216f92ccc47979a2e577ccf271769" },
  { bank: 2, selector: "Grit", name: "M1 Clean", id: "faf4ac6405674cab9fe90bdff13e1ab4" },
  { bank: 3, selector: "Crunch", name: "80s Crunch", id: "fa3d7a0ce05e47ada8344b7385220281" },
  { bank: 4, selector: "Hi-Gain", name: "Briton", id: "fa864643ab5f4d3a8cdbf605f20b7959" },
  { bank: 5, selector: "Extreme", name: "Harmonic Halo", id: "fa6d69b6cac94ac2887859fd75f322ce" },
];

// Front-panel knobs: amp block id and parameter index.
export const AMP_KNOBS = [
  { label: "GAIN", dsp: "Amp.Preamp", index: 0 },
  { label: "BASS", dsp: "Amp.Tonestack", index: 1 },
  { label: "MIDDLE", dsp: "Amp.Tonestack", index: 2 },
  { label: "TREBLE", dsp: "Amp.Tonestack", index: 3 },
  { label: "MASTER", dsp: "Amp.Poweramp", index: 0 },
];

export const REACTOR_AMP = 'ReactorAmp';

// Block code -> dspId for every block REACTOR presets and amp data use.
export const BLOCK_CODES = {
  0x0309: "bias.noisegate",
  0x040a: "SustainComp",
  0x040b: "RCBooster",
  0x040c: "JimiWah",
  0x040d: "ReactorAmp",
  0x040f: "ChorusAnalog",
  0x0410: "DelayEchoFilt",
  0x0411: "MonoReverb",
  0x0412: "EffectLoop",
  0x0416: "BBEOpticalComp",
  0x0418: "Tremolo",
  0x0419: "ChorusCloner",
  0x041a: "Flanger",
  0x041b: "Phaser",
  0x041f: "DistortionOCD",
  0x0420: "KlonCentaur",
  0x0421: "ProCoRat",
  0x0422: "DistortionTS9",
  0x0425: "DelayRE201",
  0x0426: "DelayDM2",
  0x042a: "RedComp",
  0x042b: "4kComp",
  0x042c: "GuitarEQ7",
  0x042d: "Tremulator",
  0x042e: "TremoloSquare",
  0x042f: "FuzzFace",
  0x0430: "BigMuff",
  0x0431: "JH.SupaFuzz",
  0x0432: "Delay",
  0x0434: "CabCompensator",
  0x0435: "ReactorCabSim",
  0x0502: "Amp.Preamp",
  0x0503: "Amp.Tonestack",
  0x0505: "Amp.Poweramp",
  0x0506: "Amp.Transformer",
};

// Effect models. params[i] is parameter i, as sent in 01 04 and stored in presets. Values on the wire are 0..1:
//   { label, kind: 'scale', min, max, unit }   shown from min to max
//   { label, kind: 'switch', on, off }         0 or 1
//   { label, kind: 'steps', steps }            steps = [[value, label], ...]
//   { label, kind: 'time', min, max, unit, modes, sync }
//       a time from min to max, or per Mode step (modes); with the BPM switch on, one of the sync steps
// label null = not shown (e.g. the Noise Gate's and Studio Reverb's own on/off flags).
export const MODELS = [
  {
    dspId: 'bias.noisegate', code: 0x0309, category: 'Gate', name: 'Noise Gate',
    params: [
      { label: 'THRESHOLD', kind: 'scale', min: 0, max: 10 },
      { label: 'DECAY', kind: 'scale', min: 0, max: 10 },
      { label: null },
    ],
  },
  {
    dspId: 'SustainComp', code: 0x040a, category: 'Comp', name: 'Sustain Comp',
    params: [
      { label: 'LEVEL', kind: 'scale', min: 0, max: 10 },
      { label: 'TONE', kind: 'scale', min: 0, max: 10 },
      { label: 'ATTACK', kind: 'scale', min: 0, max: 10 },
      { label: 'SUSTAIN', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'RedComp', code: 0x042a, category: 'Comp', name: 'Red Comp',
    params: [
      { label: 'GAIN', kind: 'scale', min: 0, max: 10 },
      { label: 'Threshold', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'BBEOpticalComp', code: 0x0416, category: 'Comp', name: 'Opto Comp',
    params: [
      { label: 'Volume', kind: 'scale', min: -6, max: 6, unit: 'dB' },
      { label: 'Comp', kind: 'scale', min: 0, max: 10 },
      { label: 'Pad', kind: 'switch', on: '-15dB', off: '0dB' },
    ],
  },
  {
    dspId: '4kComp', code: 0x042b, category: 'Comp', name: 'Studio Comp',
    params: [
      { label: 'Sustain', kind: 'scale', min: 0, max: 10 },
      { label: 'Level', kind: 'scale', min: 0, max: 10 },
      { label: 'Attack', kind: 'scale', min: 0, max: 10 },
      { label: 'Clipping', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'GuitarEQ7', code: 0x042c, category: 'EQ', name: 'EQ7',
    params: [
      { label: 'LEVEL', kind: 'scale', min: -10, max: 10 },
      { label: '100', kind: 'scale', min: -10, max: 10 },
      { label: '200', kind: 'scale', min: -10, max: 10 },
      { label: '400', kind: 'scale', min: -10, max: 10 },
      { label: '800', kind: 'scale', min: -10, max: 10 },
      { label: '1.6K', kind: 'scale', min: -10, max: 10 },
      { label: '3.2K', kind: 'scale', min: -10, max: 10 },
      { label: '6.4K', kind: 'scale', min: -10, max: 10 },
    ],
  },
  {
    dspId: 'ChorusAnalog', code: 0x040f, category: 'Mod', name: 'Analog Chorus',
    params: [
      { label: 'E.LEVEL', kind: 'scale', min: 0, max: 10 },
      { label: 'RATE', kind: 'scale', min: 0, max: 10 },
      { label: 'DEPTH', kind: 'scale', min: 0, max: 10 },
      { label: 'TONE', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'ChorusCloner', code: 0x0419, category: 'Mod', name: 'Cloner Chorus',
    params: [
      { label: 'RATE', kind: 'scale', min: 0, max: 10 },
      { label: 'DEPTH', kind: 'switch', on: 'HIGH', off: 'LOW' },
    ],
  },
  {
    dspId: 'Flanger', code: 0x041a, category: 'Mod', name: 'Jet Flanger',
    params: [
      { label: 'MIX', kind: 'scale', min: 0, max: 10 },
      { label: 'RATE', kind: 'scale', min: 0, max: 10 },
      { label: 'DEPTH', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'Phaser', code: 0x041b, category: 'Mod', name: 'Classic Phaser',
    params: [
      { label: 'SPEED', kind: 'scale', min: 0, max: 10 },
      { label: 'INTENSITY', kind: 'scale', min: 0, max: 10 },
      { label: null },
      { label: null },
    ],
  },
  {
    dspId: 'Tremolo', code: 0x0418, category: 'Mod', name: 'Tremolo',
    params: [
      { label: 'LEVEL', kind: 'scale', min: 0, max: 10 },
      { label: 'SPEED', kind: 'scale', min: 0, max: 10 },
      { label: 'DEPTH', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'Tremulator', code: 0x042d, category: 'Mod', name: 'Tremolator',
    params: [
      { label: 'Depth', kind: 'scale', min: 0, max: 10 },
      {
        label: 'Speed', kind: 'time', min: 0, max: 10,
        sync: [
          [0, '1/2'], [0.23, '1/4'], [0.461, '1/8'], [0.692, '1/16'],
        ],
      },
      { label: 'BPM', kind: 'switch', on: 'on', off: 'off' },
    ],
  },
  {
    dspId: 'TremoloSquare', code: 0x042e, category: 'Mod', name: 'Square Tremolo',
    params: [
      { label: 'Rate', kind: 'scale', min: 0, max: 10 },
      { label: 'Depth', kind: 'scale', min: 0, max: 10 },
      { label: 'Mix', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'JimiWah', code: 0x040c, category: 'Wah', name: 'Wah',
    params: [
      {
        label: 'Program', kind: 'steps',
        steps: [
          [0, 'Prog1'], [0.2, 'Prog2'], [0.4, 'Prog3'], [0.6, 'Prog4'], [0.8, 'Prog5'], [0.9, 'Manual'],
          [1, 'Auto Detect'],
        ],
      },
      { label: 'BPM Sync', kind: 'switch', on: 'on', off: 'off' },
      { label: 'ms', kind: 'scale', min: 125, max: 1000, unit: 'ms' },
      { label: 'Bar', kind: 'steps', steps: [[0, '1/8'], [0.25, '1/4'], [0.5, '1/2'], [0.75, '1']] },
      { label: 'Sensitivity', kind: 'scale', min: 0, max: 10 },
      { label: null },
    ],
  },
  {
    dspId: 'DistortionOCD', code: 0x041f, category: 'Drive', name: 'OB Drive',
    params: [
      { label: 'Volume', kind: 'scale', min: 0, max: 10 },
      { label: 'Tone', kind: 'scale', min: 0, max: 10 },
      { label: 'Drive', kind: 'scale', min: 0, max: 10 },
      { label: 'LP / HP', kind: 'switch', on: 'HP', off: 'LP' },
    ],
  },
  {
    dspId: 'KlonCentaur', code: 0x0420, category: 'Drive', name: 'Gold Drive',
    params: [
      { label: 'OUTPUT', kind: 'scale', min: 0, max: 10 },
      { label: 'TREBLE', kind: 'scale', min: 0, max: 10 },
      { label: 'GAIN', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'ProCoRat', code: 0x0421, category: 'Drive', name: 'Black Dist',
    params: [
      { label: 'VOLUME', kind: 'scale', min: 0, max: 10 },
      { label: 'DISTORTION', kind: 'scale', min: 0, max: 10 },
      { label: 'FILTER', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'DistortionTS9', code: 0x0422, category: 'Drive', name: 'Green Drive',
    params: [
      { label: 'LEVEL', kind: 'scale', min: 0, max: 10 },
      { label: 'OVERDRIVE', kind: 'scale', min: 0, max: 10 },
      { label: 'TONE', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'RCBooster', code: 0x040b, category: 'Drive', name: 'Clean Boost',
    params: [
      { label: 'Volume', kind: 'scale', min: 0, max: 10 },
      { label: 'Gain', kind: 'scale', min: 0, max: 10 },
      { label: 'Bass', kind: 'scale', min: 0, max: 10 },
      { label: 'Treble', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'FuzzFace', code: 0x042f, category: 'Drive', name: 'Classic Fuzz',
    params: [
      { label: 'Volume', kind: 'scale', min: 0, max: 10 },
      { label: 'Gain', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'BigMuff', code: 0x0430, category: 'Drive', name: 'Wall Fuzz',
    params: [
      { label: 'VOLUME', kind: 'scale', min: 0, max: 10 },
      { label: 'Tone', kind: 'scale', min: 0, max: 10 },
      { label: 'Sustain', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'JH.SupaFuzz', code: 0x0431, category: 'Drive', name: 'Super Fuzz',
    params: [
      { label: 'VOLUME', kind: 'scale', min: 0, max: 10 },
      { label: 'Filter', kind: 'scale', min: 0, max: 10 },
    ],
  },
  {
    dspId: 'DelayEchoFilt', code: 0x0410, category: 'Delay', name: 'Filter Echo',
    params: [
      { label: 'LEVEL', kind: 'scale', min: 0, max: 10 },
      {
        label: 'DELAY', kind: 'time', min: 100, max: 1000, unit: 'ms',
        sync: [
          [0, '1/32'], [0.0769, '1/16'], [0.1538, '1/16t'], [0.2308, '1/16d'], [0.3077, '1/8'], [0.3846, '1/8t'],
          [0.4615, '1/8d'], [0.5385, '1/4'], [0.6154, '1/4t'], [0.6923, '1/4d'], [0.7692, '1/2'], [0.8462, '1/2t'],
          [0.9231, '1/2d'], [1, '1'],
        ],
      },
      { label: 'FEEDBACK', kind: 'scale', min: 0, max: 10 },
      { label: 'TONE', kind: 'scale', min: 0, max: 10 },
      { label: 'BPM', kind: 'switch', on: 'on', off: 'off' },
    ],
  },
  {
    dspId: 'Delay', code: 0x0432, category: 'Delay', name: 'Digital Delay',
    params: [
      { label: 'Mix', kind: 'scale', min: 0, max: 10 },
      { label: 'Feedback', kind: 'scale', min: 0, max: 10 },
      {
        label: 'DelayTime', kind: 'time', min: 1, max: 1000, unit: 'ms',
        modes: [
          { min: 1, max: 50, unit: 'ms' }, { min: 50, max: 200, unit: 'ms' }, { min: 200, max: 500, unit: 'ms' },
          { min: 500, max: 1000, unit: 'ms' },
        ],
        sync: [
          [0, '1/32'], [0.0769, '1/16'], [0.1538, '1/16t'], [0.2308, '1/16d'], [0.3077, '1/8'], [0.3846, '1/8t'],
          [0.4615, '1/8d'], [0.5385, '1/4'], [0.6154, '1/4t'], [0.6923, '1/4d'], [0.7692, '1/2'], [0.8462, '1/2t'],
          [0.9231, '1/2d'], [1, '1'],
        ],
      },
      { label: 'Mode', kind: 'steps', steps: [[0.3, '50ms'], [0.4, '200ms'], [0.6, '500ms'], [0.72, '1s']] },
      { label: 'BPM', kind: 'switch', on: 'on', off: 'off' },
    ],
  },
  {
    dspId: 'DelayDM2', code: 0x0426, category: 'Delay', name: 'Analog Delay',
    params: [
      { label: 'ECHO', kind: 'scale', min: 0, max: 10 },
      {
        label: 'REPEAT RATE', kind: 'time', min: 0, max: 10,
        sync: [
          [0, '1/32'], [0.0769, '1/16'], [0.1538, '1/16t'], [0.2308, '1/16d'], [0.3077, '1/8'], [0.3846, '1/8t'],
          [0.4615, '1/8d'], [0.5385, '1/4'], [0.6154, '1/4t'], [0.6923, '1/4d'], [0.7692, '1/2'], [0.8462, '1/2t'],
          [0.9231, '1/2d'], [1, '1'],
        ],
      },
      { label: 'INTENSITY', kind: 'scale', min: 0, max: 10 },
      { label: 'BPM', kind: 'switch', on: 'on', off: 'off' },
    ],
  },
  {
    dspId: 'DelayRE201', code: 0x0425, category: 'Delay', name: 'Tape Echo',
    params: [
      { label: 'SUSTAIN', kind: 'scale', min: 0, max: 10 },
      { label: 'VOLUME', kind: 'scale', min: 0, max: 10 },
      { label: 'TONE', kind: 'scale', min: 0, max: 10 },
      {
        label: 'SHORT ~ LONG', kind: 'time', min: 70, max: 600, unit: 'ms',
        sync: [
          [0, '1/32'], [0.0769, '1/16'], [0.1538, '1/16t'], [0.2308, '1/16d'], [0.3077, '1/8'], [0.3846, '1/8t'],
          [0.4615, '1/8d'], [0.5385, '1/4'], [0.6154, '1/4t'], [0.6923, '1/4d'], [0.7692, '1/2'], [0.8462, '1/2t'],
          [0.9231, '1/2d'], [1, '1'],
        ],
      },
      { label: 'BPM', kind: 'switch', on: 'on', off: 'off' },
    ],
  },
  {
    dspId: 'MonoReverb', code: 0x0411, category: 'Reverb', name: 'Studio Reverb',
    params: [
      { label: 'Level', kind: 'scale', min: 0, max: 10 },
      { label: 'Damping', kind: 'scale', min: 0, max: 10 },
      { label: 'Dwell', kind: 'scale', min: 0, max: 10 },
      { label: 'Time', kind: 'scale', min: 0, max: 10 },
      { label: 'Low Cut', kind: 'scale', min: 20, max: 400, unit: 'Hz' },
      { label: 'High Cut', kind: 'scale', min: 8000, max: 1000, unit: 'Hz' },
      {
        label: 'Mode', kind: 'steps',
        steps: [
          [0, 'Room Studio A'], [0.1, 'Room Studio B'], [0.2, 'Chamber'], [0.3, 'Hall Natural'], [0.4, 'Hall Medium'],
          [0.5, 'Hall Ambient'], [0.6, 'Plate Short'], [0.7, 'Plate Rich'], [0.8, 'Plate Long'],
        ],
      },
      { label: null },
    ],
  },
  {
    dspId: 'EffectLoop', code: 0x0412, category: 'FX Loop', name: 'Effect Loop',
    params: [
      { label: 'SendVol', kind: 'scale', min: -24, max: 6, unit: 'dB' },
      { label: 'ReturnVol', kind: 'scale', min: -24, max: 6, unit: 'dB' },
      { label: 'SendActive', kind: 'switch', on: 'on', off: 'off' },
      { label: 'ReturnActive', kind: 'switch', on: 'on', off: 'off' },
    ],
  },
];

export const MODEL_BY_DSP = Object.fromEntries(MODELS.map((m) => [m.dspId, m]));

export function dspOfCode(code) {
  return BLOCK_CODES[code];
}

export function categoryOf(dspId) {
  if (dspId === REACTOR_AMP) return 'Amp';
  return MODEL_BY_DSP[dspId]?.category;
}

export function modelsIn(category) {
  return MODELS.filter((m) => m.category === category);
}
