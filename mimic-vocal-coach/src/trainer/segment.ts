// Phrase segmentation for the clip trainer: group the analysis phrases (breath-to-breath voiced runs) into practice
// phrases of 3-12 s with a dynamic programme, split over-long runs at the quietest instant, pad the edges, and offer the
// pure edit operations the review screen uses (merge, split, move a boundary, nudge an edge, hide, trim) plus the
// helpers that turn segments into stored PhraseRecords. No DOM; times are seconds in the clip.

import { median, percentile } from '../dsp/stats';
import type { PhraseRecord, PhraseSummary, VoiceAnalysis } from '../types';

export const TARGET_MIN_SEC = 3;
export const TARGET_MAX_SEC = 12;
/** Phrases (voice to voice) shorter than this are kept only if they are alone between long rests. */
export const FRAGMENT_SEC = 1.0;
export const START_PAD_SEC = 0.15;
export const END_PAD_SEC = 0.2;
/** No edit may leave a phrase window shorter than this. */
export const MIN_PHRASE_SEC = 0.8;
/** Default margin kept around the singing when a clip is trimmed to its excerpt. */
export const TRIM_MARGIN_SEC = 1;
/**
 * An edge that is moved up to a neighbouring phrase stops this far short of it, so the two stay separate windows. Only windows
 * that already touch (a split, a merge, short rests in the auto result) share a boundary that moves for both.
 */
export const EDGE_GAP_SEC = 0.001;

export interface SegPhrase {
  /** Padded window used for playback and for the phrase analysis. */
  start: number;
  end: number;
  /** First/last voiced time inside the window. */
  voicedStart: number;
  voicedEnd: number;
  /** true when it is shorter than FRAGMENT_SEC of singing (shown collapsed, excluded from practice by default). */
  fragment: boolean;
  /** 'auto' (the default) from segmentPhrases; 'user' once an edit touched it. */
  source?: 'auto' | 'user';
  /** The stored PhraseRecord this segment came from, kept by edge moves and dropped by merge and split (a new phrase has no history). */
  id?: string;
  /** The user's choice to hide (true) or keep (false) the phrase; absent means hidden exactly when it is a fragment. */
  hidden?: boolean;
  label?: string;
  lyrics?: string;
}

interface Atom {
  start: number;
  end: number;
}

const finite = (v: number): boolean => Number.isFinite(v);

/** Cost of a segment of `len` seconds (voice to voice); lower is better. */
export function lengthCost(len: number): number {
  if (len < TARGET_MIN_SEC) return 2 + 3 * (TARGET_MIN_SEC - len) ** 1.5; // too short
  if (len <= 9) return len < 4 ? 0.5 * (4 - len) : 0; // 4-9 s ideal
  if (len <= TARGET_MAX_SEC) return 0.5 * (len - 9);
  return 4 + 4 * (len - TARGET_MAX_SEC); // too long
}

/** Reward for ending a segment at a rest of `gap` seconds: real breaths are better cut points. */
export function cutReward(gap: number): number {
  return 1.6 * Math.min(gap, 1.5);
}

/** Splits [start,end) into pieces of 3-12 s at the lowest-level instants near the even split points. */
export function splitLong(a: VoiceAnalysis, start: number, end: number): Atom[] {
  const len = end - start;
  if (!(len > TARGET_MAX_SEC)) return [{ start, end }];
  const pieces = Math.ceil(len / 9);
  const hop = a.hopSec > 0 ? a.hopSec : 0.01;
  const level = (t: number): number => {
    const i = Math.max(0, Math.min(a.frames.length - 1, Math.round(t / hop)));
    // 120 ms average of rmsDb, unvoiced frames count as very quiet: a rest or consonant gap is the best cut.
    let s = 0;
    let n = 0;
    for (let k = i - 6; k <= i + 6; k++) {
      const f = a.frames[k];
      if (!f || !finite(f.rmsDb)) continue;
      s += f.voiced ? f.rmsDb : f.rmsDb - 12;
      n++;
    }
    return n ? s / n : 0;
  };
  const cuts: number[] = [];
  let from = start;
  for (let p = 1; p < pieces; p++) {
    const ideal = start + (len * p) / pieces;
    let best = ideal;
    let bestScore = Infinity;
    for (let t = Math.max(from + TARGET_MIN_SEC, ideal - 2); t <= Math.min(end - TARGET_MIN_SEC, ideal + 2); t += hop * 2) {
      const score = level(t) + 1.2 * Math.abs(t - ideal); // quiet, and not far from even
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    cuts.push(best);
    from = best;
  }
  const out: Atom[] = [];
  let s = start;
  for (const c of [...cuts, end]) {
    out.push({ start: s, end: c });
    s = c;
  }
  return out;
}

/** The analysis phrases as clean, ordered atoms: finite, non-empty, sorted by start. */
function atomsOf(a: VoiceAnalysis): Atom[] {
  return (a.phrases ?? [])
    .filter((p) => finite(p.start) && finite(p.end) && p.end > p.start)
    .map((p) => ({ start: p.start, end: p.end }))
    .sort((x, y) => x.start - y.start);
}

/** Dynamic programme over the rests between analysis phrases: the partition with the lowest total cost. */
export function segmentPhrases(a: VoiceAnalysis): SegPhrase[] {
  const atoms = atomsOf(a);
  const n = atoms.length;
  if (n === 0) return [];
  const duration = finite(a.durationSec) && a.durationSec > 0 ? a.durationSec : atoms[n - 1].end;
  // best[j] = min cost of partitioning atoms[0..j) ; from[j] = start index of the last segment.
  const best = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(0);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const len = atoms[j - 1].end - atoms[i].start;
      if (len > TARGET_MAX_SEC * 1.6 && i < j - 1) break; // no point growing further
      const gapAfter = j < n ? atoms[j].start - atoms[j - 1].end : 2;
      let cost = best[i] + lengthCost(len) - (j < n ? cutReward(gapAfter) : 0);
      // A long rest swallowed inside a segment is a missed breath.
      for (let k = i; k < j - 1; k++) cost += Math.max(0, atoms[k + 1].start - atoms[k].end - 0.9) * 1.5;
      if (cost < best[j]) {
        best[j] = cost;
        from[j] = i;
      }
    }
  }
  const groups: Atom[] = [];
  for (let j = n; j > 0; j = from[j]) groups.unshift({ start: atoms[from[j]].start, end: atoms[j - 1].end });
  const pieces = groups.flatMap((g) => splitLong(a, g.start, g.end));
  // Pad into the rests without crossing the neighbour: the cut sits halfway through a short gap.
  return pieces.map((p, idx) => {
    const prevEnd = idx > 0 ? pieces[idx - 1].end : 0;
    const nextStart = idx < pieces.length - 1 ? pieces[idx + 1].start : duration;
    const start = Math.max(0, p.start - START_PAD_SEC, p.start - Math.max(0, p.start - prevEnd) / 2);
    const end = Math.min(duration, p.end + END_PAD_SEC, p.end + Math.max(0, nextStart - p.end) / 2);
    const sung = p.end - p.start;
    return { start, end, voicedStart: p.start, voicedEnd: p.end, fragment: sung < FRAGMENT_SEC, source: 'auto' as const };
  });
}

// ---------------------------------------------------------------------------------------------
// Voiced spans and visibility

/** The span of the analysis phrases (the singing) that falls inside [start, end), or null when nothing is sung there. */
export function voicedSpan(a: VoiceAnalysis, start: number, end: number): { start: number; end: number } | null {
  let s = Infinity;
  let e = -Infinity;
  for (const atom of atomsOf(a)) {
    const lo = Math.max(atom.start, start);
    const hi = Math.min(atom.end, end);
    if (hi - lo <= 1e-6) continue;
    s = Math.min(s, lo);
    e = Math.max(e, hi);
  }
  return e > s ? { start: s, end: e } : null;
}

/** Keeps the voiced span inside the window and recomputes `fragment`. Without an analysis the span is clamped, never grown. */
function settle(p: SegPhrase, a?: VoiceAnalysis | null): SegPhrase {
  let vs = Math.min(Math.max(p.voicedStart, p.start), p.end);
  let ve = Math.min(Math.max(p.voicedEnd, p.start), p.end);
  if (a) {
    const span = voicedSpan(a, p.start, p.end);
    vs = span ? span.start : p.start;
    ve = span ? span.end : p.start;
  }
  if (ve < vs) ve = vs;
  return { ...p, voicedStart: vs, voicedEnd: ve, fragment: ve - vs < FRAGMENT_SEC };
}

/** Recomputes every phrase's voiced span and fragment flag from the analysis (after edits, before storing). */
export function refreshPhrases(list: SegPhrase[], a: VoiceAnalysis | null | undefined): SegPhrase[] {
  return list.map((p) => settle(p, a));
}

/** Hidden phrases are left out of the practice queue: the user's choice, else fragments. */
export function isHidden(p: SegPhrase): boolean {
  return p.hidden ?? p.fragment;
}

/** Hides or shows one phrase. */
export function setHidden(list: SegPhrase[], index: number, hidden: boolean): SegPhrase[] {
  if (!list[index]) return list;
  return list.map((p, i) => (i === index ? { ...p, hidden, source: 'user' as const } : p));
}

export function visiblePhrases(list: SegPhrase[]): SegPhrase[] {
  return list.filter((p) => !isHidden(p));
}

/** Seconds of singing in the phrases that will be practised. */
export function singingSec(list: SegPhrase[]): number {
  return visiblePhrases(list).reduce((s, p) => s + Math.max(0, p.voicedEnd - p.voicedStart), 0);
}

// ---------------------------------------------------------------------------------------------
// Edit operations (pure; every result keeps order, no overlap, windows of at least `min` inside the clip)

/** Merge phrase `index` with the next one. */
export function mergePhrases(list: SegPhrase[], index: number, a?: VoiceAnalysis | null): SegPhrase[] {
  if (!Number.isInteger(index) || index < 0 || index >= list.length - 1) return list;
  const p = list[index];
  const q = list[index + 1];
  const pHas = p.voicedEnd > p.voicedStart;
  const qHas = q.voicedEnd > q.voicedStart;
  const merged: SegPhrase = {
    start: p.start,
    end: q.end,
    voicedStart: pHas && qHas ? Math.min(p.voicedStart, q.voicedStart) : pHas ? p.voicedStart : q.voicedStart,
    voicedEnd: pHas && qHas ? Math.max(p.voicedEnd, q.voicedEnd) : pHas ? p.voicedEnd : q.voicedEnd,
    fragment: false,
    source: 'user',
    // Hidden only if both were; a merged phrase is a new phrase, so it has no stored id.
    hidden: p.hidden === true && q.hidden === true ? true : undefined,
  };
  return [...list.slice(0, index), settle(merged, a), ...list.slice(index + 2)];
}

/** Split a phrase at time t; both halves must be at least `min` s long. The right half is a new phrase and the left one too (no history). */
export function splitPhraseAt(list: SegPhrase[], index: number, t: number, min = MIN_PHRASE_SEC, a?: VoiceAnalysis | null): SegPhrase[] {
  const p = list[index];
  if (!p || !finite(t) || t - p.start < min - 1e-9 || p.end - t < min - 1e-9) return list;
  const left = settle({ ...p, end: t, source: 'user', id: undefined, hidden: undefined, lyrics: undefined, label: undefined }, a);
  const right = settle({ ...p, start: t, source: 'user', id: undefined, hidden: undefined, lyrics: undefined, label: undefined }, a);
  return [...list.slice(0, index), left, right, ...list.slice(index + 1)];
}

/** Move the boundary between phrase `index` and `index+1` so both windows touch at t. Keeps min length and order. */
export function moveBoundary(list: SegPhrase[], index: number, t: number, min = MIN_PHRASE_SEC, a?: VoiceAnalysis | null): SegPhrase[] {
  const p = list[index];
  const q = list[index + 1];
  if (!p || !q || !finite(t)) return list;
  const lo = p.start + min;
  const hi = q.end - min;
  if (lo > hi) return list;
  const c = Math.max(lo, Math.min(hi, t));
  return [
    ...list.slice(0, index),
    settle({ ...p, end: c, source: 'user' }, a),
    settle({ ...q, start: c, source: 'user' }, a),
    ...list.slice(index + 2),
  ];
}

export interface EdgeOptions {
  min?: number;
  /** Length of the clip, s: the last window cannot grow past it. */
  duration: number;
  a?: VoiceAnalysis | null;
}

/**
 * Move one edge of phrase `index`. The edge stops at the neighbouring window (windows never overlap), except when the
 * two windows touch: then the shared boundary moves for both, as when dragging a boundary between two phrases.
 */
export function setPhraseEdge(list: SegPhrase[], index: number, edge: 'start' | 'end', t: number, opts: EdgeOptions): SegPhrase[] {
  const p = list[index];
  if (!p || !finite(t)) return list;
  const min = opts.min ?? MIN_PHRASE_SEC;
  if (edge === 'start') {
    const prev = list[index - 1];
    const touching = !!prev && Math.abs(prev.end - p.start) < 1e-6;
    const lo = prev ? (touching ? prev.start + min : prev.end + EDGE_GAP_SEC) : 0;
    const hi = p.end - min;
    if (lo > hi) return list;
    const c = Math.max(lo, Math.min(hi, t));
    const out = list.slice();
    out[index] = settle({ ...p, start: c, source: 'user' }, opts.a);
    if (touching) out[index - 1] = settle({ ...prev, end: c, source: 'user' }, opts.a);
    return out;
  }
  const next = list[index + 1];
  const touching = !!next && Math.abs(next.start - p.end) < 1e-6;
  const lo = p.start + min;
  const hi = next ? (touching ? next.end - min : next.start - EDGE_GAP_SEC) : opts.duration;
  if (lo > hi) return list;
  const c = Math.max(lo, Math.min(hi, t));
  const out = list.slice();
  out[index] = settle({ ...p, end: c, source: 'user' }, opts.a);
  if (touching) out[index + 1] = settle({ ...next, start: c, source: 'user' }, opts.a);
  return out;
}

/** Nudge an edge by `deltaSec` (the +-50 ms buttons and the arrow keys). */
export function nudgePhraseEdge(list: SegPhrase[], index: number, edge: 'start' | 'end', deltaSec: number, opts: EdgeOptions): SegPhrase[] {
  const p = list[index];
  if (!p || !finite(deltaSec)) return list;
  return setPhraseEdge(list, index, edge, (edge === 'start' ? p.start : p.end) + deltaSec, opts);
}

/** Problems with a phrase list (empty when it is valid): order, overlap, bounds, minimum length, voiced span inside the window. */
export function validatePhrases(list: SegPhrase[], duration: number, min = MIN_PHRASE_SEC): string[] {
  const problems: string[] = [];
  list.forEach((p, i) => {
    if (![p.start, p.end, p.voicedStart, p.voicedEnd].every(finite)) problems.push(`phrase ${i + 1} has a time that is not a number`);
    if (p.start < -1e-9) problems.push(`phrase ${i + 1} starts before the clip`);
    if (p.end > duration + 1e-9) problems.push(`phrase ${i + 1} ends after the clip`);
    if (p.end - p.start < min - 1e-9) problems.push(`phrase ${i + 1} is shorter than ${min} s`);
    if (p.voicedStart < p.start - 1e-9 || p.voicedEnd > p.end + 1e-9 || p.voicedEnd < p.voicedStart - 1e-9) problems.push(`phrase ${i + 1} has its singing outside its window`);
    if (i > 0 && p.start < list[i - 1].end - 1e-9) problems.push(`phrase ${i + 1} overlaps phrase ${i}`);
  });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Trimming to an excerpt

export interface Trim {
  startSec: number;
  endSec: number;
}

/** The span that contains singing (the phrases that stay visible), with a margin, clipped to the clip. */
export function defaultTrim(list: SegPhrase[], duration: number, margin = TRIM_MARGIN_SEC): Trim {
  const sung = visiblePhrases(list).length ? visiblePhrases(list) : list;
  if (sung.length === 0 || !(duration > 0)) return { startSec: 0, endSec: Math.max(0, duration) };
  const first = Math.min(...sung.map((p) => p.voicedStart));
  const last = Math.max(...sung.map((p) => p.voicedEnd));
  const startSec = Math.max(0, first - margin);
  const endSec = Math.min(duration, last + margin);
  return endSec - startSec > 0 ? { startSec, endSec } : { startSec: 0, endSec: duration };
}

/** Clamps a requested trim into the clip and to at least `min` s. */
export function clampTrim(trim: Trim, duration: number, min = 1): Trim {
  const startSec = Math.max(0, Math.min(trim.startSec, duration - Math.min(min, duration)));
  const endSec = Math.max(startSec + Math.min(min, duration - startSec), Math.min(trim.endSec, duration));
  return { startSec, endSec };
}

/**
 * The phrases that remain after keeping only [startSec, endSec): windows are clipped to it and shifted so the excerpt starts
 * at 0. A phrase left shorter than `min` is dropped.
 */
export function applyTrim(list: SegPhrase[], trim: Trim, min = MIN_PHRASE_SEC): SegPhrase[] {
  const out: SegPhrase[] = [];
  for (const p of list) {
    const start = Math.max(p.start, trim.startSec);
    const end = Math.min(p.end, trim.endSec);
    if (end - start < min - 1e-9) continue;
    const vs = Math.min(Math.max(p.voicedStart, start), end);
    const ve = Math.min(Math.max(p.voicedEnd, start), end);
    const cut = start > p.start || end < p.end;
    out.push({
      ...p,
      start: start - trim.startSec,
      end: end - trim.startSec,
      voicedStart: vs - trim.startSec,
      voicedEnd: Math.max(vs, ve) - trim.startSec,
      fragment: Math.max(vs, ve) - vs < FRAGMENT_SEC,
      source: cut ? 'user' : p.source,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Difficulty and summaries

export interface Difficulty {
  level: 1 | 2 | 3;
  /** Plain words for what makes it harder ("fast notes", "wide range", "a run", "long"). */
  reasons: string[];
}

export const DIFFICULTY_WORDS: Record<1 | 2 | 3, string> = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };

/** A hint, not a measurement: fast notes, a wide range, a run and length make a phrase harder to copy. */
export function phraseDifficulty(a: VoiceAnalysis, p: Pick<SegPhrase, 'voicedStart' | 'voicedEnd'>): Difficulty {
  const span = Math.max(0.5, p.voicedEnd - p.voicedStart);
  const notes = a.notes.filter((n) => n.end > p.voicedStart && n.start < p.voicedEnd);
  const reasons: string[] = [];
  let points = 0;
  const rate = notes.length / span;
  if (rate >= 4.5) (points += 2, reasons.push('fast notes'));
  else if (rate >= 3) (points += 1, reasons.push('fast notes'));
  if (notes.length >= 2) {
    const range = Math.max(...notes.map((n) => n.midi)) - Math.min(...notes.map((n) => n.midi));
    if (range >= 14) (points += 2, reasons.push('wide range'));
    else if (range >= 9) (points += 1, reasons.push('wide range'));
  }
  if (a.runs.some((r) => r.end > p.voicedStart && r.start < p.voicedEnd)) (points += 1, reasons.push('a run'));
  if (span >= 10) (points += 1, reasons.push('long'));
  return { level: points <= 1 ? 1 : points <= 3 ? 2 : 3, reasons };
}

/** The clip's difficulty from its practised phrases: the rounded mean level. */
export function clipDifficulty(levels: number[]): 1 | 2 | 3 | null {
  if (levels.length === 0) return null;
  const mean = levels.reduce((s, v) => s + v, 0) / levels.length;
  return Math.max(1, Math.min(3, Math.round(mean))) as 1 | 2 | 3;
}

/** The numbers kept for a phrase in the library (from the clip's analysis; the phrase is analysed again when it is opened). */
export function summarizeSegment(a: VoiceAnalysis, p: Pick<SegPhrase, 'start' | 'end' | 'voicedStart' | 'voicedEnd'>): PhraseSummary {
  const hop = a.hopSec > 0 ? a.hopSec : 0.01;
  const midis: number[] = [];
  for (const f of a.frames) if (f.voiced && f.t >= p.voicedStart && f.t < p.voicedEnd && finite(f.midi)) midis.push(f.midi);
  const notes = a.notes.filter((n) => n.end > p.voicedStart && n.start < p.voicedEnd);
  const enough = midis.length >= 5;
  return {
    durationSec: p.end - p.start,
    voicedSec: midis.length * hop,
    medianMidi: enough ? median(midis) : null,
    lowMidi: enough ? Math.round(percentile(midis, 5)) : null,
    highMidi: enough ? Math.round(percentile(midis, 95)) : null,
    noteCount: notes.length,
    hasVibrato: notes.some((n) => n.vibrato !== null),
    // Tone per phrase is measured when the phrase is opened; the clip-level style is in ClipRecord.analysis.
    style: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Segments <-> stored records

function shifted(p: Pick<SegPhrase, 'start' | 'end' | 'voicedStart' | 'voicedEnd'>, by: number) {
  return { start: p.start + by, end: p.end + by, voicedStart: p.voicedStart + by, voicedEnd: p.voicedEnd + by };
}

export function emptySrs(): PhraseRecord['srs'] {
  return { rung: 0, dueAt: null, masteredAt: null };
}

export function emptyStats(): PhraseRecord['stats'] {
  return { attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null };
}

/**
 * A new PhraseRecord for each segment, numbered in order. `a` supplies the summaries (null leaves them empty); when the
 * segments are in an excerpt's time (shifted so the excerpt starts at 0), `offsetSec` is where the excerpt starts in the
 * analysis's time.
 */
export function toPhraseRecords(list: SegPhrase[], a: VoiceAnalysis | null, newId: () => string, offsetSec = 0): PhraseRecord[] {
  return list.map((p, index) => ({
    id: p.id ?? newId(),
    index,
    start: p.start,
    end: p.end,
    voicedStart: p.voicedStart,
    voicedEnd: p.voicedEnd,
    source: p.source ?? 'auto',
    label: p.label ?? `Phrase ${index + 1}`,
    lyrics: p.lyrics ?? '',
    hidden: isHidden(p),
    summary: a ? summarizeSegment(a, offsetSec ? shifted(p, offsetSec) : p) : null,
    keyHint: null,
    rate: 1,
    srs: emptySrs(),
    stats: emptyStats(),
  }));
}

/** Stored phrases as editable segments (the clip detail's "Edit phrases"). The ids are kept so history survives edge moves. */
export function segmentsFromRecords(records: PhraseRecord[]): SegPhrase[] {
  return records.map((r) => ({
    id: r.id,
    start: r.start,
    end: r.end,
    voicedStart: r.voicedStart,
    voicedEnd: r.voicedEnd,
    fragment: r.voicedEnd - r.voicedStart < FRAGMENT_SEC,
    source: r.source,
    hidden: r.hidden,
    label: r.label,
    lyrics: r.lyrics,
  }));
}

/**
 * Stored phrases after an edit: a segment that kept its id keeps its record (history, review state, key hint, speed) with the
 * new window; every other segment becomes a new phrase with empty history. The phrases are numbered in order and labels of
 * the form "Phrase N" follow the new numbering. Phrases whose id is gone are the ones the caller must also delete attempts for
 * (returned as `dropped`).
 */
export function remapPhraseRecords(
  existing: PhraseRecord[],
  list: SegPhrase[],
  a: VoiceAnalysis | null,
  newId: () => string,
): { phrases: PhraseRecord[]; dropped: string[] } {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const kept = new Set<string>();
  const phrases = list.map((p, index): PhraseRecord => {
    const old = p.id ? byId.get(p.id) : undefined;
    const label = p.label && !/^Phrase \d+$/.test(p.label) ? p.label : `Phrase ${index + 1}`;
    if (old) {
      kept.add(old.id);
      const moved = Math.abs(old.start - p.start) > 1e-6 || Math.abs(old.end - p.end) > 1e-6;
      return {
        ...old,
        index,
        start: p.start,
        end: p.end,
        voicedStart: p.voicedStart,
        voicedEnd: p.voicedEnd,
        source: p.source ?? old.source,
        label,
        lyrics: p.lyrics ?? old.lyrics,
        hidden: isHidden(p),
        summary: moved ? (a ? summarizeSegment(a, p) : null) : old.summary,
      };
    }
    const fresh = toPhraseRecords([{ ...p, id: undefined, label }], a, newId)[0];
    return { ...fresh, index };
  });
  return { phrases, dropped: existing.filter((r) => !kept.has(r.id)).map((r) => r.id) };
}
