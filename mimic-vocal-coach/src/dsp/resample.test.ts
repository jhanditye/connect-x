import { describe, expect, it } from 'vitest';
import { ANALYSIS_RATE, resample, toMono } from './resample';
import { sine } from '../testing/synth';

/** Amplitude of a sinusoid at `hz` by least-squares fit of sin/cos (away from the edges). */
function toneAmplitude(x: Float32Array, sr: number, hz: number): number {
  const skip = Math.round(0.05 * sr);
  let ss = 0;
  let cc = 0;
  let sc = 0;
  let xs = 0;
  let xc = 0;
  for (let i = skip; i < x.length - skip; i++) {
    const a = (2 * Math.PI * hz * i) / sr;
    const s = Math.sin(a);
    const c = Math.cos(a);
    ss += s * s;
    cc += c * c;
    sc += s * c;
    xs += x[i] * s;
    xc += x[i] * c;
  }
  const det = ss * cc - sc * sc;
  const bs = (xs * cc - xc * sc) / det;
  const bc = (xc * ss - xs * sc) / det;
  return Math.hypot(bs, bc);
}

function rms(x: Float32Array, skip: number): number {
  let s = 0;
  let n = 0;
  for (let i = skip; i < x.length - skip; i++) {
    s += x[i] * x[i];
    n++;
  }
  return Math.sqrt(s / n);
}

const db = (r: number) => 20 * Math.log10(r);

describe('toMono', () => {
  it('averages channels', () => {
    const m = toMono([Float32Array.from([1, 0, 1]), Float32Array.from([0, 0, -1])]);
    expect(Array.from(m)).toEqual([0.5, 0, 0]);
  });
  it('copies a single channel and handles none', () => {
    const a = Float32Array.from([0.1, 0.2]);
    const m = toMono([a]);
    expect(m).not.toBe(a);
    expect(Array.from(m)).toEqual(Array.from(a));
    expect(toMono([]).length).toBe(0);
  });
});

describe('resample', () => {
  it('returns the input unchanged when rates match', () => {
    const x = sine(440, 0.1, 22050);
    expect(resample(x, 22050, 22050)).toBe(x);
  });

  it('keeps a 5 kHz tone at 5 kHz and its amplitude within 0.5 dB (44.1k -> 22.05k)', () => {
    const x = sine(5000, 1, 44100, 0.5);
    const y = resample(x, 44100, ANALYSIS_RATE);
    expect(y.length).toBe(22050);
    const amp = toneAmplitude(y, ANALYSIS_RATE, 5000);
    expect(Math.abs(db(amp / 0.5))).toBeLessThan(0.5);
    // Nearly all the energy is at 5 kHz: residual after removing the fitted tone is tiny.
    expect(amp / Math.SQRT2 / rms(y, 1102)).toBeGreaterThan(0.999);
  });

  it('attenuates a 15 kHz tone by more than 40 dB when going 48k -> 22.05k', () => {
    const x = sine(15000, 1, 48000, 0.5);
    const y = resample(x, 48000, ANALYSIS_RATE);
    expect(y.length).toBe(22050);
    const out = rms(y, 1102);
    expect(db(out / (0.5 / Math.SQRT2))).toBeLessThan(-40);
  });

  it('preserves in-band tones for 48k, 16k and 8k inputs', () => {
    for (const [rate, hz] of [
      [48000, 3000],
      [16000, 2000],
      [8000, 1000],
    ] as const) {
      const x = sine(hz, 1, rate, 0.4);
      const y = resample(x, rate, ANALYSIS_RATE);
      expect(y.length).toBe(22050);
      const amp = toneAmplitude(y, ANALYSIS_RATE, hz);
      expect(Math.abs(db(amp / 0.4))).toBeLessThan(0.5);
      expect(amp / Math.SQRT2 / rms(y, 1102)).toBeGreaterThan(0.999);
    }
  });

  it('upsampling does not create images above the source Nyquist', () => {
    // A 3.5 kHz tone at 8 kHz has its first image at 4.5 kHz; it must not appear at 22.05 kHz.
    const y = resample(sine(3500, 1, 8000, 0.5), 8000, ANALYSIS_RATE);
    const image = toneAmplitude(y, ANALYSIS_RATE, 4500);
    expect(db(image / 0.5)).toBeLessThan(-60);
  });

  it('handles non-integer and awkward rates', () => {
    const x = sine(1000, 0.5, 44056.5, 0.5);
    const y = resample(x, 44056.5, ANALYSIS_RATE);
    expect(Math.abs(y.length - Math.round(0.5 * ANALYSIS_RATE))).toBeLessThanOrEqual(1);
    expect(Math.abs(db(toneAmplitude(y, ANALYSIS_RATE, 1000) / 0.5))).toBeLessThan(0.5);
  });

  it('resamples 60 s of 48 kHz audio quickly', () => {
    const x = sine(440, 60, 48000, 0.5);
    const t0 = performance.now();
    const y = resample(x, 48000, ANALYSIS_RATE);
    const ms = performance.now() - t0;
    expect(y.length).toBe(60 * ANALYSIS_RATE);
    expect(ms).toBeLessThan(1500);
  });
});
