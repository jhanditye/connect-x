import { describe, expect, it } from 'vitest';
import { resample } from '../dsp/resample';
import { concat, silence, sine, synthMelody, whiteNoise } from '../testing/synth';
import type { VoiceAnalysis } from '../types';
import { analyzeTake, MAX_ANALYSIS_SEC } from './analyze';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };

function phraseAt(sr: number): Float32Array {
  const notes = [55, 57, 59, 62, 64, 62, 59, 57].map((midi) => ({ midi, durSec: 0.45 }));
  const x = synthMelody(notes, { sampleRate: SR, vibrato: { rateHz: 5.5, extentCents: 30, delaySec: 0.2 } });
  return resample(x, SR, sr);
}

function expectWellFormed(a: VoiceAnalysis) {
  expect(a.version).toBe(1);
  expect(a.hopSec).toBe(0.01);
  expect(a.sampleRate).toBe(22050);
  expect(a.voicedRatio).toBeGreaterThanOrEqual(0);
  expect(a.voicedRatio).toBeLessThanOrEqual(1);
  const shares = a.registerShares;
  const sum = shares.chest + shares.mix + shares.head;
  expect(sum === 0 || Math.abs(sum - 1) < 1e-9).toBe(true);
  for (const v of Object.values(a.style)) expect(v === null || Number.isFinite(v)).toBe(true);
  expect(Number.isFinite(a.quality.snrDb)).toBe(true);
  // JSON round trip must not lose summary data (NaN only lives in per-frame arrays).
  const summary = JSON.parse(JSON.stringify({ ...a, frames: [] })) as VoiceAnalysis;
  expect(summary.style).toEqual(a.style);
}

describe('analyzeTake input validation', () => {
  it('returns a warning, not an exception, for empty input', () => {
    const a = analyzeTake(new Float32Array(0), 44100, OPTS);
    expectWellFormed(a);
    expect(a.frames).toHaveLength(0);
    expect(a.warnings[0]).toMatch(/empty/);
    expect(a.passaggio).toEqual({ lowMidi: 62, highMidi: 67 });
  });

  it('handles all-NaN, partly-NaN and invalid sample rates', () => {
    const nan = new Float32Array(1000).fill(NaN);
    expect(analyzeTake(nan, SR, OPTS).warnings[0]).toMatch(/no valid audio/);
    const partly = concat(silence(0.3, SR), synthMelody([{ midi: 57, durSec: 1 }], { sampleRate: SR }), silence(0.3, SR));
    partly[100] = NaN;
    partly[5000] = Infinity;
    const a = analyzeTake(partly, SR, OPTS);
    expectWellFormed(a);
    expect(a.warnings.some((w) => /invalid and were treated as silence/.test(w))).toBe(true);
    expect(a.notes.length).toBe(1);
    for (const rate of [0, NaN, -44100, 100]) {
      const b = analyzeTake(partly, rate, OPTS);
      expect(b.warnings[0]).toMatch(/sample rate/);
      expect(b.frames).toHaveLength(0);
    }
  });

  it('copes with inputs shorter than one analysis window', () => {
    for (const len of [1, 10, 300]) {
      const a = analyzeTake(sine(220, len / SR, SR, 0.3), SR, OPTS);
      expectWellFormed(a);
      expect(a.notes).toHaveLength(0);
    }
  });

  it('does not modify the caller\'s samples', () => {
    const x = concat(silence(0.2, SR), synthMelody([{ midi: 57, durSec: 0.8 }], { sampleRate: SR }));
    for (let i = 0; i < x.length; i++) x[i] += 0.01; // DC offset, which the analysis removes internally
    const before = Float32Array.from(x);
    analyzeTake(x, SR, OPTS);
    expect(x).toEqual(before);
  });

  it('noise and silence produce no notes and a helpful warning', () => {
    for (const x of [silence(3, SR), whiteNoise(3, 0.05, SR)]) {
      const a = analyzeTake(x, SR, OPTS);
      expectWellFormed(a);
      expect(a.notes).toHaveLength(0);
      expect(a.voicedSec).toBeLessThan(0.2);
      expect(a.pitch.medianMidi).toBeNull();
      expect(a.warnings.some((w) => /No clear singing/.test(w))).toBe(true);
    }
  });

  it('trims takes longer than five minutes and says so', () => {
    const sr = 8000;
    const x = new Float32Array(Math.round((MAX_ANALYSIS_SEC + 5) * sr));
    x.set(sine(220, 2, sr, 0.3), sr);
    const a = analyzeTake(x, sr, OPTS);
    expect(a.durationSec).toBe(MAX_ANALYSIS_SEC);
    expect(a.frames.length).toBeLessThanOrEqual(MAX_ANALYSIS_SEC * 100 + 1);
    expect(a.warnings.some((w) => /first 5 minutes/.test(w))).toBe(true);
  }, 30000);
});

describe('analyzeTake results', () => {
  it('gives the same pitch picture at 22.05, 44.1 and 48 kHz', () => {
    const results = [22050, 44100, 48000].map((sr) => analyzeTake(concat(silence(0.3, sr), phraseAt(sr), silence(0.3, sr)), sr, OPTS));
    for (const a of results) {
      expectWellFormed(a);
      expect(a.notes.map((n) => n.nearestMidi)).toEqual([55, 57, 59, 62, 64, 62, 59, 57]);
      expect(a.pitch.lowMidi).toBe(55);
      expect(a.pitch.highMidi).toBe(64);
      expect(Math.abs(a.durationSec - (3.6 + 0.6))).toBeLessThan(0.01);
    }
  });

  it('fills the summary fields', () => {
    const x = concat(silence(0.5, SR), phraseAt(SR), silence(0.4, SR), phraseAt(SR), silence(0.5, SR));
    const a = analyzeTake(x, SR, OPTS);
    expectWellFormed(a);
    expect(a.phrases).toHaveLength(2);
    expect(a.onsets).toHaveLength(2);
    expect(a.voicedSec).toBeGreaterThan(6.5);
    expect(a.voicedSec).toBeLessThan(7.4);
    expect(a.pitch.tessituraLowMidi).toBeLessThanOrEqual(a.pitch.tessituraHighMidi ?? -1);
    expect(a.tone.cppDb).not.toBeNull();
    expect(a.tone.hnrDb).not.toBeNull();
    expect(a.frames.filter((f) => f.voiced).every((f) => f.register !== null)).toBe(true);
    expect(a.style.breathiness).not.toBeNull();
    expect(a.style.brightness).not.toBeNull();
    expect(a.style.dynamicRangeDb).toBeGreaterThan(0);
    expect(a.style.chestInUpperRange).not.toBeNull();
    expect(a.style.loudnessClimbDbPerSemitone).not.toBeNull();
    expect(a.style.pitchAccuracyCents).toBeLessThan(8);
    expect(a.style.agility).toBe(0);
    expect(a.style.flipsPerMinute).toBe(0);
  });

  it('honours the tuning reference', () => {
    const x = concat(silence(0.3, SR), synthMelody([{ midi: 69, durSec: 1.5 }], { sampleRate: SR, a4Hz: 432 }), silence(0.3, SR));
    expect(analyzeTake(x, SR, { voiceType: 'tenor', a4Hz: 432 }).pitch.medianMidi).toBeCloseTo(69, 1);
    expect(analyzeTake(x, SR, { voiceType: 'tenor' }).pitch.medianMidi).toBeCloseTo(68.69, 1);
    expect(analyzeTake(x, SR, { voiceType: 'tenor', a4Hz: 432 }).passaggio).toEqual({ lowMidi: 64, highMidi: 69 });
  });

  it('reports increasing progress ending at 1', () => {
    const seen: number[] = [];
    analyzeTake(concat(silence(0.3, SR), phraseAt(SR)), SR, OPTS, (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[0]).toBeGreaterThanOrEqual(0);
    expect(seen[seen.length - 1]).toBe(1);
    const empty: number[] = [];
    analyzeTake(new Float32Array(0), SR, OPTS, (f) => empty.push(f));
    expect(empty[empty.length - 1]).toBe(1);
  });

  it('analyses a 60 s take at 44.1 kHz in well under 10 s', () => {
    const block = concat(phraseAt(44100), silence(0.4, 44100), phraseAt(44100), silence(0.4, 44100));
    const reps = Math.ceil(60 / (block.length / 44100));
    const x = new Float32Array(60 * 44100);
    for (let r = 0; r < reps; r++) x.set(block.subarray(0, Math.max(0, Math.min(block.length, x.length - r * block.length))), r * block.length);
    const t0 = performance.now();
    const a = analyzeTake(x, 44100, OPTS);
    const ms = performance.now() - t0;
    expect(a.voicedSec).toBeGreaterThan(45);
    expect(ms).toBeLessThan(10000);
  }, 30000);
});
