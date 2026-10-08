// comparePhrase(attempt, ref, timing, opts): compares one attempt with one reference phrase and returns the
// PhraseComparison the practice screen shows (types in src/types.ts).
//
// ONE scorer (see src/trainer/README.md): trainer/score/score.ts `scoreAttempt` is the authority for the overall number, the
// pitch / timing / tone / expression sub-scores, the status gates (ok / low-evidence / no-match), the trust level (including the
// speaker-bleed "too perfect" check) and the ranked fixes. This module never computes a second overall. It adds:
//  - the per-note table, built from the scorer's own per-note readings so a flag in the table is a charge in the score
//    (a wrong note costs points; a take that scores 99 shows no flags). It contributes what the scorer does not report: note
//    names in the singer's key, "merged" notes (one sung note covering two reference notes), registers, vibrato starts;
//  - the sync model for the screen (sync offset against the schedule, confidence, drift / tempo ratio) read from the scorer's
//    fitted time model, so there is one time model, not two;
//  - tone differences as plain-words findings, gated by the same dead zones as the tone score (normalised breathiness /
//    brightness / rasp / vibrato only, never raw dB features, never "more rasp" or "louder");
//  - the shape of PhraseComparison and the flat score numbers (short phrases are rounded to the nearest 5 there).

import { compareToReference } from '../coach/reference';
import { midiToNoteName } from '../dsp/music';
import { clamp, median } from '../dsp/stats';
import type { AttemptScore, NoteCompare, PhraseComparison, PlayTiming, ReferenceComparison, ToneFinding, VoiceAnalysis } from '../types';
import { isMixReference, scoreAttempt } from './score/score';
import { toneIndexDiffs } from './score/tone';

export { LATE_EARLY_MS, OFF_CENTS as FLAT_SHARP_CENTS, WRONG_NOTE_CENTS } from './score/constants';

const nameOf = (midi: number): string => midiToNoteName(Math.round(midi));
const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * Seconds from the start of a held note until its vibrato is under way: the pitch (cents) is detrended with a
 * 0.3 s moving average, the wobble's running amplitude (0.25 s window) is compared with its maximum, and the
 * start is the first time it reaches 50 %. null when the note is under 0.6 s or has no clear wobble.
 */
export function vibratoStartDelay(a: VoiceAnalysis, t0: number, t1: number): number | null {
  const i0 = Math.max(0, Math.round(t0 / a.hopSec));
  const i1 = Math.min(a.frames.length, Math.round(t1 / a.hopSec));
  const n = i1 - i0;
  if (n * a.hopSec < 0.6) return null;
  const c: number[] = [];
  for (let i = i0; i < i1; i++) c.push(a.frames[i].voiced ? a.frames[i].midi * 100 : NaN);
  const w = Math.round(0.3 / a.hopSec) | 1;
  const dev = c.map((v, i) => {
    if (!Number.isFinite(v)) return NaN;
    let s = 0;
    let m = 0;
    for (let k = Math.max(0, i - (w >> 1)); k <= Math.min(n - 1, i + (w >> 1)); k++) if (Number.isFinite(c[k])) (s += c[k]), m++;
    return v - s / m;
  });
  const win = Math.round(0.25 / a.hopSec);
  const amp: number[] = [];
  for (let i = 0; i + win <= n; i++) {
    let ss = 0;
    let m = 0;
    for (let k = i; k < i + win; k++) if (Number.isFinite(dev[k])) (ss += dev[k] * dev[k]), m++;
    amp.push(m >= win * 0.7 ? Math.sqrt(ss / m) * Math.SQRT2 : NaN);
  }
  const finite = amp.filter(Number.isFinite);
  if (finite.length === 0) return null;
  const top = Math.max(...finite);
  if (!(top >= 12)) return null; // under ~12 cents of wobble there is nothing to time
  const first = amp.findIndex((v) => Number.isFinite(v) && v >= 0.5 * top);
  return first < 0 ? null : (first + win / 2) * a.hopSec;
}

const roundToFive = (x: number): number => Math.round(x / 5) * 5;

/**
 * Flat copy of the authority's numbers: `overall` is 0 when the scorer could not measure it (low evidence), pitch is 0 when it
 * could not measure that. For short phrases (under 5 notes or 4 s of singing, about twice as noisy) the overall is rounded to the
 * nearest 5 here, so the one number shown, stored and used for mastery is the honest one; it never rounds up to 100 below 98.
 */
export function scoresOf(score: AttemptScore): PhraseComparison['scores'] {
  let overall = score.overall ?? 0;
  if (score.overall !== null && score.diagnostics.shortPhrase === true) overall = Math.min(roundToFive(overall), overall >= 98 ? 100 : 95);
  return { overall, pitch: score.skills.pitch ?? 0, timing: score.skills.timing, tone: score.skills.tone, expression: score.skills.expression };
}

/** True when `scores.overall` was rounded to the nearest 5 because the phrase is short. */
export function scoreIsRounded(c: PhraseComparison): boolean {
  return c.score.overall !== null && c.score.diagnostics.shortPhrase === true;
}

interface TimeModel {
  lag: number;
  tempo: number;
  at(refT: number): number;
}

function timeModelOf(score: AttemptScore, rate: number): TimeModel {
  const lag = num(score.diagnostics.lagSec, 0);
  const tempo = num(score.diagnostics.tempoRaw, 1 / rate);
  return { lag, tempo, at: (t) => lag + tempo * t };
}

function blankRow(ref: VoiceAnalysis, k: number, shift: number): NoteCompare {
  const rn = ref.notes[k];
  return {
    refIndex: k,
    refStart: rn.start,
    refEnd: rn.end,
    refName: nameOf(rn.midi + shift),
    matched: false,
    userName: null,
    cents: null,
    onsetMs: null,
    durationDeltaMs: null,
    refVibrato: !!rn.vibrato,
    userVibrato: null,
    levelDeltaDb: null,
    refRegister: rn.register,
    userRegister: null,
    vibratoStartDeltaSec: null,
    flags: ['missed'],
  };
}

/**
 * The per-note table. Pitch, onset and length are the scorer's readings (key shift and constant detune removed, time lag and tempo
 * removed), flags are the scorer's settled flags. Nothing is shown for a take the scorer gated (low evidence / no match).
 */
function buildRows(ref: VoiceAnalysis, attempt: VoiceAnalysis, score: AttemptScore, model: TimeModel): NoteCompare[] {
  const shift = score.transposeSemitones;
  const rows = ref.notes.map((_, k) => blankRow(ref, k, shift));
  if (score.status !== 'ok') return rows;
  const merged = mergedNotes(ref, attempt, score, model);
  rows.forEach((row, k) => {
    const s = score.perNote[k];
    if (!s || !s.matched) return;
    const rn = ref.notes[k];
    const un = s.userIndex !== null ? attempt.notes[s.userIndex] : undefined;
    row.matched = true;
    row.refName = s.refName || row.refName;
    row.userName = s.userName;
    row.cents = s.cents;
    row.onsetMs = s.onsetMs;
    row.durationDeltaMs = s.durRatio === null ? null : (s.durRatio - 1) * (rn.end - rn.start) * model.tempo * 1000;
    row.userVibrato = s.userVibrato;
    row.userRegister = un?.register ?? null;
    row.levelDeltaDb = s.levelDeltaDb;
    row.flags = [...s.flags];
    if (un?.vibrato && rn.vibrato) {
      const a = vibratoStartDelay(attempt, un.start, un.end);
      const b = vibratoStartDelay(ref, rn.start, rn.end);
      if (a !== null && b !== null) row.vibratoStartDeltaSec = a - b * model.tempo;
    }
    if (merged.has(k)) {
      // One sung note covers this and a neighbouring reference note: there is no entrance or length of its own to judge.
      row.onsetMs = null;
      row.durationDeltaMs = null;
      row.flags = row.flags.filter((f) => f !== 'late' && f !== 'early' && f !== 'short' && f !== 'long');
      row.flags.push('merged');
    }
    if (row.flags.length === 0 || row.flags.every((f): boolean => f === 'ornament' || f === 'merged')) row.flags.unshift('ok');
  });
  return rows;
}

/** Reference notes whose time window is mostly covered by one attempt note that also covers another reference note's window. */
function mergedNotes(ref: VoiceAnalysis, attempt: VoiceAnalysis, score: AttemptScore, model: TimeModel): Set<number> {
  const spans = new Map<number, number[]>();
  ref.notes.forEach((rn, k) => {
    if (!score.perNote[k]?.matched) return;
    const eS = model.at(rn.start);
    const eE = model.at(rn.end);
    const len = eE - eS;
    if (!(len > 0)) return;
    attempt.notes.forEach((un, j) => {
      if (overlap(un.start, un.end, eS + 0.1 * len, eE - 0.1 * len) >= 0.4 * len) spans.set(j, [...(spans.get(j) ?? []), k]);
    });
  });
  const out = new Set<number>();
  for (const ks of spans.values()) if (ks.length >= 2) for (const k of ks) out.add(k);
  return out;
}

/** Share (by reference duration) of the notes that were sung and are within 50 cents of the right pitch. */
function withinFiftyOf(rows: NoteCompare[]): number {
  let sung = 0;
  let close = 0;
  for (const n of rows) {
    if (!n.matched || n.cents === null) continue;
    const d = n.refEnd - n.refStart;
    sung += d;
    if (Math.abs(n.cents) <= 50) close += d;
  }
  return sung > 0 ? close / sung : 0;
}

/** Attempt notes inside the matched stretch of the take that no reference note accounts for (added notes, a split note). */
function extraNotesOf(attempt: VoiceAnalysis, score: AttemptScore): number {
  if (score.status !== 'ok' || !score.matchedSpan) return 0;
  const used = new Set<number>();
  for (const n of score.perNote) if (n.userIndex !== null) used.add(n.userIndex);
  const { start, end } = score.matchedSpan;
  return attempt.notes.filter((n, j) => !used.has(j) && n.start >= start - 0.05 && n.end <= end + 0.05).length;
}

/** The vibrato findings are only reported while the scorer's own vibrato component also found a difference worth a point or two. */
const VIBRATO_FINDING_BELOW = 92;

function toneFindingsOf(
  ref: VoiceAnalysis,
  attempt: VoiceAnalysis,
  score: AttemptScore,
  rows: NoteCompare[],
  styleDiff: ReferenceComparison['styleDiff'],
  toneBias: PhraseOptions['toneBias'],
): ToneFinding[] {
  const out: ToneFinding[] = [];
  if (score.status !== 'ok') return out;
  const mix = isMixReference(ref);
  const comp = (id: string): number | null => score.components.find((c) => c.id === id)?.score ?? null;

  // Breathiness / brightness / rasp: past the same dead zone (key- and microphone-allowance included) the tone score uses.
  if (!mix) {
    for (const d of toneIndexDiffs(attempt.style, ref.style, score.transposeSemitones, toneBias)) {
      const strength = Math.abs(d.corrected) / d.dead;
      if (strength >= 1) out.push({ key: d.key, diff: d.corrected, strength });
    }
  }

  // Vibrato: who has it on the held notes, how fast and wide, and when it starts. Reported only where the expression score also
  // noticed. Presence is counted on the held notes the scorer judged, the same notes its vibrato component looks at.
  const vib = comp('expr.vibrato');
  if (vib !== null && vib < VIBRATO_FINDING_BELOW) {
    const judged = rows.filter((n) => n.matched && n.userVibrato !== null && (n.refVibrato || n.userVibrato));
    if (judged.length > 0) {
      const presence = (judged.filter((n) => n.userVibrato).length - judged.filter((n) => n.refVibrato).length) / judged.length;
      if (Math.abs(presence) >= 0.5) out.push({ key: 'vibratoPresence', diff: presence, strength: Math.abs(presence) / 0.5 });
    }
    const sd = styleDiff;
    if (sd.vibratoRateHz !== undefined && Math.abs(sd.vibratoRateHz) >= 1) out.push({ key: 'vibratoRateHz', diff: sd.vibratoRateHz, strength: Math.abs(sd.vibratoRateHz) });
    if (sd.vibratoExtentCents !== undefined && Math.abs(sd.vibratoExtentCents) >= 19.5) out.push({ key: 'vibratoExtentCents', diff: sd.vibratoExtentCents, strength: Math.abs(sd.vibratoExtentCents) / 19.5 });
    const starts = rows.filter((n) => n.vibratoStartDeltaSec !== null).map((n) => n.vibratoStartDeltaSec as number);
    if (starts.length >= 1 && Math.abs(median(starts)) >= 0.25) out.push({ key: 'vibratoStart', diff: median(starts), strength: Math.abs(median(starts)) / 0.25 });
  }

  if (!mix) {
    // Phrase attack: low confidence (the classification flips between renderings of one clip), so it is detail only.
    const ro = ref.onsets[0];
    const uo = attempt.onsets[0];
    if (ro && uo && ro.type !== uo.type && comp('expr.attack') !== null) out.push({ key: 'onset', diff: 0, strength: 1, detail: `${ro.type}>${uo.type}` });
    // Register: only where the scorer judged it comparable (same place against each singer's passaggio).
    const reg = comp('tone.register');
    if (reg !== null && reg < 70) {
      const mism = rows.filter((n) => n.matched && n.refRegister && n.userRegister && n.refRegister !== n.userRegister);
      if (mism.length >= 1) out.push({ key: 'register', diff: 0, strength: Math.max(1, mism.length / 2), detail: mism.map((n) => `${n.refName}:${n.refRegister}>${n.userRegister}`).join(',') });
    }
    // Relative level (each take against its own median): the scorer must have measured loudness shape too.
    if (comp('expr.dynamics') !== null) {
      const lv = rows.filter((n) => n.levelDeltaDb !== null && Math.abs(n.levelDeltaDb) >= 4);
      if (lv.length >= 2) out.push({ key: 'level', diff: median(lv.map((n) => n.levelDeltaDb as number)), strength: lv.length / 2, detail: lv.map((n) => n.refName).join(',') });
    }
  }
  return out.sort((a, b) => b.strength - a.strength);
}

export interface PhraseOptions {
  /** Inject an aligner (tests, caching). Defaults to compareToReference. */
  compare?: (u: VoiceAnalysis, r: VoiceAnalysis) => ReferenceComparison;
  /** PhraseRecord.keyHint: the transposition found last time. Narrows the key search to hint +/- 1 (a wrong hint is honoured). */
  transposeHint?: number;
  /** The singer's own microphone / room offsets (estimateToneBias / toneBiasFromAttempts), taken out before tone is judged. */
  toneBias?: Partial<Record<'breathiness' | 'brightness' | 'rasp', number>>;
  /** Judge the phrase as speech-like regardless of the reference's `issues`. */
  forceSpeech?: boolean;
  /** The guide that played was moved this many semitones (PracticeOptions.guideShift). In 'locked' key mode the singer is then expected in that key. */
  guideShift?: number;
}

export function comparePhrase(attempt: VoiceAnalysis, ref: VoiceAnalysis, timing: PlayTiming, opts: PhraseOptions = {}): PhraseComparison {
  const rate = clamp(Number.isFinite(timing.rate) ? timing.rate : 1, 0.25, 1.5);
  const singAlong = timing.mode === 'sing-along' && timing.refStartInCaptureSec !== undefined;
  const base = opts.compare ? opts.compare(attempt, ref) : compareToReference(attempt, ref, { transposeHint: opts.transposeHint });

  // The scorer is the authority; it reuses the alignment computed above.
  const score = scoreAttempt(ref, attempt, {
    mode: timing.mode,
    keyMode: timing.keyMode,
    rate,
    refStartInCaptureSec: timing.refStartInCaptureSec,
    latencyMs: timing.latencyMs,
    toneBias: opts.toneBias,
    forceSpeech: opts.forceSpeech,
    guideShift: opts.guideShift,
    compare: () => base,
  });
  const model = timeModelOf(score, rate);
  const rows = buildRows(ref, attempt, score, model);

  // Sync model for the screen: where the singing sits against the schedule (sing-along) and how fast the singer went.
  const pairs = num(score.diagnostics.onsetPairs, 0);
  const synced = singAlong && score.status === 'ok' && pairs >= 1;
  const syncOffsetMs = synced ? (model.lag - (timing.refStartInCaptureSec as number)) * 1000 : null;
  const syncConfidence: PhraseComparison['syncConfidence'] = !synced ? 'none' : pairs >= 4 ? 'high' : 'low';

  return {
    transposeSemitones: score.transposeSemitones,
    biasCents: score.keyOffsetCents,
    syncOffsetMs,
    syncConfidence,
    tempoRatio: score.status === 'ok' ? score.timing.tempoRatio : null,
    notes: rows,
    extraNotes: extraNotesOf(attempt, score),
    coverage: score.coverage,
    withinFifty: withinFiftyOf(rows),
    tone: toneFindingsOf(ref, attempt, score, rows, base.styleDiff, opts.toneBias),
    score,
    scores: scoresOf(score),
    base,
    // Speaker bleed: the "attempt" is the playback itself. The scorer decides (too tight to be a person); only meaningful with a guide playing.
    bleedSuspect: singAlong && score.diagnostics.bleedSuspect === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Per-user tone calibration helpers (the engine keeps the numbers in LibraryExport.calibration)

const BIAS_PREFIX = 'toneBias.';

/** { breathiness: 0.05 } -> { 'toneBias.breathiness': 0.05 }, for the calibration record. */
export function toneBiasToCalibration(bias: NonNullable<PhraseOptions['toneBias']>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bias)) if (typeof v === 'number' && Number.isFinite(v)) out[`${BIAS_PREFIX}${k}`] = v;
  return out;
}

/** The reverse; unknown keys and non-numbers are ignored. */
export function toneBiasFromCalibration(cal: Record<string, number> | null | undefined): NonNullable<PhraseOptions['toneBias']> {
  const out: NonNullable<PhraseOptions['toneBias']> = {};
  if (!cal) return out;
  for (const key of ['breathiness', 'brightness', 'rasp'] as const) {
    const v = cal[`${BIAS_PREFIX}${key}`];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

