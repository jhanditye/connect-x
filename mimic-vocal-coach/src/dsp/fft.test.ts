import { describe, expect, it } from 'vitest';
import { fft, hann, nextPow2, powerSpectrum, rfft } from './fft';
import { makeRng } from '../testing/synth';

function naiveDft(re: ArrayLike<number>, im: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

function randomArray(n: number, seed: number): Float64Array {
  const rng = makeRng(seed);
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = rng() * 2 - 1;
  return a;
}

describe('nextPow2', () => {
  it('rounds up to a power of two', () => {
    expect(nextPow2(0)).toBe(1);
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(1024)).toBe(1024);
    expect(nextPow2(1025)).toBe(2048);
  });
});

describe('fft', () => {
  it('matches a naive DFT for sizes 1..256', () => {
    for (const n of [1, 2, 4, 8, 16, 64, 256]) {
      const re = randomArray(n, n);
      const im = randomArray(n, n + 100);
      const ref = naiveDft(re, im);
      fft(re, im);
      for (let k = 0; k < n; k++) {
        expect(re[k]).toBeCloseTo(ref.re[k], 9);
        expect(im[k]).toBeCloseTo(ref.im[k], 9);
      }
    }
  });

  it('inverse restores the input', () => {
    const re = randomArray(1024, 5);
    const im = randomArray(1024, 6);
    const r0 = Float64Array.from(re);
    const i0 = Float64Array.from(im);
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < 1024; i++) {
      expect(re[i]).toBeCloseTo(r0[i], 12);
      expect(im[i]).toBeCloseTo(i0[i], 12);
    }
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow();
  });
});

describe('rfft', () => {
  it('matches the complex FFT of a real signal, including zero padding', () => {
    for (const n of [2, 8, 64, 512]) {
      const x = randomArray(Math.max(1, n - 3), n + 7);
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      re.set(x.subarray(0, Math.min(n, x.length)));
      fft(re, im);
      const oRe = new Float64Array(n / 2 + 1);
      const oIm = new Float64Array(n / 2 + 1);
      rfft(x, n, oRe, oIm);
      for (let k = 0; k <= n / 2; k++) {
        expect(oRe[k]).toBeCloseTo(re[k], 9);
        expect(oIm[k]).toBeCloseTo(im[k], 9);
      }
    }
  });
});

describe('hann / powerSpectrum', () => {
  it('hann is periodic with its peak at n/2', () => {
    const w = hann(8);
    expect(w[0]).toBe(0);
    expect(w[4]).toBeCloseTo(1, 12);
    expect(w[1]).toBeCloseTo(w[7], 12);
  });

  it('puts a bin-centred sinusoid in the right bin with the expected power', () => {
    const n = 256;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * 10 * i) / n);
    const p = powerSpectrum(x, n);
    expect(p.length).toBe(n / 2 + 1);
    // A unit cosine at bin k has |X(k)| = n/2.
    expect(p[10]).toBeCloseTo((n / 2) ** 2, 6);
    expect(p[9]).toBeLessThan(1e-12);
    expect(p[0]).toBeLessThan(1e-12);
  });

  it('zero-pads short frames', () => {
    const x = [1, 1, 1, 1];
    const p = powerSpectrum(x, 16);
    expect(p[0]).toBeCloseTo(16, 12);
    expect(p.length).toBe(9);
  });
});
