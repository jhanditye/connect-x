import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sine } from '../testing/synth';
import {
  audioBytes,
  CHUNK_SEC,
  chunkFramesFor,
  chunkRanges,
  chunksFor,
  fingerprint,
  floatToInt16,
  int16ToFloat,
  parseFingerprint,
  sourceKey,
  peaks,
  sha1Hex,
  sliceChunks,
} from './pcm';

const SR = 44100;

afterEach(() => vi.unstubAllGlobals());

describe('Int16 conversion', () => {
  it('round-trips a sine with more than 85 dB SNR', () => {
    const x = sine(220, 5, SR, 0.6);
    const back = int16ToFloat(floatToInt16(x));
    let noise = 0;
    let signal = 0;
    for (let i = 0; i < x.length; i++) {
      noise += (back[i] - x[i]) ** 2;
      signal += x[i] ** 2;
    }
    expect(10 * Math.log10(signal / noise)).toBeGreaterThan(85);
  });

  it('clamps out-of-range samples, keeps full scale and stores NaN as silence', () => {
    const pcm = floatToInt16(Float32Array.of(2, -2, 1, -1, 0, NaN, Infinity, -Infinity));
    expect(Array.from(pcm)).toEqual([32767, -32768, 32767, -32768, 0, 0, 32767, -32768]);
    const back = int16ToFloat(Int16Array.of(32767, -32768, 0));
    expect(back[0]).toBe(1);
    expect(back[1]).toBe(-1);
    expect(back[2]).toBe(0);
  });

  it('handles empty input', () => {
    expect(floatToInt16(new Float32Array(0)).length).toBe(0);
    expect(int16ToFloat(new Int16Array(0)).length).toBe(0);
  });
});

describe('chunking', () => {
  it('splits into whole chunks plus a remainder and nothing for no audio', () => {
    expect(chunkRanges(25, 10)).toEqual([[0, 10], [10, 20], [20, 25]]);
    expect(chunkRanges(20, 10)).toEqual([[0, 10], [10, 20]]);
    expect(chunkRanges(0, 10)).toEqual([]);
    expect(chunkRanges(10, 0)).toEqual([]);
    expect(chunkRanges(10, NaN)).toEqual([]);
  });

  it('sizes a chunk from the rate and refuses rates no audio has', () => {
    expect(chunkFramesFor(SR)).toBe(CHUNK_SEC * SR);
    expect(chunkFramesFor(22050)).toBe(220500);
    for (const bad of [0, -1, NaN, Infinity, 100]) expect(() => chunkFramesFor(bad)).toThrow(RangeError);
    expect(audioBytes(SR)).toBe(2 * SR);
    expect(audioBytes(-5)).toBe(0);
  });

  const cf = CHUNK_SEC * SR;
  const frames = 37 * SR;

  it('finds the chunks that cover a range at and around chunk edges', () => {
    expect(chunksFor(0, 3, SR, cf, frames)).toMatchObject({ first: 0, last: 0, from: 0, to: 3 * SR });
    expect(chunksFor(9.5, 10.5, SR, cf, frames)).toMatchObject({ first: 0, last: 1 });
    expect(chunksFor(10, 20, SR, cf, frames)).toMatchObject({ first: 1, last: 1, from: 10 * SR, to: 20 * SR });
    expect(chunksFor(20, 20.0001, SR, cf, frames)).toMatchObject({ first: 2, last: 2 });
    expect(chunksFor(8, 31.7, SR, cf, frames)).toMatchObject({ first: 0, last: 3 });
    expect(chunksFor(36.9, 40, SR, cf, frames)).toMatchObject({ first: 3, last: 3, to: frames });
  });

  it('clamps a range that starts before the clip or ends after it, and reports an empty one as last < first', () => {
    expect(chunksFor(-5, 2, SR, cf, frames)).toMatchObject({ from: 0, first: 0 });
    const beyond = chunksFor(50, 60, SR, cf, frames);
    expect(beyond.to).toBe(beyond.from);
    expect(beyond.last).toBeLessThan(beyond.first);
    const reversed = chunksFor(12, 5, SR, cf, frames);
    expect(reversed.last).toBeLessThan(reversed.first);
    const none = chunksFor(0, 5, SR, cf, 0);
    expect(none.last).toBeLessThan(none.first);
  });

  it('rejects a range that is not a number', () => {
    expect(() => chunksFor(NaN, 2, SR, cf, frames)).toThrow(RangeError);
    expect(() => chunksFor(0, Infinity, SR, cf, frames)).toThrow(RangeError);
  });

  it('cuts exact slices out of joined chunks', () => {
    const x = sine(330, 37, SR, 0.5);
    const pcm = floatToInt16(x);
    const chunks = chunkRanges(pcm.length, cf).map(([a, b]) => pcm.slice(a, b));
    for (const [a, b] of [[0, 3], [9.5, 10.5], [10, 20], [8, 31.7], [36.9, 40], [12.345, 12.9]] as const) {
      const r = chunksFor(a, b, SR, cf, pcm.length);
      const got = sliceChunks(chunks.slice(r.first, r.last + 1), r.first, cf, r.from, r.to);
      expect(got.length).toBe(r.to - r.from);
      for (const i of [0, got.length >> 1, got.length - 1]) expect(Math.abs(got[i] - x[r.from + i])).toBeLessThan(1e-4);
    }
  });
});

describe('peaks', () => {
  it('returns the requested number of bins with the maximum of each', () => {
    const x = new Float32Array(100);
    x[5] = -0.5;
    x[95] = 0.8;
    const p = peaks(x, 10);
    expect(p.length).toBe(10);
    expect(p[0]).toBeCloseTo(0.5);
    expect(p[9]).toBeCloseTo(0.8);
    expect(p[4]).toBe(0);
  });

  it('copes with no samples, no bins, more bins than samples and values over full scale', () => {
    expect(Array.from(peaks(new Float32Array(0), 4))).toEqual([0, 0, 0, 0]);
    expect(peaks(Float32Array.of(1, 2), 0).length).toBe(0);
    expect(peaks(Float32Array.of(1, 2), -3).length).toBe(0);
    const wide = peaks(Float32Array.of(0.25, 0.5, 4), 8);
    expect(wide.length).toBe(8);
    expect(Math.max(...wide)).toBe(1);
    expect(wide.every((v) => v > 0)).toBe(true);
  });
});

describe('sha1Hex', () => {
  const hex = (s: string) => sha1Hex(new TextEncoder().encode(s));

  it('matches the published test vectors', () => {
    expect(hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex('The quick brown fox jumps over the lazy dog')).toBe('2fd4e1c67a2d28fced849ee1bb76e7391b93eb12');
    expect(sha1Hex(new Uint8Array(1_000_000).fill(0x61))).toBe('34aa973cd4c4daa4f61eeb2bdbad27316534016f');
  });

  it('agrees with node:crypto around the block boundaries', () => {
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const b = randomBytes(n);
      expect(sha1Hex(b)).toBe(createHash('sha1').update(b).digest('hex'));
    }
  });
});

describe('fingerprint', () => {
  const file = new Uint8Array(200_000).map((_, i) => i % 251);

  it('is stable and sensitive to size, duration and content at either end', async () => {
    const f1 = await fingerprint(file, file.length, 12.34);
    expect(f1).toMatch(/^200000:12340:[0-9a-f]{16}$/);
    expect(await fingerprint(file.slice(), file.length, 12.34)).toBe(f1);
    expect(await fingerprint(file, file.length + 1, 12.34)).not.toBe(f1);
    expect(await fingerprint(file, file.length, 12.35)).not.toBe(f1);
    const head = file.slice();
    head[10] ^= 1;
    expect(await fingerprint(head, file.length, 12.34)).not.toBe(f1);
    const tail = file.slice();
    tail[file.length - 10] ^= 1;
    expect(await fingerprint(tail, file.length, 12.34)).not.toBe(f1);
  });

  it('gives the same answer without crypto.subtle (insecure origin)', async () => {
    const withSubtle = await fingerprint(file, file.length, 61.2);
    vi.stubGlobal('crypto', {});
    expect(await fingerprint(file, file.length, 61.2)).toBe(withSubtle);
  });

  it('falls back when subtle.digest refuses', async () => {
    const withSubtle = await fingerprint(file, file.length, 61.2);
    vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('nope')) } });
    expect(await fingerprint(file, file.length, 61.2)).toBe(withSubtle);
  });

  it('handles tiny files and junk numbers', async () => {
    expect(await fingerprint(new Uint8Array(0), 0, 0)).toMatch(/^0:0:[0-9a-f]{16}$/);
    expect(await fingerprint(new Uint8Array(10), NaN, NaN)).toMatch(/^0:0:[0-9a-f]{16}$/);
  });

  it('parses back into its parts', async () => {
    const fp = await fingerprint(file, file.length, 12.34);
    expect(parseFingerprint(fp)).toEqual({ size: 200000, durationMs: 12340, hash: fp.split(':')[2], startMs: 0 });
    expect(parseFingerprint('nonsense')).toBeNull();
    expect(parseFingerprint('1:2:XYZ')).toBeNull();
  });

  it('understands the excerpt offset a clip stored from part of its file carries', () => {
    expect(parseFingerprint('100:61200:0123456789abcdef@8500')).toEqual({ size: 100, durationMs: 61200, hash: '0123456789abcdef', startMs: 8500 });
    expect(sourceKey('100:61200:0123456789abcdef@8500')).toBe('100:61200:0123456789abcdef');
    expect(sourceKey('100:61200:0123456789abcdef')).toBe('100:61200:0123456789abcdef');
    expect(parseFingerprint('100:61200:0123456789abcdef@x')).toBeNull();
  });
});
