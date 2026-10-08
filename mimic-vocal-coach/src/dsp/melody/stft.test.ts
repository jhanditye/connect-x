import { describe, expect, test } from 'vitest';
import { rfft } from '../fft';
import { FrameFft, OverlapAdd, frameCentre, frameCount, irfft } from './stft';

describe('stft helpers', () => {
  test('frame grid matches PitchTrack (10 ms, centre round(i * 0.01 * sr))', () => {
    expect(frameCount(22050, 22050)).toBe(Math.floor(22049 / 220.5) + 1);
    expect(frameCentre(100, 22050)).toBe(22050);
    expect(frameCount(0, 22050)).toBe(0);
  });

  test('irfft inverts rfft', () => {
    const n = 256;
    const x = new Float64Array(n).map((_, i) => Math.sin(i * 0.3) + 0.5 * Math.cos(i * 1.7) + ((i * 7919) % 13) / 13);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    rfft(x, n, re, im);
    const y = new Float64Array(n);
    irfft(re, im, n, y);
    for (let i = 0; i < n; i++) expect(y[i]).toBeCloseTo(x[i], 9);
  });

  test('analysis -> overlap-add resynthesis reproduces the signal away from the edges', () => {
    const sr = 22050;
    const len = sr * 2;
    const x = new Float32Array(len).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 1234 * i) / sr));
    const n = 2048;
    const ff = new FrameFft(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    const ola = new OverlapAdd(len, n);
    for (let i = 0; i < frameCount(len, sr); i += 2) {
      const c = frameCentre(i, sr);
      ff.run(x, c, re, im);
      ola.add(re, im, c);
    }
    const y = ola.finish();
    let err = 0;
    for (let i = n; i < len - n; i++) err = Math.max(err, Math.abs(y[i] - x[i]));
    expect(err).toBeLessThan(2e-4);
  });
});
