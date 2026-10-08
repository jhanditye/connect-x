import { describe, expect, it } from 'vitest';
import { compareToReference, referenceUsability } from '../coach/reference';
import { isScoreable } from '../coach/compare';
import { resample } from '../dsp/resample';
import { concat, silence, synthMelody, whiteNoise } from '../testing/synth';
import type { AnalysisIssue, VoiceAnalysis } from '../types';
import { analyzeTake } from './analyze';
import { analyzeMix, leadExtractionOf, MIX_NOTE, MIX_RELIABLE } from './mixMode';

const SR = 22050;
const OPTS = { voiceType: 'tenor' as const };

/** Additive oscillator for the band (1/h^1.3 partials). */
function osc(f0: number, n: number, amp: number, phase: number): Float32Array {
  const out = new Float32Array(n);
  for (let h = 1; h <= 14 && h * f0 < 0.45 * SR; h++) {
    const a = amp / Math.pow(h, 1.3);
    const w = (2 * Math.PI * h * f0) / SR;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin(w * i + phase * h);
  }
  return out;
}

/** Stereo band: a decorrelated chord pad and a centred bass. */
function band(seconds: number): { L: Float32Array; R: Float32Array } {
  const n = Math.round(seconds * SR);
  const chord = (channel: number) => {
    const out = new Float32Array(n);
    [130.81, 164.81, 196, 261.63].forEach((f, k) => {
      const t = osc(f * (1 + 0.0007 * (k + 3 * channel)), n, 0.07, 1.7 * (k + 1) * (channel + 1));
      for (let i = 0; i < n; i++) out[i] += t[i];
    });
    return out;
  };
  const padL = chord(0);
  const padR = chord(1);
  const bass = osc(55, n, 0.2, 0.3);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = padL[i] + bass[i];
    R[i] = padR[i] + bass[i];
  }
  return { L, R };
}

const phraseNotes = (shift: number) => [57, 60, 64, 62, 60, 57].map((m) => ({ midi: m + shift, durSec: 0.7 }));
const sing = (shift: number, seed: number) =>
  synthMelody(phraseNotes(shift), { sampleRate: SR, seed, amplitude: 0.35, vibrato: { rateHz: 5.5, extentCents: 25, delaySec: 0.2 }, jitter: 0.002, vowel: 'a' });

// Reference: two phrases (4.2 s each) over a band; 11 s in all, 8.4 s of lead vocal.
const ref1 = sing(0, 3);
const ref2 = sing(2, 4);
const vocal = concat(silence(0.5, SR), ref1, silence(1.0, SR), ref2, silence(0.5, SR));
const { L, R } = band(vocal.length / SR);
for (let i = 0; i < vocal.length; i++) {
  L[i] += vocal[i];
  R[i] += vocal[i];
}
const mono = Float32Array.from(L, (x, i) => 0.5 * (x + R[i]));

function expectWellFormed(a: VoiceAnalysis): void {
  expect(a.version).toBe(1);
  expect(a.hopSec).toBe(0.01);
  expect(a.sampleRate).toBe(22050);
  expect(a.voicedRatio).toBeGreaterThanOrEqual(0);
  expect(a.voicedRatio).toBeLessThanOrEqual(1);
  expect(new Set(a.issues).size).toBe(a.issues.length);
  for (const v of Object.values(a.style)) expect(v === null || Number.isFinite(v)).toBe(true);
  for (const f of a.frames) {
    expect(Number.isFinite(f.rmsDb)).toBe(true);
    expect(f.voiced === Number.isFinite(f.f0)).toBe(true);
  }
  // Summary data survives a JSON round trip (NaN only lives in the per-frame arrays and quality.snrDb, which has no SNR to give).
  const summary = JSON.parse(JSON.stringify({ ...a, frames: [], quality: { ...a.quality, snrDb: null } })) as VoiceAnalysis;
  expect(summary.style).toEqual(a.style);
  expect(summary.pitch).toEqual(a.pitch);
}

describe('mix mode end to end', () => {
  it('today: the solo analysis of the full mix is refused or follows the band', () => {
    const a = analyzeTake(mono, SR, OPTS);
    expect(a.issues.includes('accompaniment') || (a.pitch.medianMidi ?? 99) < 55).toBe(true);
    expect(a.mode).toBeUndefined();
  });

  it('pitch contour follows the voice, spectral measures are hidden, vibrato and phrases are kept', () => {
    const a = analyzeMix(L, R, SR, OPTS);
    expectWellFormed(a);
    expect(a.mode).toBe('mix');
    expect(a.phrases.length).toBe(2);
    expect(a.pitch.medianMidi).toBeGreaterThan(57);
    expect(a.pitch.medianMidi).toBeLessThan(66);
    expect(a.voicedSec).toBeGreaterThan(6);
    expect(a.style.breathiness).toBeNull();
    expect(a.style.brightness).toBeNull();
    expect(a.style.rasp).toBeNull();
    expect(a.style.chestInUpperRange).toBeNull();
    expect(a.style.vibratoPresence).not.toBeNull();
    expect(a.warnings).toContain(MIX_NOTE);
    expect(a.warnings.join(' ')).toContain('full song mix');
  });

  it('every style entry that does not survive a mix is null, and only those', () => {
    const a = analyzeMix(L, R, SR, OPTS);
    for (const [key, value] of Object.entries(a.style)) {
      if (!MIX_RELIABLE.includes(key as keyof typeof a.style)) expect(value, key).toBeNull();
    }
    expect(a.style.vibratoRateHz).toBeGreaterThan(4);
    expect(a.style.vibratoRateHz).toBeLessThan(7);
    expect(a.tone).toEqual({ h1h2Db: null, alphaRatioDb: null, centroidHz: null, tiltDbPerOct: null, cppDb: null, hnrDb: null });
    expect(a.registerShares).toEqual({ chest: 0, mix: 0, head: 0 });
    expect(a.onsets).toEqual([]);
    expect(a.frames.every((f) => f.register === null && Number.isNaN(f.h1h2Db) && Number.isNaN(f.cppDb) && Number.isNaN(f.hnrDb))).toBe(true);
  });

  it('carries the lead-vocal confidence, the stereo cue and the accompaniment marker', () => {
    const stereo = analyzeMix(L, R, SR, OPTS);
    const le = leadExtractionOf(stereo);
    expect(le).not.toBeNull();
    expect(le!.confidence).toBeGreaterThan(0.8);
    expect(le!.confidence).toBeLessThanOrEqual(1);
    expect(le!.sideToMidDb).toBeLessThan(0);
    expect(Number.isFinite(le!.sideToMidDb!)).toBe(true);
    expect(stereo.issues).toContain('accompaniment');
    expect(stereo.issues).not.toContain('too-little-singing');
    const monoRun = analyzeMix(mono, null, SR, OPTS);
    expect(leadExtractionOf(monoRun)!.sideToMidDb).toBeNull();
    expect(leadExtractionOf(analyzeTake(mono, SR, OPTS))).toBeNull();
    // it survives a structured clone and a JSON round trip (what the worker and the stores do)
    expect(leadExtractionOf(structuredClone(stereo))).toEqual(le);
    expect(leadExtractionOf(JSON.parse(JSON.stringify(stereo)))).toEqual(le);
  });

  it('no existing gate lets a mix analysis through as a score, a target or a measured clip', () => {
    const a = analyzeMix(L, R, SR, OPTS);
    expect(isScoreable(a)).toBe(false);
    const asTarget = referenceUsability(a);
    expect(asTarget.usable).toBe(false);
    expect(asTarget.reason).toMatch(/full song/);
    expect(asTarget.reason).toMatch(/phrase-by-phrase/);
    expect(referenceUsability(a, 'comparison')).toEqual({ usable: true, reason: null });
  });

  it('phrase-by-phrase comparison of a solo take against the mix-derived reference', () => {
    const ref = analyzeMix(L, R, SR, OPTS);
    // the user sings the same two phrases an octave lower, a little slower
    const slow = (notes: { midi: number; durSec: number }[]) => notes.map((n) => ({ ...n, midi: n.midi - 12, durSec: n.durSec * 1.05 }));
    const take = (shift: number, seed: number) =>
      synthMelody(slow(phraseNotes(shift)), { sampleRate: SR, seed, amplitude: 0.35, vibrato: { rateHz: 5.5, extentCents: 25, delaySec: 0.2 }, vowel: 'a' });
    const user = concat(silence(0.4, SR), take(0, 8), silence(1.2, SR), take(2, 9), silence(0.4, SR));
    const u = analyzeTake(user, SR, { voiceType: 'baritone' });
    const cmp = compareToReference(u, ref);
    expect(cmp.transposeSemitones).toBe(-12);
    expect(cmp.meanAbsCents).toBeLessThan(40);
    expect(cmp.withinFiftyCents).toBeGreaterThan(0.7);
    expect(cmp.segments.length).toBe(2);
  });
});

describe('analyzeTake with mode mix', () => {
  it('takes the mono mix at any sample rate and gives the same kind of analysis', () => {
    const a = analyzeTake(mono, SR, { ...OPTS, mode: 'mix' });
    expectWellFormed(a);
    expect(a.mode).toBe('mix');
    expect(a.phrases.length).toBe(2);
    expect(a.durationSec).toBeCloseTo(mono.length / SR, 6);
    expect(a.style.breathiness).toBeNull();
    expect(a.style.vibratoPresence).not.toBeNull();
    expect(leadExtractionOf(a)!.confidence).toBeGreaterThan(0.8);
    expect(a.quality.clippingRatio).toBe(0);

    const hi = analyzeTake(resample(mono, SR, 44100), 44100, { ...OPTS, mode: 'mix' });
    expect(hi.mode).toBe('mix');
    expect(hi.phrases.length).toBe(2);
    expect(Math.abs((hi.pitch.medianMidi ?? 0) - (a.pitch.medianMidi ?? 99))).toBeLessThan(0.5);
    expect(hi.durationSec).toBeCloseTo(mono.length / SR, 2);
  });

  it('an explicit solo mode is exactly the default', () => {
    const x = concat(silence(0.3, SR), sing(0, 3), silence(0.3, SR));
    const a = analyzeTake(x, SR, OPTS);
    const b = analyzeTake(x, SR, { ...OPTS, mode: 'solo' });
    expect(b).toEqual(a);
    expect('mode' in a).toBe(false);
  });

  it('progress increases and ends at 1', () => {
    const seen: number[] = [];
    analyzeTake(mono, SR, { ...OPTS, mode: 'mix' }, (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('does not modify the caller\'s samples and tolerates invalid samples', () => {
    const x = Float32Array.from(mono);
    x[100] = NaN;
    x[5000] = Infinity;
    const before = Float32Array.from(x);
    const a = analyzeTake(x, SR, { ...OPTS, mode: 'mix' });
    expect(x).toEqual(before);
    expect(a.warnings.some((w) => /invalid and were treated as silence/.test(w))).toBe(true);
    expect(a.phrases.length).toBe(2);
  });

  it('empty, invalid and all-NaN input give a mix-mode answer with a reason, not an exception', () => {
    for (const [samples, rate] of [
      [new Float32Array(0), 44100],
      [new Float32Array(1000).fill(NaN), SR],
      [mono, NaN],
      [mono, 100],
    ] as [Float32Array, number][]) {
      const a = analyzeTake(samples, rate, { ...OPTS, mode: 'mix' });
      expect(a.mode).toBe('mix');
      expect(a.issues).toContain('too-little-singing');
      expect(a.warnings.length).toBeGreaterThan(0);
      expect(a.frames).toHaveLength(0);
    }
  });

  it('inputs shorter than the extractor window give an empty mix analysis', () => {
    for (const len of [1, 10, 300, 2000]) {
      const a = analyzeTake(Float32Array.from({ length: len }, (_, i) => 0.3 * Math.sin(i * 0.1)), SR, { ...OPTS, mode: 'mix' });
      expectWellFormed(a);
      expect(a.mode).toBe('mix');
      expect(a.notes).toHaveLength(0);
      expect(a.issues).toContain('too-little-singing');
    }
  });

  it('silence and noise: nothing sung, a plain reason, no notes, confidence 0', () => {
    for (const x of [silence(5, SR), whiteNoise(5, 0.05, SR)]) {
      const a = analyzeTake(x, SR, { ...OPTS, mode: 'mix' });
      expectWellFormed(a);
      expect(a.voicedSec).toBe(0);
      expect(a.notes).toHaveLength(0);
      expect(a.phrases).toHaveLength(0);
      expect(a.pitch.medianMidi).toBeNull();
      expect(leadExtractionOf(a)!.confidence).toBe(0);
      const issues: AnalysisIssue[] = a.issues;
      expect(issues).toContain('too-little-singing');
      expect(a.warnings.join(' ')).toMatch(/No lead vocal could be followed/);
    }
  });

  it('a few seconds of singing is flagged as too little and says how much was found', () => {
    const x = concat(silence(0.5, SR), synthMelody([{ midi: 57, durSec: 1.5 }, { midi: 60, durSec: 1.5 }], { sampleRate: SR, amplitude: 0.35 }), silence(0.5, SR));
    const a = analyzeTake(x, SR, { ...OPTS, mode: 'mix' });
    expect(a.voicedSec).toBeGreaterThan(1);
    expect(a.voicedSec).toBeLessThan(3);
    expect(a.issues).toContain('too-little-singing');
    expect(a.warnings.join(' ')).toMatch(/Only \d\.\d s of lead vocal/);
    expect(referenceUsability(a, 'comparison').usable).toBe(false);
  });

  it('analyzeMix called directly with an unusable sample rate or no audio answers instead of throwing', () => {
    for (const [samples, rate] of [
      [mono, 0],
      [mono, NaN],
      [new Float32Array(0), SR],
    ] as [Float32Array, number][]) {
      const a = analyzeMix(samples, null, rate, OPTS);
      expectWellFormed(a);
      expect(a.mode).toBe('mix');
      expect(a.durationSec).toBe(0);
      expect(a.issues).toContain('too-little-singing');
      expect(a.warnings).toContain(MIX_NOTE);
    }
  });

  it('a wrong a4Hz falls back to 440 as in the solo pipeline', () => {
    const a = analyzeMix(L, R, SR, { ...OPTS, a4Hz: 9999 });
    const b = analyzeMix(L, R, SR, OPTS);
    expect(a.pitch.medianMidi).toBe(b.pitch.medianMidi);
  });
});
