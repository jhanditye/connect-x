import { describe, expect, it } from 'vitest';
import { trackPitch } from '../dsp/pitch';
import { median } from '../dsp/stats';
import { synthVoice, type SynthOptions } from '../testing/synth';
import { aspirationIndex, buildFrameTrack, despikePitch, harmonicBalanceDb, harmonicSlope, normalizedH1H2 } from './features';

const SR = 22050;

function medianSlope(opts: Partial<SynthOptions>, f0: number): number {
  const x = synthVoice({ sampleRate: SR, durationSec: 0.8, f0, vowel: 'a', ...opts });
  const vals: number[] = [];
  for (let t = 0.15; t < 0.65; t += 0.05) vals.push(harmonicSlope(harmonicBalanceDb(x, SR, Math.round(t * SR), f0), f0));
  return median(vals);
}

describe('aspirationIndex', () => {
  it('is 0 for clean phonation and high only when HNR and CPP both indicate noise', () => {
    expect(aspirationIndex(40, 32)).toBe(0);
    expect(aspirationIndex(4.5, 16)).toBeGreaterThan(0.55);
    // Rasp: low periodicity-based HNR but a strong cepstral peak -> not breath.
    expect(aspirationIndex(-2, 24)).toBe(0);
    expect(aspirationIndex(-5, 10)).toBeGreaterThan(0.9);
    expect(aspirationIndex(NaN, 20)).toBeNaN();
  });
});

describe('normalizedH1H2', () => {
  it('adds the open-vowel pitch correction (0 at C3, 12 dB from D4 up)', () => {
    expect(normalizedH1H2(5, 130.81)).toBeCloseTo(5, 5);
    expect(normalizedH1H2(5, 196)).toBeCloseTo(7.5, 1);
    expect(normalizedH1H2(5, 293.66)).toBeCloseTo(17, 1);
    expect(normalizedH1H2(5, 440)).toBeCloseTo(17, 5);
    expect(normalizedH1H2(5, 80)).toBeCloseTo(5, 5);
    expect(normalizedH1H2(NaN, 200)).toBeNaN();
  });
});

describe('harmonic balance / slope', () => {
  it('orders spectral slopes and is roughly pitch-invariant', () => {
    for (const f0 of [147, 220, 294]) {
      const bright = medianSlope({ tiltDbPerOct: -6 }, f0);
      const mid = medianSlope({ tiltDbPerOct: -12 }, f0);
      const dark = medianSlope({ tiltDbPerOct: -20 }, f0);
      expect(bright).toBeGreaterThan(mid);
      expect(mid).toBeGreaterThan(dark + 3);
      expect(bright).toBeGreaterThan(-5);
      expect(dark).toBeLessThan(-7);
    }
  });

  it('is not made brighter by aspiration noise', () => {
    const clean = medianSlope({ tiltDbPerOct: -18, h1BoostDb: 8 }, 220);
    const breathy = medianSlope({ tiltDbPerOct: -18, h1BoostDb: 8, breathNoise: 0.6 }, 220);
    expect(breathy).toBeLessThan(clean + 3);
    expect(breathy).toBeLessThan(-6);
  });

  it('returns NaN for silence or invalid f0', () => {
    const x = new Float32Array(4096);
    expect(harmonicBalanceDb(x, SR, 2048, 200)).toBeNaN();
    expect(harmonicBalanceDb(synthVoice({ sampleRate: SR, durationSec: 0.3, f0: 200 }), SR, 3000, 0)).toBeNaN();
    expect(harmonicSlope(NaN, 200)).toBeNaN();
  });
});

describe('buildFrameTrack', () => {
  it('fills features on voiced frames only and reports progress up to 1', () => {
    const x = new Float32Array(Math.round(1.2 * SR));
    x.set(synthVoice({ sampleRate: SR, durationSec: 0.8, f0: 220 }), Math.round(0.2 * SR));
    const track = trackPitch(x, SR);
    const seen: number[] = [];
    const ft = buildFrameTrack(x, SR, track, 440, (f) => seen.push(f));
    expect(ft.frames).toHaveLength(track.f0.length);
    expect(seen[seen.length - 1]).toBe(1);
    const voiced = ft.frames.filter((f) => f.voiced);
    expect(voiced.length).toBeGreaterThan(60);
    for (const f of voiced) {
      expect(f.midi).toBeCloseTo(57, 0);
      expect(Number.isFinite(f.cppDb)).toBe(true);
      expect(Number.isFinite(f.hnrDb)).toBe(true);
      expect(f.register).toBeNull();
    }
    const unvoiced = ft.frames.find((f) => !f.voiced);
    expect(unvoiced && Number.isNaN(unvoiced.h1h2Db) && Number.isNaN(unvoiced.midi)).toBe(true);
  });

  it('applies the tuning reference to MIDI', () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.6, f0: 432 });
    const ft = buildFrameTrack(x, SR, trackPitch(x, SR), 432);
    const mids = ft.frames.filter((f) => f.voiced).map((f) => f.midi);
    expect(median(mids)).toBeCloseTo(69, 1);
  });
});

describe('buildFrameTrack with spectral: false (mix mode)', () => {
  const x = new Float32Array(Math.round(1.2 * SR));
  x.set(synthVoice({ sampleRate: SR, durationSec: 0.8, f0: 220 }), Math.round(0.2 * SR));
  const track = trackPitch(x, SR);

  it('keeps the pitch-derived fields and leaves every spectral field NaN', () => {
    const full = buildFrameTrack(x, SR, track, 440);
    const ft = buildFrameTrack(x, SR, track, 440, undefined, { spectral: false });
    expect(ft.frames).toHaveLength(track.f0.length);
    for (let i = 0; i < ft.frames.length; i++) {
      const f = ft.frames[i];
      const g = full.frames[i];
      expect(f.voiced).toBe(g.voiced);
      expect(Object.is(f.f0, g.f0)).toBe(true);
      expect(Object.is(f.midi, g.midi)).toBe(true);
      expect(f.periodicity).toBe(g.periodicity);
      expect(f.rmsDb).toBe(g.rmsDb);
      for (const key of ['h1h2Db', 'alphaRatioDb', 'centroidHz', 'tiltDbPerOct', 'cppDb', 'hnrDb'] as const) expect(f[key]).toBeNaN();
      expect(f.register).toBeNull();
    }
    for (const arr of [ft.subharmonicDb, ft.harmonicBalanceDb, ft.harmonicSlope, ft.aspiration, ft.h1h2Norm]) {
      expect(arr).toHaveLength(track.f0.length);
      expect(arr.every((v) => Number.isNaN(v))).toBe(true);
    }
  });

  it('does not read the signal, so an empty one is fine, and still despikes the pitch', () => {
    const ft = buildFrameTrack(new Float32Array(0), 0, track, 440, undefined, { spectral: false });
    expect(ft.frames.filter((f) => f.voiced).length).toBeGreaterThan(60);
    const spiky = { ...track, f0: Float64Array.from([NaN, 1470, 220, 221, 219, NaN]), voiced: Uint8Array.from([0, 1, 1, 1, 1, 0]), times: new Float64Array(6), periodicity: new Float64Array(6), rmsDb: new Float64Array(6) };
    expect(buildFrameTrack(x, SR, spiky, 440, undefined, { spectral: false }).frames[1].voiced).toBe(false);
  });

  it('spectral: true is the same as the default', () => {
    const a = buildFrameTrack(x, SR, track, 440);
    const b = buildFrameTrack(x, SR, track, 440, undefined, { spectral: true });
    expect(JSON.stringify(b.frames)).toBe(JSON.stringify(a.frames));
  });
});

describe('despikePitch', () => {
  it('removes one-frame spikes but keeps held leaps', () => {
    const f0 = Float64Array.from([NaN, 1470, 220, 221, 219, 900, 220, 220, 440, 440, 441, 440, NaN]);
    const voiced = Uint8Array.from(f0, (v) => (Number.isNaN(v) ? 0 : 1));
    const out = despikePitch(f0, voiced);
    expect(out.voiced[1]).toBe(0);
    expect(out.voiced[5]).toBe(0);
    expect(Array.from(out.voiced.slice(8, 12))).toEqual([1, 1, 1, 1]);
    expect(out.voiced[2]).toBe(1);
    expect(f0[1]).toBe(1470); // input untouched
  });
});
