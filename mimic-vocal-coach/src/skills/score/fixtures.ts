// Synthetic takes with known truth for the scoring tests and the calibration table (README.md). Test-only helpers;
// nothing in the app imports this file.

import { concat, makeRng, mix, synthMelody, synthVoice, type MelodyNote, type SynthOptions } from '../../testing/synth';

export const SR = 22050;

/** The calibration singer: vibrato 5.5 Hz +/-40 cents, jitter 0.5 %, breath noise 0.1 (SPEC.md section 7). */
export const SINGER: Omit<SynthOptions, 'f0' | 'durationSec'> = {
  sampleRate: SR,
  vibrato: { rateHz: 5.5, extentCents: 40, delaySec: 0.15 },
  jitter: 0.005,
  breathNoise: 0.1,
  vowel: 'a',
  amplitude: 0.3,
};

/** Quiet room noise: low-passed white noise around -62 dBFS. */
export function roomNoise(durSec: number, sampleRate = SR, seed = 11, rms = 0.0008): Float32Array {
  const rng = makeRng(seed);
  const n = Math.round(durSec * sampleRate);
  const out = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    const w = (rng() - 0.5) * 2;
    y = 0.95 * y + 0.05 * w;
    out[i] = y;
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += out[i] * out[i];
  const g = rms / (Math.sqrt(ss / n) || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Pads a take with `lead`/`tail` seconds of room noise and adds the same noise under it. */
export function inRoom(x: Float32Array, lead = 0.4, tail = 0.4, sampleRate = SR): Float32Array {
  const take = concat(new Float32Array(Math.round(lead * sampleRate)), x, new Float32Array(Math.round(tail * sampleRate)));
  return mix(take, roomNoise(take.length / sampleRate, sampleRate));
}

/** A legato line on one breath (synthMelody), in a room. */
export function singLine(notes: MelodyNote[], opts: Partial<SynthOptions> & { glideSec?: number } = {}): Float32Array {
  const sr = opts.sampleRate ?? SR;
  return inRoom(synthMelody(notes, { ...SINGER, ...opts }), 0.4, 0.4, sr);
}

/** Detached notes: each note its own onset/release, separated by `gapSec` of silence. */
export function singDetached(notes: MelodyNote[], gapSec = 0.15, opts: Partial<SynthOptions> = {}): Float32Array {
  const sr = opts.sampleRate ?? SR;
  const parts: Float32Array[] = [];
  notes.forEach((nt, i) => {
    if (i > 0) parts.push(new Float32Array(Math.round(gapSec * sr)));
    parts.push(synthMelody([nt], { ...SINGER, ...opts, seed: 7 + i }));
  });
  return inRoom(concat(...parts), 0.4, 0.4, sr);
}

/** One held note with an arbitrary contour (cents relative to `midi`, as a function of time). */
export function singContour(midi: number, durSec: number, centsAt: (t: number) => number, opts: Partial<SynthOptions> = {}): Float32Array {
  const sr = opts.sampleRate ?? SR;
  const a4 = 440;
  return inRoom(
    synthVoice({ ...SINGER, ...opts, durationSec: durSec, f0: (t) => a4 * Math.pow(2, (midi + centsAt(t) / 100 - 69) / 12) }),
    0.4,
    0.4,
    sr,
  );
}

/** A "sss": white noise high-passed around 3.5 kHz (two one-pole differences) at the given RMS, with 80 ms ramps. */
export function hiss(durSec: number, rms = 0.03, sampleRate = SR, seed = 5, wobbleDb = 0): Float32Array {
  const rng = makeRng(seed);
  const n = Math.round(durSec * sampleRate);
  const out = new Float32Array(n);
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < n; i++) {
    const w = (rng() - 0.5) * 2;
    const d1 = w - p1;
    p1 = w;
    const d2 = d1 - p2;
    p2 = d1;
    out[i] = d2;
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += out[i] * out[i];
  const g = rms / (Math.sqrt(ss / n) || 1);
  const ramp = Math.round(0.08 * sampleRate);
  for (let i = 0; i < n; i++) {
    let env = Math.min(1, i / ramp, (n - i) / ramp);
    if (wobbleDb) env *= Math.pow(10, (wobbleDb * Math.sin(2 * Math.PI * 0.7 * (i / sampleRate))) / 20);
    out[i] *= g * env;
  }
  return out;
}

/** Speech-like babble: short vowels at moving pitches, sibilant bursts and pauses (never a steady note or hiss). */
export function babble(durSec: number, sampleRate = SR): Float32Array {
  const rng = makeRng(23);
  const parts: Float32Array[] = [];
  let t = 0;
  let i = 0;
  while (t < durSec) {
    const vowelSec = 0.12 + rng() * 0.1;
    const startHz = 110 + rng() * 60;
    parts.push(
      synthVoice({ sampleRate, durationSec: vowelSec, f0: (x) => startHz * (1 + 0.8 * x), vowel: 'e', amplitude: 0.25, seed: 30 + i, breathNoise: 0.2 }),
    );
    parts.push(hiss(0.08, 0.02, sampleRate, 40 + i));
    parts.push(new Float32Array(Math.round((0.05 + rng() * 0.1) * sampleRate)));
    t += vowelSec + 0.08 + 0.1;
    i++;
  }
  return inRoom(concat(...parts), 0.5, 0.3, sampleRate);
}
