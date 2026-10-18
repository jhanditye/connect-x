// The adaptive picker: practise what is weak most, but never only that (src/skills/SPEC.md section 5).

import { shuffle, weightedIndex, type Rng } from '../theory/rng';

/** Weight every item keeps on top of its weakness, so a strong item can still come up. */
export const ADAPTIVE_FLOOR = 0.1;
export const DEFAULT_EASY_SHARE = 0.2;

/**
 * `count` items, biased towards weak ones, in random order. Seeded: the same rng stream gives the same picks.
 *
 * - About `easyShare` of the picks (at least one when count >= 2 and easyShare > 0) come from the easiest third of the
 *   items, so a session always has some wins in it.
 * - The rest are drawn with probability proportional to `ADAPTIVE_FLOOR + weakness` (weakness clamped to 0..1, a
 *   non-finite one counts 0.5), without repeating an item until every item has been used once.
 */
export function pickAdaptive<T>(rng: Rng, items: readonly T[], weakness: (t: T) => number, count: number, easyShare: number = DEFAULT_EASY_SHARE): T[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  if (items.length === 0 || n === 0) return [];
  const w = items.map((t) => {
    const x = weakness(t);
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
  });
  const share = Number.isFinite(easyShare) ? Math.min(1, Math.max(0, easyShare)) : DEFAULT_EASY_SHARE;
  const nEasy = share > 0 && n >= 2 ? Math.min(n - 1, Math.max(1, Math.round(n * share))) : 0;

  // Easiest third (at least nEasy items when there are that many), random order among equals.
  const order = shuffle(
    rng,
    items.map((_, i) => i),
  ).sort((a, b) => w[a] - w[b]);
  const easyPool = order.slice(0, Math.min(items.length, Math.max(nEasy, Math.ceil(items.length / 3))));

  const used = new Set<number>();
  const picks: number[] = [];
  let easyBag = shuffle(rng, easyPool);
  for (let i = 0; i < nEasy; i++) {
    if (easyBag.length === 0) easyBag = shuffle(rng, easyPool);
    const idx = easyBag.pop() as number;
    picks.push(idx);
    used.add(idx);
  }
  while (picks.length < n) {
    if (used.size >= items.length) used.clear();
    const pool = items.map((_, i) => i).filter((i) => !used.has(i));
    const idx = pool[weightedIndex(rng, pool.map((i) => ADAPTIVE_FLOOR + w[i]))];
    picks.push(idx);
    used.add(idx);
  }
  return shuffle(rng, picks).map((i) => items[i]);
}
