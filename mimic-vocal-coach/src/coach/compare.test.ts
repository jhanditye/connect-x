import { describe, expect, it } from 'vitest';
import { makeFakeAnalysis, makeFakeProfile } from '../testing/fixtures';
import type { SingerProfile, StyleKey, StyleVector, TargetBand, VoiceAnalysis } from '../types';
import { compareToProfile, directionFor, scoreDimension } from './compare';
import { SINGERS } from './profiles';

const BAND: TargetBand = { ideal: 0.5, low: 0.4, high: 0.7, tolerance: 0.3, weight: 1 };

function idealStyle(p: SingerProfile): Partial<StyleVector> {
  const out: Partial<StyleVector> = {};
  for (const [k, b] of Object.entries(p.targets) as [StyleKey, TargetBand][]) out[k] = b.ideal;
  return out;
}

/** Each targeted dimension pushed well past the band edge furthest from the ideal. */
function oppositeStyle(p: SingerProfile): Partial<StyleVector> {
  const out: Partial<StyleVector> = {};
  for (const [k, b] of Object.entries(p.targets) as [StyleKey, TargetBand][]) {
    const goUp = b.ideal - b.low < b.high - b.ideal || b.low <= 0;
    out[k] = goUp ? b.high + 1.2 * b.tolerance : b.low - 1.2 * b.tolerance;
  }
  return out;
}

function withPitch(a: VoiceAnalysis, pitch: Partial<VoiceAnalysis['pitch']>): VoiceAnalysis {
  return { ...a, pitch: { ...a.pitch, ...pitch } };
}

describe('scoreDimension', () => {
  it('returns NaN for unmeasured values so callers can skip them', () => {
    expect(scoreDimension(null, BAND)).toBeNaN();
    expect(scoreDimension(NaN, BAND)).toBeNaN();
    expect(scoreDimension(Infinity, BAND)).toBeNaN();
  });

  it('scores 100 at the ideal and 80 at each band edge, linearly in between', () => {
    expect(scoreDimension(0.5, BAND)).toBe(100);
    expect(scoreDimension(0.4, BAND)).toBeCloseTo(80, 10);
    expect(scoreDimension(0.7, BAND)).toBeCloseTo(80, 10);
    expect(scoreDimension(0.45, BAND)).toBeCloseTo(90, 10);
    expect(scoreDimension(0.6, BAND)).toBeCloseTo(90, 10);
  });

  it('falls from 80 to 0 across the tolerance outside the band', () => {
    expect(scoreDimension(0.25, BAND)).toBeCloseTo(40, 10);
    expect(scoreDimension(0.85, BAND)).toBeCloseTo(40, 10);
    expect(scoreDimension(0.1, BAND)).toBeCloseTo(0, 10);
    expect(scoreDimension(1.0, BAND)).toBeCloseTo(0, 10);
    expect(scoreDimension(-5, BAND)).toBe(0);
  });

  it('handles an ideal sitting on a band edge', () => {
    const edge: TargetBand = { ideal: 0, low: 0, high: 15, tolerance: 25, weight: 1 };
    expect(scoreDimension(0, edge)).toBe(100);
    expect(scoreDimension(7.5, edge)).toBeCloseTo(90, 10);
    expect(scoreDimension(15, edge)).toBeCloseTo(80, 10);
    expect(scoreDimension(-1, edge)).toBeCloseTo(80 * (1 - 1 / 25), 10);
    const top: TargetBand = { ideal: 1, low: 0.6, high: 1, tolerance: 0.3, weight: 1 };
    expect(scoreDimension(1, top)).toBe(100);
    expect(scoreDimension(0.6, top)).toBeCloseTo(80, 10);
  });

  it('clamps an ideal outside the band and survives zero tolerance', () => {
    const odd: TargetBand = { ideal: 2, low: 0, high: 1, tolerance: 0, weight: 1 };
    expect(scoreDimension(1, odd)).toBe(100);
    expect(scoreDimension(0, odd)).toBeCloseTo(80, 10);
    expect(scoreDimension(1.01, odd)).toBe(0);
  });

  it('is continuous and falls monotonically away from the ideal', () => {
    const at = (i: number) => i / 1000 - 0.5;
    let prev = scoreDimension(at(0), BAND);
    for (let i = 1; i <= 2000; i++) {
      const v = at(i);
      const s = scoreDimension(v, BAND);
      expect(Math.abs(s - prev)).toBeLessThan(1);
      if (v <= BAND.ideal) expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      else if (at(i - 1) >= BAND.ideal) expect(s).toBeLessThanOrEqual(prev + 1e-9);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      prev = s;
    }
  });
});

describe('directionFor', () => {
  it('says more below, less above, ok inside, unknown for null', () => {
    expect(directionFor(0.3, BAND)).toBe('more');
    expect(directionFor(0.8, BAND)).toBe('less');
    expect(directionFor(0.4, BAND)).toBe('ok');
    expect(directionFor(null, BAND)).toBe('unknown');
  });
});

describe('compareToProfile', () => {
  it('scores a take at a profile\'s ideals above 90 for that profile and lower for the others', () => {
    for (const p of SINGERS) {
      const a = makeFakeAnalysis(idealStyle(p));
      const own = compareToProfile(a, p).overall;
      expect(own, p.id).toBeGreaterThan(90);
      for (const other of SINGERS.filter((o) => o !== p)) {
        const theirs = compareToProfile(a, other).overall;
        expect(theirs, `${p.id} ideals vs ${other.id}`).toBeLessThan(own);
        // The profiles are distinct enough that one singer's ideal is not "very close" to another.
        expect(theirs, `${p.id} ideals vs ${other.id}`).toBeLessThan(85);
      }
    }
  });

  it('scores opposite extremes below 50', () => {
    for (const p of SINGERS) {
      expect(compareToProfile(makeFakeAnalysis(oppositeStyle(p)), p).overall, p.id).toBeLessThan(50);
    }
    // A pressed, bright, raspy, chest-heavy, pushed take is far from Daniel and Jalen.
    const belter = makeFakeAnalysis({
      breathiness: 0.1,
      brightness: 0.9,
      rasp: 0.55,
      vibratoPresence: 0,
      chestInUpperRange: 0.9,
      mixInUpperRange: 0.1,
      headInUpperRange: 0,
      loudnessClimbDbPerSemitone: 2,
      softOnsetRatio: 0,
      flipsPerMinute: 0,
      dynamicRangeDb: 30,
    });
    expect(compareToProfile(belter, SINGERS[1]).overall).toBeLessThan(50);
    expect(compareToProfile(belter, SINGERS[2]).overall).toBeLessThan(50);
  });

  it('returns one result per targeted key with direction, label and summary', () => {
    const p = SINGERS[1];
    const c = compareToProfile(makeFakeAnalysis(), p);
    expect(c.profileId).toBe(p.id);
    expect(c.dimensions.map((d) => d.key).sort()).toEqual(Object.keys(p.targets).sort());
    for (const d of c.dimensions) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.summary.length).toBeGreaterThan(10);
      expect(d.target).toBe(p.targets[d.key]);
      expect(Number.isInteger(d.score)).toBe(true);
    }
    const breath = c.dimensions.find((d) => d.key === 'breathiness')!;
    expect(breath.direction).toBe('more'); // 0.42 is clearer than Daniel's 0.55-0.82 band
    expect(breath.summary).toContain("Daniel's");
    expect(breath.summary).toContain('0.42');
    expect(breath.summary).toContain('0.68');
    const chest = c.dimensions.find((d) => d.key === 'chestInUpperRange')!;
    expect(chest.direction).toBe('less');
    expect(chest.summary).toContain('55%');
    const rate = c.dimensions.find((d) => d.key === 'vibratoRateHz')!;
    expect(rate.direction).toBe('ok');
    expect(rate.summary).toMatch(/5\.4 Hz/);
  });

  it('marks null values unknown, scores them 0 and leaves them out of the overall', () => {
    const p = makeFakeProfile();
    const a = makeFakeAnalysis({ mixInUpperRange: null });
    const c = compareToProfile(a, p);
    const mix = c.dimensions.find((d) => d.key === 'mixInUpperRange')!;
    expect(mix.value).toBeNull();
    expect(mix.direction).toBe('unknown');
    expect(mix.score).toBe(0);
    expect(mix.summary).toMatch(/Not measured/);
    expect(mix.summary).toMatch(/passaggio \(from D4\)/);
    const withoutMix = makeFakeProfile({ targets: { ...p.targets, mixInUpperRange: undefined } });
    expect(c.overall).toBe(compareToProfile(a, withoutMix).overall);
  });

  it('computes the overall as the weighted mean of measured dimensions', () => {
    const p = makeFakeProfile();
    const a = makeFakeAnalysis({ breathiness: 0.5, brightness: 0.2, mixInUpperRange: 0.5, pitchAccuracyCents: 5 });
    // breathiness 100 (w .8), brightness 80*(1-0.3/0.3)=0 (w .6), mix 100 (w 1), pitch 100 (w .5)
    const expected = Math.round((0.8 * 100 + 0.6 * 0 + 1 * 100 + 0.5 * 100) / (0.8 + 0.6 + 1 + 0.5));
    expect(compareToProfile(a, p).overall).toBe(expected);
  });

  it('returns 0 overall when nothing was measured', () => {
    const nulls = Object.fromEntries(Object.keys(makeFakeAnalysis().style).map((k) => [k, null])) as Partial<StyleVector>;
    const c = compareToProfile(makeFakeAnalysis(nulls), SINGERS[0]);
    expect(c.overall).toBe(0);
    expect(c.dimensions.every((d) => d.direction === 'unknown')).toBe(true);
  });

  it('suggests a transposition from the tessitura centres and explains it with note names', () => {
    const a = makeFakeAnalysis(); // tessitura 59-65, centre 62 (D4)
    const shawn = compareToProfile(a, SINGERS[0]); // 52-66, centre 59
    expect(shawn.suggestedTransposeSemitones).toBe(3);
    expect(shawn.rangeNote).toContain('B3');
    expect(shawn.rangeNote).toContain('F4');
    expect(shawn.rangeNote).toMatch(/3 semitones .*higher/);
    const daniel = compareToProfile(a, SINGERS[1]); // 55-67, centre 61
    expect(daniel.suggestedTransposeSemitones).toBe(1);
    expect(daniel.rangeNote).toMatch(/should suit you/);

    const low = withPitch(a, { tessituraLowMidi: 45, tessituraHighMidi: 52 }); // centre 48.5
    const jalen = compareToProfile(low, SINGERS[2]); // centre 65.5
    expect(jalen.suggestedTransposeSemitones).toBe(-17);
    expect(jalen.rangeNote).toMatch(/lower/);
    expect(jalen.rangeNote).toContain('A2');
    const octave = compareToProfile(withPitch(a, { tessituraLowMidi: 48, tessituraHighMidi: 59 }), SINGERS[2]);
    expect(octave.suggestedTransposeSemitones).toBe(-12);
    expect(octave.rangeNote).toMatch(/octave/);
  });

  it('falls back to the median, and to 0 without pitch data', () => {
    const a = makeFakeAnalysis();
    const median = withPitch(a, { tessituraLowMidi: null, tessituraHighMidi: null, medianMidi: 55 });
    expect(compareToProfile(median, SINGERS[0]).suggestedTransposeSemitones).toBe(-4);
    const none = withPitch(a, { tessituraLowMidi: null, tessituraHighMidi: null, medianMidi: null, lowMidi: null, highMidi: null });
    const c = compareToProfile(none, SINGERS[0]);
    expect(c.suggestedTransposeSemitones).toBe(0);
    expect(c.rangeNote).toMatch(/not enough pitched singing/);
  });

  it('talks about "the reference" for reference-clip profiles', () => {
    const ref: SingerProfile = { ...SINGERS[1], id: 'reference', name: 'my-clip.wav', source: 'reference' };
    const c = compareToProfile(makeFakeAnalysis(), ref);
    const breath = c.dimensions.find((d) => d.key === 'breathiness')!;
    expect(breath.summary).toContain("the reference's");
    expect(c.rangeNote).toContain('the reference');
    expect(c.profileId).toBe('reference');
  });
});
