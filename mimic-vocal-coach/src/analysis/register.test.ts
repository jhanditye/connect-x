import { describe, expect, it } from 'vitest';
import { trackPitch } from '../dsp/pitch';
import { concat, silence, synthMelody, type SynthOptions, type Vowel } from '../testing/synth';
import type { FrameFeatures, RegisterLabel } from '../types';
import { buildFrameTrack } from './features';
import { passaggioFor } from './passaggio';
import {
  CHEST_MAX_SCORE,
  HEAD_MIN_SCORE,
  detectFlips,
  estimateRegisters,
  labelFromScore,
  lightnessScore,
  registerShares,
  smoothLabels,
} from './register';

const SR = 22050;
const BARITONE = passaggioFor('baritone');

const CHEST_LIKE: Partial<SynthOptions> = { tiltDbPerOct: -8 };
const LIGHT_MIX: Partial<SynthOptions> = { tiltDbPerOct: -13, h1BoostDb: 3, breathNoise: 0.1 };
const FALSETTO: Partial<SynthOptions> = { tiltDbPerOct: -20, h1BoostDb: 10, breathNoise: 0.35 };

function sharesFor(voice: Partial<SynthOptions>, midis: number[], vowel: Vowel) {
  const x = concat(
    silence(0.2, SR),
    synthMelody(midis.map((midi) => ({ midi, durSec: 0.5 })), { sampleRate: SR, vowel, ...voice }),
    silence(0.2, SR),
  );
  const track = buildFrameTrack(x, SR, trackPitch(x, SR), 440);
  estimateRegisters(track, BARITONE);
  return registerShares(track.frames);
}

describe('lightnessScore / labelFromScore', () => {
  it('orders chest-like < light mix < falsetto feature combinations', () => {
    const chest = lightnessScore(6, 0, 0);
    const mix = lightnessScore(14, 0.07, 0);
    const head = lightnessScore(28, 0.45, 0);
    expect(chest).toBeLessThan(CHEST_MAX_SCORE);
    expect(mix).toBeGreaterThanOrEqual(CHEST_MAX_SCORE);
    expect(mix).toBeLessThan(HEAD_MIN_SCORE);
    expect(head).toBeGreaterThanOrEqual(HEAD_MIN_SCORE);
    // Softer than the take's median leans lighter, louder leans heavier.
    expect(lightnessScore(14, 0.07, -8)).toBeGreaterThan(mix);
    expect(lightnessScore(14, 0.07, 8)).toBeLessThan(mix);
    expect(lightnessScore(NaN, 0, 0)).toBeNaN();
  });

  it('prefers chest well below the passaggio unless strongly head-like', () => {
    const low = BARITONE.lowMidi - 4;
    expect(labelFromScore(0.4, low, BARITONE)).toBe('chest');
    expect(labelFromScore(0.8, low, BARITONE)).toBe('head');
    expect(labelFromScore(0.4, BARITONE.lowMidi, BARITONE)).toBe('mix');
    expect(labelFromScore(0.05, BARITONE.highMidi, BARITONE)).toBe('chest');
    expect(labelFromScore(0.6, BARITONE.highMidi, BARITONE)).toBe('head');
    expect(labelFromScore(NaN, 60, BARITONE)).toBeNull();
  });
});

describe('smoothLabels', () => {
  it('removes isolated flickers and does not cross unvoiced gaps', () => {
    const c: RegisterLabel = 'chest';
    const h: RegisterLabel = 'head';
    const labels: (RegisterLabel | null)[] = [c, c, c, h, c, c, c, null, h, h, c, h, h];
    const out = smoothLabels(labels, 5);
    expect(out.slice(0, 7)).toEqual([c, c, c, c, c, c, c]);
    expect(out[7]).toBeNull();
    expect(out.slice(8)).toEqual([h, h, h, h, h]);
  });
});

describe('estimateRegisters on synthesised voices (baritone, D4-A4 unless noted)', () => {
  const upper = [62, 64, 67, 69, 67, 64];

  for (const vowel of ['a', 'o'] as Vowel[]) {
    it(`chest-like source reads chest on /${vowel}/`, () => {
      const s = sharesFor(CHEST_LIKE, upper, vowel);
      expect(s.chest).toBeGreaterThan(0.6);
      expect(s.head).toBeLessThan(0.05);
    });

    it(`light mix at/above the passaggio reads mix on /${vowel}/`, () => {
      const s = sharesFor(LIGHT_MIX, upper, vowel);
      expect(s.mix).toBeGreaterThan(0.5);
      expect(s.head).toBeLessThan(0.1);
    });

    it(`falsetto reads head on /${vowel}/`, () => {
      const s = sharesFor(FALSETTO, upper, vowel);
      expect(s.head).toBeGreaterThan(0.8);
      expect(s.chest).toBeLessThan(0.05);
    });
  }

  it('the same light mix well below the passaggio reads chest', () => {
    const s = sharesFor(LIGHT_MIX, [50, 52, 53, 55, 53], 'a');
    expect(s.chest).toBeGreaterThan(0.9);
  });

  it('leaves unvoiced frames unlabelled', () => {
    const x = concat(silence(0.3, SR), synthMelody([{ midi: 57, durSec: 0.6 }], { sampleRate: SR }), silence(0.3, SR));
    const track = buildFrameTrack(x, SR, trackPitch(x, SR), 440);
    estimateRegisters(track, BARITONE);
    for (const f of track.frames) if (!f.voiced) expect(f.register).toBeNull();
    expect(track.frames.some((f) => f.register !== null)).toBe(true);
  });
});

function frame(t: number, midi: number, register: RegisterLabel | null): FrameFeatures {
  const voiced = register !== null;
  return {
    t,
    f0: voiced ? 440 * Math.pow(2, (midi - 69) / 12) : NaN,
    midi: voiced ? midi : NaN,
    voiced,
    periodicity: 0.9,
    rmsDb: -20,
    h1h2Db: 5,
    alphaRatioDb: -15,
    centroidHz: 800,
    tiltDbPerOct: -12,
    cppDb: 20,
    hnrDb: 20,
    register,
  };
}

describe('detectFlips', () => {
  const hop = 0.01;
  function build(segments: { n: number; midi: number; reg: RegisterLabel | null; score: number }[]) {
    const frames: FrameFeatures[] = [];
    const scores: number[] = [];
    for (const s of segments) {
      for (let k = 0; k < s.n; k++) {
        frames.push(frame(frames.length * hop, s.midi, s.reg));
        scores.push(s.reg === null ? NaN : s.score);
      }
    }
    return { frames, scores: Float64Array.from(scores) };
  }

  it('finds a chest -> head switch on a leap', () => {
    const { frames, scores } = build([
      { n: 40, midi: 62, reg: 'chest', score: 0.1 },
      { n: 40, midi: 67, reg: 'head', score: 0.7 },
    ]);
    const flips = detectFlips(frames, scores, hop);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toBeCloseTo(0.4, 5);
  });

  it('ignores a switch without a leap, a small step, or without a jump in lightness', () => {
    const noLeap = build([
      { n: 40, midi: 64, reg: 'mix', score: 0.3 },
      { n: 40, midi: 64, reg: 'head', score: 0.7 },
    ]);
    expect(detectFlips(noLeap.frames, noLeap.scores, hop)).toHaveLength(0);
    const smallStep = build([
      { n: 40, midi: 64, reg: 'chest', score: 0.1 },
      { n: 40, midi: 65, reg: 'head', score: 0.7 },
    ]);
    expect(detectFlips(smallStep.frames, smallStep.scores, hop)).toHaveLength(0);
    const drift = build([
      { n: 40, midi: 64, reg: 'mix', score: 0.45 },
      { n: 40, midi: 67, reg: 'head', score: 0.52 },
    ]);
    expect(detectFlips(drift.frames, drift.scores, hop)).toHaveLength(0);
  });

  it('ignores octave-sized and larger jumps (tracker octave errors, voice <-> instrument switches)', () => {
    for (const top of [72, 73, 74, 81]) {
      const jumpUp = build([
        { n: 40, midi: 60, reg: 'chest', score: 0.1 },
        { n: 40, midi: top, reg: 'head', score: 0.7 },
      ]);
      expect(detectFlips(jumpUp.frames, jumpUp.scores, hop), `rise ${top - 60}`).toHaveLength(0);
    }
    const sixth = build([
      { n: 40, midi: 60, reg: 'chest', score: 0.1 },
      { n: 40, midi: 69, reg: 'head', score: 0.7 },
    ]);
    expect(detectFlips(sixth.frames, sixth.scores, hop)).toHaveLength(1);
  });

  it('counts a flip across a short gap but not after a pause', () => {
    const gap = build([
      { n: 30, midi: 60, reg: 'chest', score: 0.1 },
      { n: 5, midi: 0, reg: null, score: 0 },
      { n: 30, midi: 67, reg: 'head', score: 0.75 },
    ]);
    expect(detectFlips(gap.frames, gap.scores, hop)).toHaveLength(1);
    const pause = build([
      { n: 30, midi: 60, reg: 'chest', score: 0.1 },
      { n: 40, midi: 0, reg: null, score: 0 },
      { n: 30, midi: 67, reg: 'head', score: 0.75 },
    ]);
    expect(detectFlips(pause.frames, pause.scores, hop)).toHaveLength(0);
  });
});

describe('registerShares', () => {
  it('computes shares over labelled frames with an optional filter', () => {
    const frames = [frame(0, 60, 'chest'), frame(0.01, 60, 'chest'), frame(0.02, 65, 'mix'), frame(0.03, 70, 'head'), frame(0.04, 0, null)];
    const all = registerShares(frames);
    expect(all).toEqual({ chest: 0.5, mix: 0.25, head: 0.25, count: 4 });
    const up = registerShares(frames, (f) => f.midi >= 65);
    expect(up.count).toBe(2);
    expect(up.head).toBe(0.5);
    expect(registerShares([])).toEqual({ chest: 0, mix: 0, head: 0, count: 0 });
  });
});
