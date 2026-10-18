// Seeded randomness for deterministic exercise targets (?seed=N in the hash, and tests). mulberry32: tiny, fast, good
// enough for picking notes; not for anything security-related.

export type Rng = () => number;

/** A generator of floats in [0, 1) from a 32-bit seed. The same seed always gives the same stream. */
export function mulberry32(seed: number): Rng {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded generator when `seed` is given, otherwise one seeded from Math.random (still a plain Rng). */
export function makeSkillsRng(seed?: number | null): Rng {
  return mulberry32(seed ?? Math.floor(Math.random() * 0x100000000));
}

/** Integer in [lo, hi] inclusive. */
export function randInt(rng: Rng, lo: number, hi: number): number {
  const a = Math.ceil(Math.min(lo, hi));
  const b = Math.floor(Math.max(lo, hi));
  return a + Math.min(b - a, Math.floor(rng() * (b - a + 1)));
}

/** A random element; throws on an empty array (a programming error). */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() from an empty list');
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/** A shuffled copy (Fisher-Yates). */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Index chosen with probability proportional to `weights` (negative and non-finite weights count as 0).
 * When every weight is 0 the choice is uniform. Returns -1 for an empty list.
 */
export function weightedIndex(rng: Rng, weights: readonly number[]): number {
  if (weights.length === 0) return -1;
  let total = 0;
  for (const w of weights) total += Number.isFinite(w) && w > 0 ? w : 0;
  if (total <= 0) return Math.min(weights.length - 1, Math.floor(rng() * weights.length));
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0;
    if (r < w) return i;
    r -= w;
  }
  // Float rounding: fall back to the last positive weight.
  for (let i = weights.length - 1; i >= 0; i--) if (Number.isFinite(weights[i]) && weights[i] > 0) return i;
  return weights.length - 1;
}

/** A short id for questions ("q" + 8 base-36 chars), deterministic for a seeded rng. */
export function rngId(rng: Rng, prefix = 'q'): string {
  return prefix + Math.floor(rng() * 36 ** 8).toString(36).padStart(8, '0');
}
