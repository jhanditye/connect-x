import { describe, expect, it } from 'vitest';
import { dropFragments, FRAGMENT_MAX_SEC, FRAGMENT_MIN_TRUST, fragmentTrust } from './clean';

const HOP = 0.01;

/** A track of `n` frames: f0 440 Hz everywhere, voiced on the given [from, to) ranges. */
function track(n: number, voicedRanges: [number, number][], hz = 440) {
  const f0 = new Float64Array(n).fill(NaN);
  const voiced = new Uint8Array(n);
  for (const [a, b] of voicedRanges) for (let t = a; t < b; t++) { f0[t] = hz; voiced[t] = 1; }
  return { f0, voiced };
}

/** Same cue value on every frame. */
function cues(n: number, v: { confidence: number; relLevelDb: number; dominance: number; share: number }) {
  return {
    confidence: new Float64Array(n).fill(v.confidence),
    relLevelDb: new Float64Array(n).fill(v.relLevelDb),
    dominance: new Float64Array(n).fill(v.dominance),
    share: new Float64Array(n).fill(v.share),
  };
}

const WEAK = { confidence: 0.55, relLevelDb: -15, dominance: 0.4, share: 0.04 };
const STRONG = { confidence: 0.95, relLevelDb: -2, dominance: 0.8, share: 0.45 };

describe('fragmentTrust', () => {
  it('rises with every cue and with the length of the stretch, and stays in 0..1', () => {
    const base = fragmentTrust(0.8, -8, 0.6, 0.2, 0.1);
    expect(fragmentTrust(0.95, -8, 0.6, 0.2, 0.1)).toBeGreaterThan(base);
    expect(fragmentTrust(0.8, -2, 0.6, 0.2, 0.1)).toBeGreaterThan(base);
    expect(fragmentTrust(0.8, -8, 0.8, 0.2, 0.1)).toBeGreaterThan(base);
    expect(fragmentTrust(0.8, -8, 0.6, 0.4, 0.1)).toBeGreaterThan(base);
    expect(fragmentTrust(0.8, -8, 0.6, 0.2, 0.14)).toBeGreaterThan(base);
    for (const t of [fragmentTrust(0, -60, 0, 0, 0.01), fragmentTrust(1, 0, 1, 1, 0.15)]) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it('weak cues on a short stretch are below the drop line and strong ones are above it', () => {
    expect(fragmentTrust(WEAK.confidence, WEAK.relLevelDb, WEAK.dominance, WEAK.share, 0.08)).toBeLessThan(FRAGMENT_MIN_TRUST);
    expect(fragmentTrust(STRONG.confidence, STRONG.relLevelDb, STRONG.dominance, STRONG.share, 0.08)).toBeGreaterThan(FRAGMENT_MIN_TRUST);
  });
});

describe('dropFragments', () => {
  it('drops a short stretch with weak cues and reports how many frames went', () => {
    const { f0, voiced } = track(100, [[10, 18]]);
    const removed = dropFragments(f0, voiced, HOP, cues(100, WEAK));
    expect(removed).toBe(8);
    expect(voiced.slice(5, 25).every((v) => v === 0)).toBe(true);
    expect(Number.isNaN(f0[12])).toBe(true);
  });

  it('keeps a short stretch the cues vouch for (a fast sung note)', () => {
    const { f0, voiced } = track(100, [[10, 18]]);
    expect(dropFragments(f0, voiced, HOP, cues(100, STRONG))).toBe(0);
    expect(voiced[12]).toBe(1);
    expect(f0[12]).toBe(440);
  });

  it(`never touches a stretch of ${FRAGMENT_MAX_SEC} s or longer, whatever the cues`, () => {
    const { f0, voiced } = track(100, [[10, 10 + Math.round(FRAGMENT_MAX_SEC / HOP)]]);
    expect(dropFragments(f0, voiced, HOP, cues(100, WEAK))).toBe(0);
    expect(voiced.reduce((a, b) => a + b, 0)).toBe(Math.round(FRAGMENT_MAX_SEC / HOP));
  });

  it('splits stretches where the pitch jumps, so a short jump inside a long voiced run is judged on its own', () => {
    const n = 200;
    const f0 = new Float64Array(n).fill(440);
    const voiced = new Uint8Array(n).fill(1);
    for (let t = 90; t < 97; t++) f0[t] = 440 * 2 ** (7 / 12); // seven frames a fifth up
    const removed = dropFragments(f0, voiced, HOP, cues(n, WEAK));
    expect(removed).toBe(7);
    expect(voiced[95]).toBe(0);
    expect(voiced[89]).toBe(1);
    expect(voiced[97]).toBe(1);
  });

  it('leaves unvoiced and empty tracks alone', () => {
    const { f0, voiced } = track(50, []);
    expect(dropFragments(f0, voiced, HOP, cues(50, WEAK))).toBe(0);
    expect(dropFragments(new Float64Array(0), new Uint8Array(0), HOP, cues(0, WEAK))).toBe(0);
  });
});
