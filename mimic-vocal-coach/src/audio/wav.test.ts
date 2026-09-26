import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from './wav';

function ramp(n: number, scale: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => ((i % 100) / 100 - 0.5) * scale);
}

describe('decodeWav options', () => {
  it('without options decodes every channel and frame', () => {
    const l = ramp(1000, 1);
    const r = ramp(1000, 0.5);
    const out = decodeWav(encodeWav([l, r], 8000));
    expect(out.sampleRate).toBe(8000);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0].length).toBe(1000);
    expect(out.sourceChannels).toBe(2);
    expect(out.totalFrames).toBe(1000);
    expect(out.channels[1][10]).toBeCloseTo(r[10], 3);
  });

  it('maxSeconds stops reading early but reports the full length', () => {
    const out = decodeWav(encodeWav(ramp(8000, 1), 8000), { maxSeconds: 0.25 });
    expect(out.channels[0].length).toBe(2000);
    expect(out.totalFrames).toBe(8000);
  });

  it('mono mixes the channels while reading, into a single array', () => {
    const l = ramp(1000, 1);
    const r = ramp(1000, 0.5);
    const out = decodeWav(encodeWav([l, r], 8000), { mono: true, maxSeconds: 0.1 });
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0].length).toBe(800);
    expect(out.sourceChannels).toBe(2);
    for (const i of [0, 7, 450, 799]) expect(out.channels[0][i]).toBeCloseTo((l[i] + r[i]) / 2, 3);
  });

  it('mono on a mono file returns that channel', () => {
    const x = ramp(500, 0.8);
    const out = decodeWav(encodeWav(x, 8000), { mono: true });
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0][123]).toBeCloseTo(x[123], 3);
  });
});
