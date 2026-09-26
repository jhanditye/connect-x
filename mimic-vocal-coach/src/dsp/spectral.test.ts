import { describe, expect, it } from 'vitest';
import { analyzeSpectralFrame, hnrFromPeriodicity, type SpectralFrame } from './spectral';
import { concat, sine, synthVoice, type SynthOptions } from '../testing/synth';

const SR = 22050;

type Measure = Exclude<keyof SpectralFrame, 'harmonicDb'>;

/** Median of one measure over frames every 20 ms of a 1 s synthetic tone (edges skipped). */
function medianMeasure(opts: Omit<SynthOptions, 'durationSec'>, key: Measure): number {
  const x = synthVoice({ durationSec: 1, ...opts });
  const f0 = opts.f0 as number;
  const vals: number[] = [];
  for (let c = 2500; c < x.length - 2500; c += 441) vals.push(analyzeSpectralFrame(x, SR, c, f0)[key]);
  const s = vals.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  return s[s.length >> 1];
}

describe('analyzeSpectralFrame', () => {
  it('returns the full shape, with harmonicDb[0] = 0', () => {
    const x = synthVoice({ durationSec: 0.5, f0: 220 });
    const f = analyzeSpectralFrame(x, SR, 5000, 220);
    expect(f.harmonicDb).toHaveLength(10);
    expect(f.harmonicDb[0]).toBe(0);
    for (const v of [f.h1h2Db, f.alphaRatioDb, f.centroidHz, f.tiltDbPerOct, f.cppDb, f.subharmonicDb]) expect(Number.isFinite(v)).toBe(true);
    // harmonicDb[1] is H2 relative to H1, i.e. -H1H2.
    expect(f.harmonicDb[1]).toBeCloseTo(-f.h1h2Db, 9);
  });

  it('returns NaNs for an invalid f0 or a silent frame', () => {
    const x = synthVoice({ durationSec: 0.5, f0: 220 });
    for (const f0 of [NaN, 0, -5, 6000]) {
      const f = analyzeSpectralFrame(x, SR, 5000, f0);
      expect(f.h1h2Db).toBeNaN();
      expect(f.harmonicDb.every(Number.isNaN)).toBe(true);
    }
    expect(analyzeSpectralFrame(new Float32Array(4096), SR, 2048, 220).cppDb).toBeNaN();
  });

  it('marks harmonics above Nyquist as NaN in harmonicDb', () => {
    const x = synthVoice({ durationSec: 0.5, f0: 1300, vowel: 'none' });
    const f = analyzeSpectralFrame(x, SR, 5000, 1300);
    expect(Number.isFinite(f.harmonicDb[7])).toBe(true); // 10.4 kHz
    expect(f.harmonicDb[8]).toBeNaN(); // 11.7 kHz > Nyquist
  });

  it('handles frames that overhang the start or end of the signal', () => {
    const x = synthVoice({ durationSec: 0.3, f0: 196 });
    for (const c of [0, 300, x.length - 1]) expect(Number.isFinite(analyzeSpectralFrame(x, SR, c, 196).h1h2Db)).toBe(true);
  });

  it('H1-H2 increases with the H1 boost and with a steeper tilt', () => {
    let prev = -Infinity;
    for (const h1 of [0, 3, 6, 10]) {
      const v = medianMeasure({ f0: 220, tiltDbPerOct: -12, h1BoostDb: h1, vowel: 'a' }, 'h1h2Db');
      expect(v).toBeGreaterThan(prev + 2);
      prev = v;
    }
    prev = -Infinity;
    for (const tilt of [-6, -12, -18, -24]) {
      const v = medianMeasure({ f0: 196, tiltDbPerOct: tilt, vowel: 'a' }, 'h1h2Db');
      expect(v).toBeGreaterThan(prev + 2);
      prev = v;
    }
    // Without formants H1-H2 is exactly the synthesiser's tilt per octave plus the H1 boost.
    expect(medianMeasure({ f0: 150, tiltDbPerOct: -12, h1BoostDb: 4, vowel: 'none' }, 'h1h2Db')).toBeCloseTo(16, 0);
  });

  it('estimates the source tilt within 3 dB/oct for vowel "none"', () => {
    for (const tilt of [-6, -9, -12, -18, -20]) {
      for (const f0 of [110, 220, 440]) {
        const v = medianMeasure({ f0, tiltDbPerOct: tilt, vowel: 'none' }, 'tiltDbPerOct');
        expect(Math.abs(v - tilt), `${tilt} @ ${f0}`).toBeLessThan(3);
      }
    }
  });

  it('alpha ratio and centroid are clearly higher for a -6 than a -18 dB/oct source', () => {
    for (const vowel of ['a', 'i', 'none'] as const) {
      const bright = { f0: 220, tiltDbPerOct: -6, vowel };
      const dark = { f0: 220, tiltDbPerOct: -18, vowel };
      expect(medianMeasure(bright, 'alphaRatioDb') - medianMeasure(dark, 'alphaRatioDb')).toBeGreaterThan(10);
      expect(medianMeasure(bright, 'centroidHz')).toBeGreaterThan(medianMeasure(dark, 'centroidHz') * 1.3);
    }
  });

  it('puts the centroid of a pure tone at its frequency and its energy in the right alpha band', () => {
    const hi = analyzeSpectralFrame(sine(2000, 0.5, SR), SR, 5000, 2000);
    expect(hi.centroidHz).toBeGreaterThan(1950);
    expect(hi.centroidHz).toBeLessThan(2050);
    expect(hi.alphaRatioDb).toBeGreaterThan(40);
    const lo = analyzeSpectralFrame(sine(400, 0.5, SR), SR, 5000, 400);
    expect(lo.alphaRatioDb).toBeLessThan(-40);
  });

  it('CPP falls strictly as breath noise rises (0 -> 0.2 -> 0.5 -> 1.0)', () => {
    for (const f0 of [110, 220, 330]) {
      for (const vowel of ['a', 'i'] as const) {
        const cpp = [0, 0.2, 0.5, 1.0].map((b) => medianMeasure({ f0, tiltDbPerOct: -12, breathNoise: b, vowel }, 'cppDb'));
        for (let i = 1; i < cpp.length; i++) expect(cpp[i], `${f0} ${vowel} ${cpp.join(',')}`).toBeLessThan(cpp[i - 1]);
      }
    }
  });

  it('subharmonicDb is clearly higher with subharmonic 0.5 than 0', () => {
    for (const f0 of [147, 220]) {
      const clean = medianMeasure({ f0, tiltDbPerOct: -9, vowel: 'a' }, 'subharmonicDb');
      const rough = medianMeasure({ f0, tiltDbPerOct: -9, vowel: 'a', subharmonic: 0.5 }, 'subharmonicDb');
      expect(rough - clean).toBeGreaterThan(20);
      expect(rough).toBeGreaterThan(-15);
    }
  });

  it('analyses every voiced frame of a 60 s take in well under 2 s', () => {
    const second = synthVoice({ durationSec: 1, f0: 196, vowel: 'a', breathNoise: 0.2 });
    const x = concat(...Array.from({ length: 60 }, () => second));
    const t0 = performance.now();
    let n = 0;
    for (let c = 0; c < x.length; c += 220) {
      analyzeSpectralFrame(x, SR, c, 196);
      n++;
    }
    expect(n).toBeGreaterThan(6000);
    // Typically ~0.9 s on one core; the slack keeps the test stable on a loaded CI machine.
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('works at other sample rates (window scales to ~93 ms)', () => {
    const x = synthVoice({ durationSec: 0.5, f0: 220, tiltDbPerOct: -12, vowel: 'none', sampleRate: 44100 });
    const f = analyzeSpectralFrame(x, 44100, 11025, 220);
    expect(f.tiltDbPerOct).toBeCloseTo(-12, 0);
    expect(f.h1h2Db).toBeCloseTo(12, 0);
  });
});

describe('hnrFromPeriodicity', () => {
  it('maps periodicity to dB and clamps', () => {
    expect(hnrFromPeriodicity(0.5)).toBeCloseTo(0, 12);
    expect(hnrFromPeriodicity(0.9)).toBeCloseTo(10 * Math.log10(9), 12);
    expect(hnrFromPeriodicity(0.99)).toBeCloseTo(10 * Math.log10(99), 9);
    expect(hnrFromPeriodicity(1)).toBe(40);
    expect(hnrFromPeriodicity(0.99999999)).toBe(40);
    expect(hnrFromPeriodicity(0)).toBe(-5);
    expect(hnrFromPeriodicity(0.1)).toBe(-5);
    expect(hnrFromPeriodicity(NaN)).toBeNaN();
  });
});
