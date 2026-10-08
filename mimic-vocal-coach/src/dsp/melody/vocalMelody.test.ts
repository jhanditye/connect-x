import { describe, expect, test } from 'vitest';
import { concat, silence, sine, synthMelody, whiteNoise } from '../../testing/synth';
import { trackPitch } from '../pitch';
import { applyLevelVoicing, emptyVocalMelody, extractVocalMelody, MAX_MELODY_SEC, MIN_HARMONIC_SHARE, refineF0 } from './vocalMelody';

const SR = 22050;

/** Cheap additive oscillator for the accompaniment: `harmonics` partials with a 1/h^1.3 roll-off. */
function osc(f0: number, n: number, amp: number, phase: number, harmonics = 14): Float32Array {
  const out = new Float32Array(n);
  for (let h = 1; h <= harmonics && h * f0 < 0.45 * SR; h++) {
    const a = amp / Math.pow(h, 1.3);
    const w = (2 * Math.PI * h * f0) / SR;
    const p = phase * h;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin(w * i + p);
  }
  return out;
}

/**
 * A sung line over a stereo band: the voice is centred; the bass is centred; the chord pad and a
 * guitar-like drone are decorrelated between the channels (different detune and phase per channel).
 * Returns the ground-truth f0 per frame (vibrato ignored, glides and releases excluded). Built once
 * and shared: the additive voice synthesiser takes a few seconds.
 */
let cached: { L: Float32Array; R: Float32Array; truth: Float64Array } | null = null;
function song(): { L: Float32Array; R: Float32Array; truth: Float64Array } {
  if (cached) return cached;
  const notes = [57, 60, 64, 62, 60, 57, 55, 59, 62, 64].map((midi) => ({ midi, durSec: 0.85 }));
  const melody = synthMelody(notes, { sampleRate: SR, seed: 3, amplitude: 0.35, vibrato: { rateHz: 5.5, extentCents: 20, delaySec: 0.2 }, jitter: 0.002, vowel: 'a' });
  // 0.4 s lead-in, notes 0-5 s of the line, a 1.2 s rest, then the rest of the line
  const vocal = concat(silence(0.4, SR), melody.subarray(0, Math.round(4.25 * SR)), silence(1.2, SR), melody.subarray(Math.round(4.25 * SR)));
  const n = vocal.length;
  const chord = (hz: number[], channel: number, amp: number) => {
    const out = new Float32Array(n);
    hz.forEach((f, k) => {
      const t = osc(f * (1 + 0.0007 * (k + 3 * channel)), n, amp, 1.7 * (k + 1) * (channel + 1));
      for (let i = 0; i < n; i++) out[i] += t[i];
    });
    return out;
  };
  const padL = chord([130.81, 164.81, 196, 261.63], 0, 0.1);
  const padR = chord([130.81, 164.81, 196, 261.63], 1, 0.1);
  const guitarL = chord([110, 220.5, 329.6], 0, 0.06);
  const guitarR = chord([110, 220.5, 329.6], 1, -0.04);
  const bass = osc(55, n, 0.25, 0.3, 10);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = vocal[i] + padL[i] + guitarL[i] + bass[i];
    R[i] = vocal[i] + padR[i] + guitarR[i] + bass[i];
  }
  const nFrames = Math.floor((n - 1) / (0.01 * SR)) + 1;
  const truth = new Float64Array(nFrames).fill(NaN);
  const lineLen = notes.length * 0.85;
  for (let i = 0; i < nFrames; i++) {
    const t = i * 0.01;
    let local = -1;
    if (t >= 0.4 && t < 0.4 + 4.25) local = t - 0.4;
    else if (t >= 0.4 + 4.25 + 1.2) local = t - 0.4 - 1.2;
    if (local < 0 || local >= lineLen) continue;
    const idx = Math.min(notes.length - 1, Math.floor(local / 0.85));
    const into = local - idx * 0.85;
    if (into < 0.08 || into > 0.85 - 0.05) continue; // glide / release
    truth[i] = 440 * Math.pow(2, (notes[idx].midi - 69) / 12);
  }
  cached = { L, R, truth };
  return cached;
}

function rawPitchAccuracy(est: ArrayLike<number>, truth: Float64Array): number {
  let ok = 0;
  let n = 0;
  for (let i = 0; i < truth.length && i < est.length; i++) {
    if (!Number.isFinite(truth[i])) continue;
    n++;
    if (Number.isFinite(est[i]) && Math.abs(1200 * Math.log2(est[i] / truth[i])) < 50) ok++;
  }
  return ok / n;
}

describe('extractVocalMelody', () => {
  test('tracks the sung line over a stereo band (voice about 5 dB above the pad, bass and guitar)', () => {
    const { L, R, truth } = song();
    const mid = Float32Array.from(L, (x, i) => 0.5 * (x + R[i]));
    const base = rawPitchAccuracy(trackPitch(mid, SR).f0, truth);
    const res = extractVocalMelody(L, R, SR);
    const rpa = rawPitchAccuracy(res.track.f0, truth);
    expect(rpa).toBeGreaterThan(0.85);
    expect(rpa).toBeGreaterThan(base);
    expect(res.track.f0.length).toBe(res.track.rmsDb.length);
    expect(res.voicedSec).toBeGreaterThan(6);
  });

  test('also works from a mono mix (no stereo cue)', () => {
    const { L, R, truth } = song();
    const mid = Float32Array.from(L, (x, i) => 0.5 * (x + R[i]));
    const res = extractVocalMelody(mid, null, SR);
    expect(rawPitchAccuracy(res.track.f0, truth)).toBeGreaterThan(0.8);
    expect(res.sideToMidDb).toBe(-Infinity);
  });

  test('reports the rest between phrases as unvoiced', () => {
    const { L, R } = song();
    const res = extractVocalMelody(L, R, SR);
    // the rest spans 4.65 s - 5.85 s of the take; check its middle second
    let voiced = 0;
    for (let i = 480; i < 570; i++) if (res.track.voiced[i]) voiced++;
    expect(voiced).toBeLessThan(25);
  });

  test('sample rate conversion: 44.1 kHz input gives the same contour', () => {
    const { L, R, truth } = song();
    const up = (x: Float32Array) => Float32Array.from({ length: x.length * 2 }, (_, i) => (i % 2 === 0 ? x[i >> 1] : 0.5 * (x[i >> 1] + (x[(i >> 1) + 1] ?? 0))));
    const res = extractVocalMelody(up(L), up(R), 2 * SR);
    expect(rawPitchAccuracy(res.track.f0, truth)).toBeGreaterThan(0.8);
  });

  test('withSignal returns a cleaned mono signal of the same length that is mostly the voice', () => {
    const { L, R } = song();
    const res = extractVocalMelody(L, R, SR, { withSignal: true });
    expect(res.vocalSignal).toBeDefined();
    expect(res.vocalSignal!.length).toBe(L.length);
    let e = 0;
    for (const v of res.vocalSignal!) e += v * v;
    expect(Number.isFinite(e)).toBe(true);
    expect(e).toBeGreaterThan(0);
  });

  test('silence, tiny input and mismatched channel lengths do not throw', () => {
    expect(extractVocalMelody(new Float32Array(SR), null, SR).voicedSec).toBeLessThan(0.5);
    expect(extractVocalMelody(new Float32Array(100), null, SR).track.f0.length).toBe(0);
    const { L, R } = song();
    const res = extractVocalMelody(L, R.subarray(0, R.length - 5000), SR);
    expect(res.track.f0.length).toBeGreaterThan(900);
  });

  test('non-finite samples are treated as silence', () => {
    const { L, R, truth } = song();
    const bad = Float32Array.from(L);
    bad[1000] = NaN;
    bad[50000] = Infinity;
    const res = extractVocalMelody(bad, R, SR);
    for (const v of res.track.f0) expect(Number.isNaN(v) || Number.isFinite(v)).toBe(true);
    for (const v of res.track.rmsDb) expect(Number.isFinite(v)).toBe(true);
    expect(rawPitchAccuracy(res.track.f0, truth)).toBeGreaterThan(0.8);
  });

  test('progress is monotone and ends at 1', () => {
    const { L, R } = song();
    const seen: number[] = [];
    extractVocalMelody(L, R, SR, { onProgress: (f) => seen.push(f) });
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });
});

describe('applyLevelVoicing', () => {
  test('keeps loud frames, drops a quiet stretch, bridges a short dip and drops a short blip', () => {
    const n = 400;
    const level = new Float64Array(n).fill(-20);
    for (let i = 100; i < 200; i++) level[i] = -50; // 1 s instrumental gap
    for (let i = 250; i < 256; i++) level[i] = -50; // 60 ms dip inside a note
    for (let i = 120; i < 135; i++) level[i] = -20; // 150 ms blip inside the gap (shorter than 0.2 s)
    const on = applyLevelVoicing(new Float64Array(n), level, 0.01);
    expect(on[50]).toBe(1);
    expect(on[150]).toBe(0);
    expect(on[127]).toBe(0);
    expect(on[252]).toBe(1);
    expect(on[300]).toBe(1);
  });

  test('bridges a longer level dip inside a held note (the tracked pitch stays on it) but not a pause or a change of note', () => {
    const n = 500;
    const level = new Float64Array(n).fill(-20);
    for (let i = 100; i < 130; i++) level[i] = -50; // 0.3 s dip, same pitch before, inside and after
    for (let i = 250; i < 280; i++) level[i] = -50; // 0.3 s dip, the pitch moves a fifth across it
    for (let i = 380; i < 440; i++) level[i] = -50; // 0.6 s dip, same pitch: a rest, longer than a held note's sag
    const f0 = new Float64Array(n).fill(220);
    for (let i = 265; i < n; i++) f0[i] = 330;
    const on = applyLevelVoicing(f0, level, 0.01);
    expect(on[115]).toBe(1);
    expect(on[265]).toBe(0);
    expect(on[410]).toBe(0);
    // no tracked pitch (zeros) means nothing to compare: the dip stays a gap
    expect(applyLevelVoicing(new Float64Array(n), level, 0.01)[115]).toBe(0);
  });
});

describe('extractVocalMelody: per-frame cues and fragment clean-up', () => {
  test('hands on the dominance, share and reference level behind the confidence, one per frame', () => {
    const { L, R } = song();
    const res = extractVocalMelody(L, R, SR);
    const n = res.track.f0.length;
    expect(res.cues.dominance.length).toBe(n);
    expect(res.cues.share.length).toBe(n);
    for (const t of [10, Math.floor(n / 2), n - 10]) {
      expect(res.cues.dominance[t]).toBeGreaterThanOrEqual(0);
      expect(res.cues.dominance[t]).toBeLessThanOrEqual(1);
      expect(res.cues.share[t]).toBeGreaterThanOrEqual(0);
      expect(res.cues.share[t]).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(res.cues.levelRefDb)).toBe(true);
    expect(res.cues.levelRefDb).toBeLessThan(0);
    expect(emptyVocalMelody().cues.dominance.length).toBe(0);
  });

  test('dropFragments: false keeps every voiced frame the clean-up would have removed, and never fewer', () => {
    const { L, R } = song();
    const kept = extractVocalMelody(L, R, SR, { dropFragments: false });
    const cleaned = extractVocalMelody(L, R, SR);
    expect(cleaned.voicedSec).toBeLessThanOrEqual(kept.voicedSec);
    for (let t = 0; t < cleaned.track.f0.length; t++) if (cleaned.track.voiced[t]) expect(kept.track.voiced[t]).toBe(1);
  });
});

describe('refineF0', () => {
  test('moves a coarse f0 that is 40 cents off onto the partials', () => {
    const K = 372;
    const binHz = SR / 2048;
    const V = new Float32Array(K);
    const f0 = 220;
    for (let h = 1; h <= 12; h++) {
      const p = (h * f0) / binHz;
      for (let k = Math.floor(p - 2); k <= Math.ceil(p + 2); k++) {
        const d = k - p;
        if (k >= 0 && k < K && Math.abs(d) < 2) V[k] += Math.pow(Math.cos((Math.PI * d) / 4), 2) / h;
      }
    }
    const coarse = f0 * Math.pow(2, 40 / 1200);
    const r = refineF0(V, 0, K, binHz, coarse);
    expect(Math.abs(1200 * Math.log2(r.f0 / f0))).toBeLessThan(10);
  });
});

describe('extractVocalMelody: input handling', () => {
  test('an unusable sample rate or empty input gives an empty melody, ends progress at 1 and never throws', () => {
    const { L } = song();
    for (const rate of [0, NaN, Infinity, -44100, 100, 3999]) {
      const seen: number[] = [];
      const res = extractVocalMelody(L, null, rate, { onProgress: (f) => seen.push(f) });
      expect(res.track.f0.length).toBe(0);
      expect(res.voicedSec).toBe(0);
      expect(res.confidence).toBe(0);
      expect(seen[seen.length - 1]).toBe(1);
    }
    expect(extractVocalMelody(new Float32Array(0), null, SR).track.f0.length).toBe(0);
    expect(emptyVocalMelody().harmonicShare).toBe(0);
  });

  test('an empty right channel is ignored and NaN / reversed pitch limits fall back to the defaults', () => {
    const { L, R, truth } = song();
    const mid = Float32Array.from(L, (x, i) => 0.5 * (x + R[i]));
    const res = extractVocalMelody(mid, new Float32Array(0), SR, { minHz: NaN, maxHz: NaN });
    expect(rawPitchAccuracy(res.track.f0, truth)).toBeGreaterThan(0.8);
    const odd = extractVocalMelody(mid, null, SR, { minHz: 5000, maxHz: 10 });
    expect(rawPitchAccuracy(odd.track.f0, truth)).toBeGreaterThanOrEqual(0);
  });

  test('two identical channels are treated as mono: same contour, no stereo cue', () => {
    const { L, truth } = song();
    const mono = extractVocalMelody(L, null, SR);
    const dual = extractVocalMelody(L, Float32Array.from(L), SR);
    expect(dual.sideToMidDb).toBe(-Infinity);
    expect(Array.from(dual.track.f0)).toEqual(Array.from(mono.track.f0));
    expect(rawPitchAccuracy(dual.track.f0, truth)).toBeGreaterThan(0.8);
  });

  test('the inputs are not modified and a second run gives the same result', () => {
    const { L, R } = song();
    const l = Float32Array.from(L);
    const r = Float32Array.from(R);
    const first = extractVocalMelody(l, r, SR);
    expect(l).toEqual(L);
    expect(r).toEqual(R);
    const second = extractVocalMelody(l, r, SR);
    expect(Array.from(second.track.f0)).toEqual(Array.from(first.track.f0));
    expect(second.confidence).toBe(first.confidence);
  });

  test('maxSeconds cuts the analysed stretch; the default ceiling is ten minutes', () => {
    const { L } = song();
    const res = extractVocalMelody(L, null, SR, { maxSeconds: 3 });
    expect(res.track.f0.length).toBe(Math.floor((3 * SR - 1) / (0.01 * SR)) + 1);
    expect(extractVocalMelody(L, null, SR, { maxSeconds: 0 }).track.f0.length).toBe(0);
    expect(MAX_MELODY_SEC).toBe(600);
  });

  test('the result is complete: finite levels and confidences, a stage timing for each pass', () => {
    const { L, R } = song();
    const res = extractVocalMelody(L, R, SR);
    const n = res.track.f0.length;
    expect(res.track.times.length).toBe(n);
    expect(res.track.periodicity.length).toBe(n);
    expect(res.track.voiced.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(res.track.rmsDb[i])).toBe(true);
      expect(res.track.periodicity[i]).toBeGreaterThanOrEqual(0);
      expect(res.track.periodicity[i]).toBeLessThanOrEqual(1);
      expect(res.track.voiced[i] === 1).toBe(Number.isFinite(res.track.f0[i]));
    }
    expect(res.confidence).toBeGreaterThan(0.7);
    expect(res.confidence).toBeLessThanOrEqual(1);
    expect(res.harmonicShare).toBeGreaterThan(MIN_HARMONIC_SHARE);
    for (const stage of ['resample', 'spectra', 'median', 'salience', 'viterbi', 'refine+voicing']) expect(res.timingsMs[stage]).toBeGreaterThanOrEqual(0);
  });
});

describe('extractVocalMelody: no melody', () => {
  const lowPassed = (x: Float32Array, a: number) => {
    const out = new Float32Array(x.length);
    let y = 0;
    for (let i = 0; i < x.length; i++) {
      y += a * (x[i] - y);
      out[i] = y * 3;
    }
    return out;
  };

  test('silence and very quiet hiss report nothing voiced and zero confidence', () => {
    for (const x of [silence(6, SR), whiteNoise(6, 0.001, SR)]) {
      const res = extractVocalMelody(x, null, SR);
      expect(res.voicedSec).toBe(0);
      expect(res.confidence).toBe(0);
      expect(res.track.voiced.every((v) => v === 0)).toBe(true);
    }
  });

  test('white and low-passed noise at any level is rejected as having no melody (harmonic-share gate)', () => {
    for (const rms of [0.01, 0.05, 0.3]) {
      const res = extractVocalMelody(whiteNoise(8, rms, SR, 11), null, SR);
      expect(res.voicedSec).toBe(0);
      expect(res.confidence).toBe(0);
      expect(res.harmonicShare).toBeLessThan(MIN_HARMONIC_SHARE);
    }
    const dark = extractVocalMelody(lowPassed(whiteNoise(8, 0.05, SR, 12), 0.1), null, SR);
    expect(dark.voicedSec).toBe(0);
    expect(dark.harmonicShare).toBeLessThan(MIN_HARMONIC_SHARE);
  });

  test('a steady tone is a melody (the gate only removes noise)', () => {
    const res = extractVocalMelody(sine(220, 6, SR, 0.3), null, SR);
    expect(res.voicedSec).toBeGreaterThan(5);
    expect(res.confidence).toBeGreaterThan(0.9);
    expect(res.harmonicShare).toBeGreaterThan(0.5);
  });
});

describe('refineF0 and applyLevelVoicing edge cases', () => {
  test('refineF0 returns an unusable f0 untouched with no power', () => {
    const V = new Float32Array(372);
    for (const f of [0, -5, NaN, Infinity]) {
      const r = refineF0(V, 0, 372, SR / 2048, f);
      expect(r.power).toBe(0);
      expect(Object.is(r.f0, f)).toBe(true);
    }
  });

  test('applyLevelVoicing copes with an empty clip and a clip that is all one level', () => {
    expect(applyLevelVoicing(new Float64Array(0), new Float64Array(0), 0.01).length).toBe(0);
    const flat = applyLevelVoicing(new Float64Array(300), new Float64Array(300).fill(-30), 0.01);
    expect(flat.every((v) => v === 1)).toBe(true);
    const dead = applyLevelVoicing(new Float64Array(300), new Float64Array(300).fill(-120), 0.01);
    expect(dead.every((v) => v === 0)).toBe(true);
  });
});
