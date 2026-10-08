// Procedural sound design for the loop. Every cue is timed from the same
// timeline as the picture. The mix is circular: a sound that rings past the
// last sample wraps to the start, and the reverb runs over the buffer twice,
// so the track repeats without a click or a missing tail.

import { mulberry32 } from "./motion.ts";
import { SWIPE_DURATIONS, T, TOTAL, sec } from "./timeline.ts";

export const SAMPLE_RATE = 48000;
const LOOP_SECONDS = sec(TOTAL);
const TAU = Math.PI * 2;

// Rounded to whole cycles per loop so sustained tones meet their own start.
const cyc = (hz: number): number => Math.round(hz * LOOP_SECONDS) / LOOP_SECONDS;

const NOTE: Record<string, number> = {
  D2: 73.42, G2: 98.0, A2: 110.0, B2: 123.47, D3: 146.83, E3: 164.81, Fs3: 185.0,
  G3: 196.0, A3: 220.0, B3: 246.94, Cs4: 277.18, D4: 293.66, E4: 329.63,
  Fs4: 369.99, A4: 440.0, B4: 493.88, Cs5: 554.37, D5: 587.33, E5: 659.26,
  Fs5: 739.99, A5: 880.0, B5: 987.77, D6: 1174.66, E6: 1318.51, Fs6: 1479.98,
  A6: 1760.0, E7: 2637.02,
};

type Mix = {
  n: number;
  l: Float32Array;
  r: Float32Array;
  sl: Float32Array;
  sr: Float32Array;
};

const createMix = (sampleRate: number): Mix => {
  const n = Math.round(LOOP_SECONDS * sampleRate);
  return {
    n,
    l: new Float32Array(n),
    r: new Float32Array(n),
    sl: new Float32Array(n),
    sr: new Float32Array(n),
  };
};

// Adds `fn(t)` for `dur` seconds from `at` seconds, panned in [-1, 1], with a
// share sent to the reverb.
const voice = (
  mix: Mix,
  sampleRate: number,
  at: number,
  dur: number,
  fn: (t: number, i: number) => number,
  { gain = 1, pan = 0, send = 0.2 }: { gain?: number; pan?: number | ((t: number) => number); send?: number } = {}
) => {
  const start = Math.round(at * sampleRate);
  const len = Math.round(dur * sampleRate);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const v = fn(t, i) * gain;
    const p = typeof pan === "function" ? pan(t) : pan;
    const angle = ((p + 1) * Math.PI) / 4;
    const gl = Math.cos(angle);
    const gr = Math.sin(angle);
    const k = (((start + i) % mix.n) + mix.n) % mix.n;
    mix.l[k] += v * gl;
    mix.r[k] += v * gr;
    mix.sl[k] += v * gl * send;
    mix.sr[k] += v * gr * send;
  }
};

const attack = (t: number, a: number) => Math.min(1, t / a);

// Topology-preserving state-variable filter; returns [low, band] per call.
const svf = () => {
  let ic1 = 0;
  let ic2 = 0;
  return (x: number, cutoff: number, q: number, sampleRate: number): [number, number] => {
    const g = Math.tan((Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return [v2, v1];
  };
};

export const renderLoopAudio = (sampleRate = SAMPLE_RATE): { left: Float32Array; right: Float32Array } => {
  const mix = createMix(sampleRate);
  const rand = mulberry32(7);
  const noise = () => rand() * 2 - 1;
  const at = (frame: number) => sec(frame);

  const bell = (s: number, f: number, gain: number, pan = 0, decay = 1.6, send = 0.45) =>
    voice(mix, sampleRate, s, decay * 3.2, (t) =>
      attack(t, 0.003) *
      (Math.sin(TAU * f * t) * Math.exp(-t / decay) +
        0.3 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t / (decay * 0.25)) +
        0.12 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t / (decay * 0.08))),
      { gain, pan, send });

  const mallet = (s: number, f: number, gain: number, pan = 0) =>
    voice(mix, sampleRate, s, 1.4, (t) =>
      attack(t, 0.002) *
      (Math.sin(TAU * f * t) * Math.exp(-t / 0.3) +
        0.22 * Math.sin(TAU * f * 4 * t) * Math.exp(-t / 0.04)),
      { gain, pan, send: 0.3 });

  const pluck = (s: number, f: number, gain: number, pan = 0) =>
    voice(mix, sampleRate, s, 1.6, (t) => {
      const ph = TAU * f * (t + 0.004 * (1 - Math.exp(-t / 0.03)));
      return attack(t, 0.002) * Math.exp(-t / 0.42) *
        (Math.sin(ph) + 0.28 * Math.sin(2 * ph) * Math.exp(-t / 0.15) + 0.1 * Math.sin(3 * ph) * Math.exp(-t / 0.08));
    }, { gain, pan, send: 0.35 });

  const thump = (s: number, gain: number) => {
    let phase = 0;
    voice(mix, sampleRate, s, 0.9, (t) => {
      const f = 42 + 70 * Math.exp(-t / 0.05);
      phase += (TAU * f) / sampleRate;
      return attack(t, 0.002) * Math.exp(-t / 0.26) * Math.sin(phase);
    }, { gain, send: 0.08 });
  };

  const tick = (s: number, f: number, gain: number, pan = 0) =>
    voice(mix, sampleRate, s, 0.08, (t) => Math.exp(-t / 0.009) * Math.sin(TAU * f * t), {
      gain, pan, send: 0.5,
    });

  const whoosh = (s: number, dur: number, f0: number, f1: number, gain: number, pan0 = 0, pan1 = 0) => {
    const filter = svf();
    voice(mix, sampleRate, s, dur, (t) => {
      const x = t / dur;
      const env = Math.sin(Math.PI * Math.pow(x, 0.75)) ** 2;
      const [, band] = filter(noise(), f0 * Math.pow(f1 / f0, x), 1.1, sampleRate);
      return env * band;
    }, { gain, pan: (t) => pan0 + (pan1 - pan0) * (t / dur), send: 0.3 });
  };

  // Reverse-cymbal style build that is cut dead at its end.
  const swell = (s: number, dur: number, f0: number, f1: number, gain: number) => {
    const filter = svf();
    voice(mix, sampleRate, s, dur, (t) => {
      const x = t / dur;
      const cut = Math.min(1, (dur - t) / 0.012);
      const [low] = filter(noise(), f0 * Math.pow(f1 / f0, x * x), 0.8, sampleRate);
      return Math.pow(x, 2.2) * cut * low;
    }, { gain, send: 0.15 });
  };

  const click = (s: number, gain: number) =>
    voice(mix, sampleRate, s, 0.12, (t) =>
      Math.exp(-t / 0.0025) * noise() * 0.5 +
      Math.exp(-t / 0.018) * Math.sin(TAU * 1850 * t) * 0.6 +
      Math.exp(-t / 0.03) * Math.sin(TAU * 620 * t) * 0.5,
      { gain, send: 0.12 });

  const pulse = (s: number, gain: number) => {
    let phase = 0;
    voice(mix, sampleRate, s, 0.4, (t) => {
      const f = 52 + 30 * Math.exp(-t / 0.03);
      phase += (TAU * f) / sampleRate;
      return attack(t, 0.003) * Math.exp(-t / 0.1) * Math.sin(phase);
    }, { gain, send: 0.02 });
  };

  const marker = (s: number, dur: number, gain: number) => {
    const filter = svf();
    voice(mix, sampleRate, s, dur, (t) => {
      const x = t / dur;
      const [, band] = filter(noise(), 2400 + 1600 * x, 2.5, sampleRate);
      return Math.sin(Math.PI * x) ** 1.5 * band;
    }, { gain, pan: (t) => -0.3 + 0.6 * (t / dur), send: 0.2 });
  };

  // Sustained chords. Breakpoints are [seconds from start, level].
  const pad = (startFrame: number, notes: number[], points: [number, number][], gain: number) => {
    const dur = points[points.length - 1][0];
    const level = (t: number) => {
      for (let i = 1; i < points.length; i++) {
        const [t1, v1] = points[i];
        const [t0, v0] = points[i - 1];
        if (t <= t1) {
          const x = (t - t0) / (t1 - t0);
          return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * x));
        }
      }
      return 0;
    };
    notes.forEach((note, j) => {
      const lo = cyc(note * 0.9985);
      const hi = cyc(note * 1.0015);
      const w = 1 / (1 + j * 0.35);
      const pan = j % 2 ? 0.35 : -0.35;
      voice(mix, sampleRate, at(startFrame), dur, (t) =>
        level(t) * w * (Math.sin(TAU * lo * t) + Math.sin(TAU * hi * t + j) + 0.12 * Math.sin(TAU * 3 * lo * t)) * 0.5,
        { gain, pan, send: 0.35 });
    });
  };

  // Home chord: blooms when the tile lands, rests across the loop point, and
  // swells under the flood until the breath before the first card.
  const home = sec(TOTAL - T.tileLand);
  pad(T.tileLand, [NOTE.D2, NOTE.D3, NOTE.A3, NOTE.E4, NOTE.Fs4], [
    [0, 0], [0.03, 1], [0.9, 0.5], [home, 0.36], [home + sec(24), 0.34],
    [home + sec(T.breath - 10), 0.9], [home + sec(T.breath), 0],
  ], 0.1);
  pad(T.cardIn, [NOTE.G2, NOTE.D3, NOTE.B3, NOTE.Fs4, NOTE.A4], [
    [0, 0], [0.04, 0.9], [1.2, 0.6], [sec(T.caption3 - T.cardIn), 0.5], [sec(T.caption3 - T.cardIn) + 0.4, 0],
  ], 0.1);
  pad(T.caption3, [NOTE.B2, NOTE.Fs3, NOTE.A3, NOTE.D4, NOTE.Cs5], [
    [0, 0], [0.3, 0.55], [sec(150), 0.55], [sec(150) + 0.3, 0],
  ], 0.09);
  pad(T.swipes[2], [NOTE.A2, NOTE.E3, NOTE.B3, NOTE.Cs4, NOTE.Fs4], [
    [0, 0], [0.2, 0.6], [sec(T.caption4 - T.swipes[2]), 0.6], [sec(T.caption4 - T.swipes[2]) + 0.4, 0],
  ], 0.09);
  pad(T.caption4, [NOTE.G3, NOTE.B3, NOTE.D4, NOTE.Fs4, NOTE.A4], [
    [0, 0], [0.35, 0.6], [sec(T.fold - T.caption4), 0.55], [sec(T.tileLand - T.caption4), 0],
  ], 0.085);

  // Act 1: the tile lets go, then a rain of glassy ticks that accelerates.
  pluck(at(T.tileRelease + 6), NOTE.A5, 0.12);
  voice(mix, sampleRate, at(T.tileRelease + 8), 0.3, (t) =>
    Math.exp(-t / 0.06) * Math.sin(TAU * (1400 - 2600 * t) * t), { gain: 0.05, send: 0.4 });
  const rain = [NOTE.A5, NOTE.B5, NOTE.D6, NOTE.E6, NOTE.Fs6, NOTE.A6];
  for (let s = at(T.floodStart + 6); s < at(T.breath - 2); ) {
    const x = (s - at(T.floodStart)) / (at(T.breath) - at(T.floodStart));
    tick(s, rain[Math.floor(rand() * rain.length)] * (rand() < 0.3 ? 2 : 1), 0.06 + 0.1 * x, rand() * 1.6 - 0.8);
    s += 1 / (5 + 42 * x * x);
  }
  swell(at(T.caption1a), at(T.breath) - at(T.caption1a), 180, 7000, 0.42);

  // Act 2: silence for a breath, then the card lands and assembles.
  thump(at(T.cardIn), 0.36);
  bell(at(T.cardIn), NOTE.D5, 0.16, 0, 2.2);
  bell(at(T.cardIn + 4), NOTE.A5, 0.07, 0.3, 2.0);
  [
    [T.label, NOTE.A4], [T.chips, NOTE.B4], [T.title, NOTE.D5],
    [T.authors, NOTE.E5], [T.abstract, NOTE.Fs5], [T.actions, NOTE.A5],
  ].forEach(([f, hz], i) => mallet(at(f), hz, 0.1, (i % 2 ? 0.25 : -0.25)));

  // Act 3: each swipe is an air stroke and a rising pluck over a soft pulse.
  whoosh(at(T.caption3 - 6), 0.5, 300, 1600, 0.12, -0.2, 0.2);
  const rising = [NOTE.D5, NOTE.E5, NOTE.Fs5, NOTE.A5, NOTE.B5, NOTE.D6];
  T.swipes.forEach((f, i) => {
    const d = sec(SWIPE_DURATIONS[i]);
    whoosh(at(f) - 0.03, d + 0.18, 450, 3200, 0.16 + i * 0.015, 0.25, -0.25);
    pluck(at(f) + d * 0.45, rising[i], 0.11, i % 2 ? 0.3 : -0.3);
  });
  const settle = T.swipes[T.swipes.length - 1] + 20;
  bell(at(settle), NOTE.D6, 0.08, 0, 1.8);
  thump(at(settle), 0.18);
  for (let f = T.swipes[0]; f <= T.swipes[T.swipes.length - 1]; f += 30) pulse(at(f), 0.24);

  // Act 4: a press, a shimmer as the words change, a highlighter stroke.
  whoosh(at(T.caption4 - 6), 0.5, 300, 1600, 0.1, 0.2, -0.2);
  click(at(T.press), 0.3);
  [NOTE.D6, NOTE.Fs6, NOTE.A6, NOTE.E7].forEach((hz, i) =>
    bell(at(T.plainIn - 6) + i * 0.07, hz, 0.045, i % 2 ? 0.4 : -0.4, 1.1, 0.7));
  marker(at(T.highlight), sec(30), 0.08);
  bell(at(T.highlight + 26), NOTE.Fs5, 0.05, 0.2, 1.6);

  // Act 5: the fold builds, the tile lands, the name appears.
  swell(at(T.fold), at(T.tileLand) - at(T.fold), 250, 6000, 0.34);
  thump(at(T.tileLand), 0.45);
  bell(at(T.tileLand), NOTE.D5, 0.15, -0.1, 2.6);
  bell(at(T.tileLand + 3), NOTE.A5, 0.08, 0.2, 2.4);
  bell(at(T.tileLand + 6), NOTE.Fs6, 0.035, 0.3, 2.0);
  whoosh(at(T.wordmark + 4), 0.6, 900, 4200, 0.06, -0.3, 0.3);
  marker(at(T.wordmark + 30), sec(22), 0.05);
  mallet(at(T.tagline + 4), NOTE.D6, 0.05, 0.1);
  whoosh(at(T.outro), 0.55, 2800, 600, 0.05, 0.3, -0.3);
  tick(at(T.rest), NOTE.A5, 0.05);

  const wet = reverb(mix, sampleRate);
  const left = new Float32Array(mix.n);
  const right = new Float32Array(mix.n);
  let peak = 0;
  for (let i = 0; i < mix.n; i++) {
    left[i] = Math.tanh((mix.l[i] + wet.l[i]) * 1.1);
    right[i] = Math.tanh((mix.r[i] + wet.r[i]) * 1.1);
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const norm = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < mix.n; i++) {
    left[i] *= norm;
    right[i] *= norm;
  }
  return { left, right };
};

// Freeverb-style network run over the send twice; the second pass already
// carries the tail of the first, which is what makes it seamless.
const reverb = (mix: Mix, sampleRate: number): { l: Float32Array; r: Float32Array } => {
  const scale = sampleRate / 44100;
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116];
  const allpasses = [556, 441, 341, 225];
  const run = (input: Float32Array, spread: number): Float32Array => {
    const out = new Float32Array(mix.n);
    const cBuf = combs.map((d) => new Float32Array(Math.round((d + spread) * scale)));
    const cIdx = combs.map(() => 0);
    const cLow = combs.map(() => 0);
    const aBuf = allpasses.map((d) => new Float32Array(Math.round((d + spread) * scale)));
    const aIdx = allpasses.map(() => 0);
    const feedback = 0.87;
    const damp = 0.32;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < mix.n; i++) {
        const x = input[i] * 0.03;
        let y = 0;
        for (let c = 0; c < combs.length; c++) {
          const b = cBuf[c];
          const o = b[cIdx[c]];
          cLow[c] = o * (1 - damp) + cLow[c] * damp;
          b[cIdx[c]] = x + cLow[c] * feedback;
          cIdx[c] = (cIdx[c] + 1) % b.length;
          y += o;
        }
        for (let a = 0; a < allpasses.length; a++) {
          const b = aBuf[a];
          const o = b[aIdx[a]];
          b[aIdx[a]] = y + o * 0.5;
          aIdx[a] = (aIdx[a] + 1) % b.length;
          y = o - y;
        }
        if (pass === 1) out[i] = y;
      }
    }
    return out;
  };
  return { l: run(mix.sl, 0), r: run(mix.sr, 23) };
};

export const encodeWav = (left: Float32Array, right: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array => {
  const frames = left.length;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(44 + i * 4, Math.round(l * 32767), true);
    view.setInt16(46 + i * 4, Math.round(r * 32767), true);
  }
  return bytes;
};
