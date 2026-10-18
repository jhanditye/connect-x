import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../theory/rng';
import { pickAdaptive } from './adaptive';

const items = ['a', 'b', 'c', 'd', 'e', 'f'];
const weak: Record<string, number> = { a: 0, b: 0.05, c: 0.2, d: 0.4, e: 0.8, f: 1 };

describe('pickAdaptive', () => {
  it('is deterministic for a seed and returns the asked count', () => {
    const a = pickAdaptive(mulberry32(3), items, (t) => weak[t], 10);
    const b = pickAdaptive(mulberry32(3), items, (t) => weak[t], 10);
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
  });

  it('handles empty input and zero counts', () => {
    expect(pickAdaptive(mulberry32(1), [], () => 1, 5)).toEqual([]);
    expect(pickAdaptive(mulberry32(1), items, () => 1, 0)).toEqual([]);
    expect(pickAdaptive(mulberry32(1), items, () => NaN, 3)).toHaveLength(3);
  });

  it('does not repeat an item until every item has been used', () => {
    for (let seed = 0; seed < 50; seed++) {
      const picks = pickAdaptive(mulberry32(seed), items, (t) => weak[t], 6);
      expect(new Set(picks).size).toBe(6);
    }
  });

  it('picks weak items far more often than strong ones', () => {
    const counts: Record<string, number> = {};
    for (let seed = 0; seed < 2000; seed++) {
      for (const p of pickAdaptive(mulberry32(seed), items, (t) => weak[t], 3, 0)) counts[p] = (counts[p] ?? 0) + 1;
    }
    expect(counts.f).toBeGreaterThan(3 * counts.a);
    expect(counts.e).toBeGreaterThan(2 * counts.b);
    // Strong items still come up sometimes (the floor).
    expect(counts.a).toBeGreaterThan(50);
  });

  it('always includes about easyShare easy items (at least one)', () => {
    for (let seed = 0; seed < 200; seed++) {
      const picks = pickAdaptive(mulberry32(seed), items, (t) => weak[t], 5);
      // The easiest third of six items is a and b; 5 * 0.2 = 1 easy pick at least.
      expect(picks.some((p) => p === 'a' || p === 'b')).toBe(true);
    }
    // 10 * 0.3 = 3 easy picks, from the easiest three items (the pool grows to hold them).
    for (let seed = 0; seed < 100; seed++) {
      const ten = pickAdaptive(mulberry32(seed), items, (t) => weak[t], 10, 0.3);
      expect(ten.filter((p) => p === 'a' || p === 'b' || p === 'c').length).toBeGreaterThanOrEqual(3);
    }
  });
});
