import { describe, expect, it } from 'vitest';
import { analyzeTake } from '../analysis/analyze';
import { makeRng } from '../testing/synth';
import type { PhraseRecord } from '../types';
import { analysisFromSpans, KIT_RATE, soloLine, type Span } from './importTestKit';
import {
  applyTrim,
  clampTrim,
  clipDifficulty,
  defaultTrim,
  FRAGMENT_SEC,
  isHidden,
  MIN_PHRASE_SEC,
  mergePhrases,
  moveBoundary,
  nudgePhraseEdge,
  phraseDifficulty,
  refreshPhrases,
  remapPhraseRecords,
  segmentPhrases,
  segmentsFromRecords,
  setHidden,
  setPhraseEdge,
  singingSec,
  splitLong,
  splitPhraseAt,
  summarizeSegment,
  TARGET_MAX_SEC,
  TARGET_MIN_SEC,
  toPhraseRecords,
  validatePhrases,
  visiblePhrases,
  voicedSpan,
  type SegPhrase,
} from './segment';

const spans = (...list: [number, number][]): Span[] => list.map(([start, end]) => ({ start, end }));
let idCounter = 0;
const newId = () => `id${++idCounter}`;

function seg(start: number, end: number, extra: Partial<SegPhrase> = {}): SegPhrase {
  return { start, end, voicedStart: start + 0.2, voicedEnd: end - 0.2, fragment: false, source: 'auto', ...extra };
}

describe('segmentPhrases', () => {
  it('returns nothing for an analysis without phrases and ignores broken ones', () => {
    expect(segmentPhrases(analysisFromSpans([], 10))).toEqual([]);
    const a = analysisFromSpans(spans([1, 5]), 8);
    a.phrases = [{ start: NaN, end: 3 }, { start: 4, end: 2 }, { start: 1, end: 5 }];
    expect(segmentPhrases(a)).toHaveLength(1);
  });

  it('keeps breath-separated phrases of 3-12 s as they are and pads them into the rests without overlap', () => {
    const a = analysisFromSpans(spans([1, 6], [7, 12.5], [14, 20], [21, 25.5]), 27);
    const out = segmentPhrases(a);
    expect(out).toHaveLength(4);
    out.forEach((p, i) => {
      expect(p.voicedEnd - p.voicedStart).toBeGreaterThanOrEqual(TARGET_MIN_SEC);
      expect(p.voicedEnd - p.voicedStart).toBeLessThanOrEqual(TARGET_MAX_SEC);
      expect(p.source).toBe('auto');
      expect(p.fragment).toBe(false);
      expect(isHidden(p)).toBe(false);
      if (i > 0) expect(p.start).toBeGreaterThanOrEqual(out[i - 1].end);
    });
    expect(validatePhrases(out, 27)).toEqual([]);
    // Padded 0.15 s before and 0.2 s after where the rest allows it, never past half the gap.
    expect(out[0].start).toBeCloseTo(0.85, 6);
    expect(out[0].end).toBeCloseTo(6.2, 6);
    expect(out[1].start).toBeCloseTo(6.85, 6);
  });

  it('groups short breath runs into practice phrases and cuts the over-long ones', () => {
    // Eight 1.4 s runs with 0.4 s breaths: far too short alone.
    const short = analysisFromSpans(spans(...[0, 1, 2, 3, 4, 5, 6, 7].map((i): [number, number] => [1 + i * 1.8, 2.4 + i * 1.8])), 17);
    const groups = segmentPhrases(short);
    expect(groups.length).toBeLessThan(8);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(g.voicedEnd - g.voicedStart).toBeGreaterThanOrEqual(TARGET_MIN_SEC - 0.5);

    // One unbroken 30 s run is split into 3-12 s pieces.
    const long = analysisFromSpans([{ start: 1, end: 31, noteRate: 4 }], 33);
    const pieces = segmentPhrases(long);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) {
      expect(p.voicedEnd - p.voicedStart).toBeGreaterThanOrEqual(TARGET_MIN_SEC);
      expect(p.voicedEnd - p.voicedStart).toBeLessThanOrEqual(TARGET_MAX_SEC);
    }
    expect(validatePhrases(pieces, 33)).toEqual([]);
  });

  it('prefers the quietest instant when it cuts an unbroken run', () => {
    const a = analysisFromSpans([{ start: 0.5, end: 26.5, noteRate: 4 }], 28);
    // A real dip in level a second from the even split point (the first even cut is near 9.2 s).
    for (const f of a.frames) if (f.t > 10.0 && f.t < 10.3) f.rmsDb = -70;
    const pieces = splitLong(a, 0.5, 26.5);
    expect(pieces).toHaveLength(3);
    expect(pieces[0].end).toBeGreaterThan(9.9);
    expect(pieces[0].end).toBeLessThan(10.4);
  });

  it('marks a lone blip of singing as a fragment, hidden by default', () => {
    // Too far from both neighbours to be worth joining to either.
    const a = analysisFromSpans(spans([1, 7], [22, 22.5], [40, 46]), 48);
    const out = segmentPhrases(a);
    const blip = out.find((p) => p.voicedEnd - p.voicedStart < FRAGMENT_SEC);
    expect(blip).toBeDefined();
    expect(blip!.fragment).toBe(true);
    expect(isHidden(blip!)).toBe(true);
    expect(visiblePhrases(out)).toHaveLength(out.length - 1);
  });

  it('segments real analysed audio: a synthetic solo line with five breaths gives five phrases of 3-12 s', () => {
    const a = analyzeTake(soloLine({ count: 5, noteCount: 8 }), KIT_RATE, { voiceType: 'tenor' });
    const out = segmentPhrases(a);
    expect(out.length).toBe(5);
    for (const p of out) {
      expect(p.voicedEnd - p.voicedStart).toBeGreaterThanOrEqual(3);
      expect(p.voicedEnd - p.voicedStart).toBeLessThanOrEqual(12);
      expect(p.start).toBeGreaterThanOrEqual(0);
      expect(p.end).toBeLessThanOrEqual(a.durationSec + 1e-9);
    }
    expect(validatePhrases(out, a.durationSec)).toEqual([]);
  }, 20000);
});

describe('edit operations', () => {
  const base = (): SegPhrase[] => [seg(0, 6), seg(6, 12), seg(13, 20)];

  it('merges two neighbours into one new phrase that spans both voiced spans', () => {
    const list = base().map((p, i) => ({ ...p, id: `p${i}` }));
    const out = mergePhrases(list, 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ start: 0, end: 12, voicedStart: 0.2, voicedEnd: 11.8, source: 'user', fragment: false });
    expect(out[0].id).toBeUndefined();
    expect(out[1].id).toBe('p2');
    expect(mergePhrases(list, 2)).toBe(list);
    expect(mergePhrases(list, -1)).toBe(list);
    expect(mergePhrases(list, 0.5)).toBe(list);
  });

  it('keeps a merged phrase visible unless both parts were hidden', () => {
    const list = [seg(0, 6, { hidden: true }), seg(6, 12), seg(12, 18, { hidden: true }), seg(18, 24, { hidden: true })];
    expect(isHidden(mergePhrases(list, 0)[0])).toBe(false);
    expect(isHidden(mergePhrases(list, 2)[2])).toBe(true);
  });

  it('splits a phrase at a time that leaves both halves long enough, and refuses otherwise', () => {
    const list = base();
    const out = splitPhraseAt(list, 0, 3);
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ start: 0, end: 3, voicedStart: 0.2, voicedEnd: 3 });
    expect(out[1]).toMatchObject({ start: 3, end: 6, voicedStart: 3, voicedEnd: 5.8 });
    expect(out.slice(0, 2).every((p) => p.source === 'user')).toBe(true);
    expect(out[2].source).toBe('auto');
    expect(validatePhrases(out, 20)).toEqual([]);
    expect(splitPhraseAt(list, 0, 0.5)).toBe(list);
    expect(splitPhraseAt(list, 0, 5.5)).toBe(list);
    expect(splitPhraseAt(list, 0, NaN)).toBe(list);
    expect(splitPhraseAt(list, 7, 3)).toBe(list);
  });

  it('gives neither half the old id, so a split phrase starts without history', () => {
    const out = splitPhraseAt([seg(0, 6, { id: 'p0', label: 'Verse', lyrics: 'la' })], 0, 3);
    expect(out.map((p) => p.id)).toEqual([undefined, undefined]);
    expect(out.map((p) => p.label)).toEqual([undefined, undefined]);
  });

  it('keeps the voiced span valid when a split lands in the quiet tail of the window', () => {
    // Window 0-6 with singing only until 2: a cut at 4 leaves the right half with no singing at all.
    const out = splitPhraseAt([seg(0, 6, { voicedEnd: 2 })], 0, 4);
    expect(out[1].voicedEnd).toBeGreaterThanOrEqual(out[1].voicedStart);
    expect(out[1].fragment).toBe(true);
    expect(validatePhrases(out, 6)).toEqual([]);
  });

  it('moves a shared boundary within both windows', () => {
    const list = base();
    const out = moveBoundary(list, 0, 8);
    expect(out[0].end).toBe(8);
    expect(out[1].start).toBe(8);
    expect(out[0].voicedEnd).toBe(5.8);
    expect(out[1].voicedStart).toBe(8);
    // Clamped so that both phrases keep MIN_PHRASE_SEC.
    expect(moveBoundary(list, 0, 100)[0].end).toBeCloseTo(12 - MIN_PHRASE_SEC, 6);
    expect(moveBoundary(list, 0, -5)[0].end).toBeCloseTo(MIN_PHRASE_SEC, 6);
    expect(moveBoundary(list, 2, 15)).toBe(list);
    expect(moveBoundary(list, 0, NaN)).toBe(list);
  });

  it('moves one edge, stopping at a neighbour that does not touch', () => {
    const list = base(); // phrase 2 (13-20) is separated from phrase 1 (6-12) by a 1 s gap
    const dur = 22;
    expect(setPhraseEdge(list, 2, 'start', 11, { duration: dur })[2].start).toBeCloseTo(12, 2); // stops just short of the neighbour's end
    expect(setPhraseEdge(list, 2, 'start', 11, { duration: dur })[2].start).toBeGreaterThan(12);
    expect(setPhraseEdge(list, 2, 'start', 11, { duration: dur })[1]).toEqual(list[1]);
    expect(setPhraseEdge(list, 2, 'end', 30, { duration: dur })[2].end).toBe(22); // stops at the clip end
    expect(setPhraseEdge(list, 2, 'end', 13.1, { duration: dur })[2].end).toBeCloseTo(13 + MIN_PHRASE_SEC, 6);
    expect(setPhraseEdge(list, 0, 'start', -3, { duration: dur })[0].start).toBe(0);
  });

  it('moves a touching boundary for both phrases', () => {
    const list = base();
    const out = setPhraseEdge(list, 1, 'start', 7, { duration: 22 });
    expect(out[0].end).toBe(7);
    expect(out[1].start).toBe(7);
    const out2 = setPhraseEdge(list, 0, 'end', 5, { duration: 22 });
    expect(out2[0].end).toBe(5);
    expect(out2[1].start).toBe(5);
    expect(validatePhrases(out2, 22)).toEqual([]);
  });

  it('nudges an edge by 50 ms and keeps ids so a nudged phrase keeps its history', () => {
    const list = [seg(1, 7, { id: 'a' }), seg(9, 15, { id: 'b' })];
    const out = nudgePhraseEdge(list, 1, 'start', -0.05, { duration: 20 });
    expect(out[1].start).toBeCloseTo(8.95, 6);
    expect(out[1].id).toBe('b');
    expect(out[1].source).toBe('user');
    expect(nudgePhraseEdge(list, 1, 'start', NaN, { duration: 20 })).toBe(list);
    expect(nudgePhraseEdge(list, 5, 'start', 0.05, { duration: 20 })).toBe(list);
  });

  it('hides and shows phrases', () => {
    const list = [seg(0, 6), seg(6, 12, { fragment: true })];
    expect(isHidden(list[1])).toBe(true);
    expect(setHidden(list, 1, false).map(isHidden)).toEqual([false, false]);
    expect(setHidden(list, 0, true).map(isHidden)).toEqual([true, true]);
    expect(setHidden(list, 5, true)).toBe(list);
    expect(singingSec(list)).toBeCloseTo(5.6, 6);
  });

  it('recomputes voiced spans and the fragment flag from the analysis', () => {
    const a = analysisFromSpans(spans([1, 5], [8, 8.4], [12, 18]), 20);
    const out = refreshPhrases([seg(0, 6), seg(7, 9), seg(11, 19)], a);
    expect(out[0]).toMatchObject({ voicedStart: 1, voicedEnd: 5, fragment: false });
    expect(out[1]).toMatchObject({ voicedStart: 8, voicedEnd: 8.4, fragment: true });
    expect(out[2]).toMatchObject({ voicedStart: 12, voicedEnd: 18, fragment: false });
    expect(voicedSpan(a, 5.2, 7.9)).toBeNull();
    expect(voicedSpan(a, 0, 3)).toEqual({ start: 1, end: 3 });
    const none = refreshPhrases([seg(5.5, 7)], a)[0];
    expect(none.voicedEnd).toBe(none.voicedStart);
    expect(none.fragment).toBe(true);
  });

  it('keeps every invariant through hundreds of random edits', () => {
    const rng = makeRng(42);
    const duration = 60;
    const a = analysisFromSpans(spans([1, 7], [9, 15], [17, 24], [27, 33], [36, 41], [44, 52], [54, 58]), duration);
    let list = segmentPhrases(a);
    expect(validatePhrases(list, duration)).toEqual([]);
    for (let step = 0; step < 400; step++) {
      const i = Math.floor(rng() * list.length);
      const t = rng() * duration * 1.1 - 2;
      const op = Math.floor(rng() * 7);
      if (op === 0) list = mergePhrases(list, i, a);
      else if (op === 1) list = splitPhraseAt(list, i, t, MIN_PHRASE_SEC, a);
      else if (op === 2) list = moveBoundary(list, i, t, MIN_PHRASE_SEC, a);
      else if (op === 3) list = setPhraseEdge(list, i, rng() < 0.5 ? 'start' : 'end', t, { duration, a });
      else if (op === 4) list = nudgePhraseEdge(list, i, rng() < 0.5 ? 'start' : 'end', (rng() - 0.5) * 0.4, { duration, a });
      else if (op === 5) list = setHidden(list, i, rng() < 0.5);
      else if (list.length < 3) list = splitPhraseAt(list, 0, list[0].start + 2, MIN_PHRASE_SEC, a);
      expect(validatePhrases(list, duration)).toEqual([]);
      for (const p of list) expect(p.fragment).toBe(p.voicedEnd - p.voicedStart < FRAGMENT_SEC);
    }
  });
});

describe('validatePhrases', () => {
  it('reports order, overlap, bounds, minimum length and voiced spans outside the window', () => {
    expect(validatePhrases([seg(0, 6), seg(6, 12)], 12)).toEqual([]);
    expect(validatePhrases([seg(0, 6), seg(5, 12)], 12).join()).toMatch(/phrase 2 overlaps phrase 1/);
    expect(validatePhrases([seg(0, 6)], 5).join()).toMatch(/ends after the clip/);
    expect(validatePhrases([seg(-1, 6)], 12).join()).toMatch(/starts before the clip/);
    expect(validatePhrases([seg(0, 0.5)], 12).join()).toMatch(/shorter than 0.8 s/);
    expect(validatePhrases([seg(0, 6, { voicedEnd: 7 })], 12).join()).toMatch(/singing outside its window/);
    expect(validatePhrases([seg(0, 6, { voicedStart: NaN })], 12).join()).toMatch(/not a number/);
  });
});

describe('trimming to an excerpt', () => {
  it('defaults to the singing with a margin, clipped to the clip', () => {
    const list = [seg(8, 14), seg(16, 22), seg(24, 26, { fragment: true })];
    const t = defaultTrim(list, 40);
    expect(t.startSec).toBeCloseTo(7.2, 6);
    expect(t.endSec).toBeCloseTo(22.8, 6);
    expect(defaultTrim([seg(0, 6)], 6.5)).toEqual({ startSec: 0, endSec: 6.5 });
    expect(defaultTrim([], 30)).toEqual({ startSec: 0, endSec: 30 });
  });

  it('clamps a requested trim into the clip and to one second', () => {
    expect(clampTrim({ startSec: -4, endSec: 99 }, 30)).toEqual({ startSec: 0, endSec: 30 });
    expect(clampTrim({ startSec: 10, endSec: 10.1 }, 30)).toEqual({ startSec: 10, endSec: 11 });
    expect(clampTrim({ startSec: 29.9, endSec: 30 }, 30)).toEqual({ startSec: 29, endSec: 30 });
  });

  it('shifts phrases to the excerpt, clips the ones it cuts, and drops those left too short', () => {
    const list = [seg(2, 8, { id: 'a' }), seg(9, 15, { id: 'b' }), seg(16, 22, { id: 'c' })];
    const out = applyTrim(list, { startSec: 7, endSec: 17 });
    // 'a' keeps only 7-8 (1 s), 'b' is whole, 'c' keeps 16-17 (1 s).
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toMatchObject({ start: 0, end: 1 });
    expect(out[1]).toMatchObject({ start: 2, end: 8, source: 'auto' });
    expect(out[0].source).toBe('user');
    const tight = applyTrim(list, { startSec: 7.5, endSec: 16.5 });
    expect(tight.map((p) => p.id)).toEqual(['b']);
    expect(validatePhrases(out, 10)).toEqual([]);
    for (const p of out) expect(p.voicedStart).toBeGreaterThanOrEqual(p.start);
  });
});

describe('difficulty and summaries', () => {
  it('rates fast, wide, long phrases harder and names why', () => {
    const easy = analysisFromSpans([{ start: 1, end: 6, noteRate: 1.5 }], 8);
    expect(phraseDifficulty(easy, { voicedStart: 1, voicedEnd: 6 })).toEqual({ level: 1, reasons: [] });
    const fast = analysisFromSpans([{ start: 1, end: 6, noteRate: 5 }], 8);
    const d = phraseDifficulty(fast, { voicedStart: 1, voicedEnd: 6 });
    expect(d.reasons).toContain('fast notes');
    expect(d.level).toBeGreaterThanOrEqual(2);
    const hard = analysisFromSpans([{ start: 1, end: 12, noteRate: 6 }], 14);
    hard.notes.forEach((n, i) => (n.midi = 50 + (i % 2) * 18));
    hard.runs = [{ start: 3, end: 5, noteCount: 8, notesPerSec: 4 }];
    const h = phraseDifficulty(hard, { voicedStart: 1, voicedEnd: 12 });
    expect(h.level).toBe(3);
    expect(h.reasons).toEqual(expect.arrayContaining(['fast notes', 'wide range', 'a run', 'long']));
  });

  it('turns phrase levels into one clip difficulty', () => {
    expect(clipDifficulty([])).toBeNull();
    expect(clipDifficulty([1, 1, 2])).toBe(1);
    expect(clipDifficulty([1, 2, 3])).toBe(2);
    expect(clipDifficulty([3, 3, 3, 2])).toBe(3);
  });

  it('summarises a phrase from the analysis frames and notes', () => {
    const a = analysisFromSpans([{ start: 1, end: 7, midi: 60, noteRate: 2, vibrato: true }], 9);
    const s = summarizeSegment(a, { start: 0.85, end: 7.2, voicedStart: 1, voicedEnd: 7 });
    expect(s.durationSec).toBeCloseTo(6.35, 6);
    expect(s.voicedSec).toBeGreaterThan(4.5);
    expect(s.voicedSec).toBeLessThanOrEqual(6);
    expect(s.medianMidi).toBeGreaterThanOrEqual(60);
    expect(s.lowMidi).toBe(60);
    expect(s.highMidi).toBeLessThanOrEqual(64);
    expect(s.noteCount).toBeGreaterThanOrEqual(10);
    expect(s.hasVibrato).toBe(true);
    expect(s.style).toBeNull();
    const none = summarizeSegment(a, { start: 7.5, end: 9, voicedStart: 7.5, voicedEnd: 8 });
    expect(none).toMatchObject({ medianMidi: null, lowMidi: null, highMidi: null, noteCount: 0, hasVibrato: false });
  });
});

describe('stored phrase records', () => {
  const a = analysisFromSpans(spans([1, 7], [9, 15]), 17);

  it('numbers the phrases, hides fragments and starts with empty history', () => {
    const list: SegPhrase[] = [seg(0.85, 7.2, { voicedStart: 1, voicedEnd: 7 }), seg(8.8, 15.2, { voicedStart: 9, voicedEnd: 9.5, fragment: true })];
    const recs = toPhraseRecords(list, a, newId);
    expect(recs.map((r) => [r.index, r.label, r.hidden, r.source])).toEqual([
      [0, 'Phrase 1', false, 'auto'],
      [1, 'Phrase 2', true, 'auto'],
    ]);
    expect(new Set(recs.map((r) => r.id)).size).toBe(2);
    expect(recs[0].srs).toEqual({ rung: 0, dueAt: null, masteredAt: null });
    expect(recs[0].stats).toEqual({ attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null });
    expect(recs[0].keyHint).toBeNull();
    expect(recs[0].rate).toBe(1);
    expect(recs[0].summary?.noteCount).toBeGreaterThan(0);
    expect(toPhraseRecords(list, null, newId)[0].summary).toBeNull();
  });

  it('remaps edited segments onto stored records: ids keep history, structural edits make new phrases', () => {
    const recs: PhraseRecord[] = toPhraseRecords([seg(0.85, 7.2, { voicedStart: 1, voicedEnd: 7 }), seg(8.8, 15.2, { voicedStart: 9, voicedEnd: 15 })], a, newId).map((r, i) => ({
      ...r,
      keyHint: -12,
      rate: 0.75,
      label: i === 0 ? 'Chorus' : r.label,
      stats: { attempts: 3, fullSpeedAttempts: 2, best: 88, last: 80, recent: [70, 80], lastAt: 5 },
    }));
    const segs = segmentsFromRecords(recs);
    expect(segs[0]).toMatchObject({ id: recs[0].id, label: 'Chorus', source: 'auto' });

    // Nudge phrase 1's end: the record keeps its history with the new window.
    const nudged = nudgePhraseEdge(segs, 0, 'end', 0.1, { duration: 17 });
    const r1 = remapPhraseRecords(recs, nudged, a, newId);
    expect(r1.dropped).toEqual([]);
    expect(r1.phrases[0]).toMatchObject({ id: recs[0].id, label: 'Chorus', keyHint: -12, rate: 0.75, end: 7.3 });
    expect(r1.phrases[0].stats.attempts).toBe(3);
    expect(r1.phrases[1].summary).toEqual(recs[1].summary);

    // Merge both: one new phrase, both old ids dropped.
    const merged = mergePhrases(segs, 0, a);
    const r2 = remapPhraseRecords(recs, merged, a, newId);
    expect(r2.phrases).toHaveLength(1);
    expect(r2.phrases[0].id).not.toBe(recs[0].id);
    expect(r2.phrases[0].stats.attempts).toBe(0);
    expect(r2.dropped.sort()).toEqual([recs[0].id, recs[1].id].sort());
    expect(r2.phrases[0].label).toBe('Phrase 1');

    // Split one: the halves are new and renumbered, the other phrase is renumbered but keeps its record.
    const split = splitPhraseAt(segs, 0, 4, MIN_PHRASE_SEC, a);
    const r3 = remapPhraseRecords(recs, split, a, newId);
    expect(r3.phrases.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(r3.phrases[2].id).toBe(recs[1].id);
    expect(r3.phrases[2].label).toBe('Phrase 3');
    expect(r3.dropped).toEqual([recs[0].id]);
  });
});
