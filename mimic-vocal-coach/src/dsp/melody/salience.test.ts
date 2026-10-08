import { describe, expect, test } from 'vitest';
import { SalienceMap } from './salience';

const SR = 22050;
const N = 2048;
const K = 372;
const BIN_HZ = SR / N;

/** Magnitude spectrum of a harmonic tone: a Hann main lobe per partial plus a small floor. */
function tone(f0: number, amp: (h: number) => number, floor = 0.01): Float32Array {
  const a = new Float32Array(K).fill(floor);
  for (let h = 1; h * f0 < 3900; h++) {
    const p = (h * f0) / BIN_HZ;
    for (let k = Math.max(0, Math.floor(p - 2)); k <= Math.min(K - 1, Math.ceil(p + 2)); k++) {
      const d = k - p;
      if (Math.abs(d) < 2) a[k] += amp(h) * Math.pow(Math.cos((Math.PI * d) / 4), 2);
    }
  }
  return a;
}

function bestHz(spec: Float32Array): number {
  const map = new SalienceMap({ sampleRate: SR, fftSize: N, fMin: 85, fMax: 1100 }, K);
  const out = new Float32Array(map.nBins);
  map.frame(spec, 0, K, out, 0);
  let j = 0;
  for (let i = 1; i < out.length; i++) if (out[i] > out[j]) j = i;
  return map.freqOf(j);
}

describe('SalienceMap', () => {
  test('picks the f0 of a harmonic tone to within 25 cents', () => {
    for (const f0 of [110, 196, 330, 523, 880]) {
      const hz = bestHz(tone(f0, (h) => 1 / h));
      expect(Math.abs(1200 * Math.log2(hz / f0))).toBeLessThan(25);
    }
  });

  test('does not jump an octave up when the second harmonic is the strongest', () => {
    const f0 = 220;
    const hz = bestHz(tone(f0, (h) => (h === 1 ? 0.3 : 1 / Math.sqrt(h))));
    expect(Math.abs(1200 * Math.log2(hz / f0))).toBeLessThan(25);
  });

  test('does not drop an octave: the sub-octave candidate explains only the even partials', () => {
    // A 300 Hz voice must not be reported at 150 Hz just because 150 Hz explains its even partials.
    const hz = bestHz(tone(300, (h) => 1 / h));
    expect(hz).toBeGreaterThan(280);
  });

  test('silence gives zero salience', () => {
    const map = new SalienceMap({ sampleRate: SR, fftSize: N, fMin: 85, fMax: 1100 }, K);
    const out = new Float32Array(map.nBins).fill(1);
    map.frame(new Float32Array(K), 0, K, out, 0);
    expect(Math.max(...out)).toBe(0);
  });

  test('bin <-> frequency mapping round-trips', () => {
    const map = new SalienceMap({ sampleRate: SR, fftSize: N, fMin: 85, fMax: 1100 }, K);
    expect(map.freqOf(map.binOf(440))).toBeCloseTo(440, 6);
    expect(map.freqOf(0)).toBeCloseTo(85, 9);
  });
});
