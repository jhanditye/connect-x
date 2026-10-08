// scoreAttempt(ref, attempt, opts): the phrase-level scorer. Formulas are in the header of each skill module; every number is in constants.ts.

import { compareToReference } from '../../coach/reference';
import { median } from '../../dsp/stats';
import type { VoiceAnalysis } from '../../types';
import { TRACKER_CEILING_MIDI, TRACKER_FLOOR_MIDI } from '../keys';
import { alignContours } from './align';
import { COMPLETE_AT, MAX_KEY_SHIFT, MIN_REF_NOTES, NO_MATCH_RIGID, NO_MATCH_WARP_MS, MIN_VOICED_SEC, ORNAMENT_NOTE_SEC, WEIGHTS_SPEECH, WEIGHTS_SUNG } from './constants';
import { midiName, prepare } from './contour';
import { userNoteFor, type Ctx, type Insight, type SkillResult } from './ctx';
import { scoreExpression } from './expression';
import { scorePitch } from './pitch';
import { scoreTiming } from './timing';
import { scoreTone } from './tone';
import type { AttemptScore, Fix, NoteFlag, NoteScore, ScoreOptions, SkillKey } from './types';
import { clamp, round } from './util';

const SKILLS: SkillKey[] = ['pitch', 'timing', 'tone', 'expression'];

/** Fewer than this many notes, or less singing than this (s): the score rests on a few notes and is about twice as noisy. */
export const SHORT_PHRASE_NOTES = 5;
export const SHORT_PHRASE_SEC = 4;

/** A reference made from a full song (lead-vocal extraction, or a mix flagged by the quality checks): tone, level and attack are the band's. */
export function isMixReference(ref: VoiceAnalysis): boolean {
  return ref.mode === 'mix' || ref.issues.includes('accompaniment');
}

/** Short phrases are rounded to the nearest 5 when shown (see scoresOf in trainer/compare.ts). */
export function isShortPhrase(ref: VoiceAnalysis): boolean {
  return ref.notes.length < SHORT_PHRASE_NOTES || ref.voicedSec < SHORT_PHRASE_SEC;
}

/** The plain-words evidence the scorer attached to a ranked fix (its finding text), or null. */
export function fixEvidence(score: AttemptScore, fixId: string): string | null {
  const v = score.diagnostics[`fix.${fixId}`];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Reference notes that would sit outside what the pitch tracker can follow (65 Hz to 1400 Hz) in the singer's key. */
export function untrackableNotes(ref: VoiceAnalysis, shift: number): number[] {
  const out: number[] = [];
  ref.notes.forEach((n, k) => {
    const m = n.midi + shift;
    if (m < TRACKER_FLOOR_MIDI + 0.5 || m > TRACKER_CEILING_MIDI - 0.5) out.push(k);
  });
  return out;
}

const FLOOR_HINT =
  'If you sang this lower than the original: the app cannot follow pitches below about C2 (65 Hz), and this phrase would go below that an octave down. Sing it in the original octave or an octave up and try again.';

/** The tracker-floor hint for a take that could not be scored, or null when the reference sits comfortably inside the tracked range. */
function floorHint(ref: VoiceAnalysis): string | null {
  const lows = ref.notes.map((n) => n.midi);
  if (lows.length === 0) return null;
  return Math.min(...lows) - 12 < TRACKER_FLOOR_MIDI + 2 ? FLOOR_HINT : null;
}

function emptyScore(status: AttemptScore['status'], reason: string, extra: Partial<AttemptScore> = {}, hint: string | null = null): AttemptScore {
  const notes = hint ? [reason, hint] : [reason];
  return {
    status, overall: null, overallOnSung: null,
    skills: { pitch: null, timing: null, tone: null, expression: null },
    weights: { pitch: 0, timing: 0, tone: 0, expression: 0 },
    components: [], coverage: 0, completeness: 0, kind: 'sung', transposeSemitones: 0, keyOffsetCents: 0,
    timing: { lagMs: null, tempoRatio: null, onsetMadMs: null }, matchedSpan: null, perNote: [], notes, fixes: [],
    trust: { level: 'caution', reasons: notes }, diagnostics: {}, ...extra,
  };
}

/** ScoreOptions plus what the scorer needs to know about a transposed guide. */
export interface ScoreRunOptions extends ScoreOptions {
  /**
   * Semitones the guide that was playing was moved from the original (PracticeOptions.guideShift). Only matters in 'locked' key mode,
   * where the singer is expected to sing the guide's key (or an octave of it) rather than the original key.
   */
  guideShift?: number;
}

export function scoreAttempt(ref: VoiceAnalysis, attempt: VoiceAnalysis, opts: ScoreRunOptions = {}): AttemptScore {
  const mode = opts.mode ?? 'turn-taking';
  const keyMode = opts.keyMode ?? 'free';
  const rate = clamp(opts.rate ?? 1, 0.25, 1.5);

  if (ref.notes.length < MIN_REF_NOTES || ref.voicedSec < MIN_VOICED_SEC) {
    return emptyScore('low-evidence', 'The reference phrase has too little singing to score against (needs at least two notes and a second of voice).');
  }
  if (attempt.voicedSec < MIN_VOICED_SEC || attempt.notes.length < 1) {
    return emptyScore('low-evidence', attempt.voicedSec < 0.3 ? 'No singing was heard in this take. Check the microphone and try again.' : 'Too little singing was heard in this take to score (needs about a second of clear voice).', {}, floorHint(ref));
  }
  // compareToReference supplies only a first guess for the key shift; the aligner verifies it against other candidates.
  const base = (opts.compare ?? compareToReference)(attempt, ref);

  const R = prepare(ref);
  const A = prepare(attempt);
  const al = alignContours(R, A, Number.isFinite(base.transposeSemitones) ? { T: base.transposeSemitones } : null, { rate, keyMode, guideShift: opts.guideShift });
  const speech = !!opts.forceSpeech || ref.issues.includes('speech-like');
  const ornament = ref.notes.map((n) => n.end - n.start < ORNAMENT_NOTE_SEC || ref.runs.some((r) => n.start >= r.start - 0.02 && n.end <= r.end + 0.02));
  const perNote: NoteScore[] = ref.notes.map((n, k) => ({
    refIndex: k, refStart: n.start, refEnd: n.end, refName: midiName(al.refPitch[k] + al.teff), matched: false, userIndex: null, userName: null, cents: null, semitones: null,
    pitchScore: null, onsetMs: null, onsetScore: null, durRatio: null, durScore: null, levelDeltaDb: null, refVibrato: !!n.vibrato, userVibrato: null,
    contourScore: null, ornament: ornament[k], flags: ['missed'],
  }));
  const ctx: Ctx = { ref: R, att: A, al, mode, keyMode, rate, speech, perNote, ornament, toneBias: opts.toneBias ?? {} };

  // A full-mix reference measures pitch and timing from the extracted melody only: its tone and level belong to the band.
  const refIsMix = isMixReference(ref);

  const pitch = scorePitch(ctx);
  if (pitch.score === null) return emptyScore('no-match', 'Nothing in the take lines up with the reference notes. Is this the right phrase?', { transposeSemitones: al.teff }, floorHint(ref));
  const timing = scoreTiming(ctx);
  const tone: SkillResult = refIsMix ? { score: null, components: [], insights: [], stats: {} } : scoreTone(ctx, al.teff);
  const expr = scoreExpression(ctx);
  if (refIsMix) {
    // dynamics and attack are properties of the mix, not of the voice
    const keep = expr.components.filter((c) => c.id !== 'expr.dynamics' && c.id !== 'expr.attack');
    expr.components = keep;
    expr.insights = expr.insights.filter((i) => !['expr.dynamics', 'expr.level-trend', 'expr.attack', 'expr.flat'].includes(i.id));
    let w = 0;
    let s = 0;
    for (const c of keep) if (c.score !== null) (w += c.weight), (s += c.weight * c.score);
    expr.score = w > 0 ? s / w : null;
  }
  const results: Record<SkillKey, SkillResult> = { pitch, timing, tone, expression: expr };
  // bookkeeping for the UI: which attempt note covered each reference note
  perNote.forEach((n, k) => {
    if (!n.matched) return;
    const u = userNoteFor(ctx, k);
    n.userIndex = u ? attempt.notes.indexOf(u) : null;
  });

  // ---- coverage, weights, overall ---------------------------------------------------------------------------
  // Notes that would sit outside what the pitch tracker can follow in this key cannot be heard, so they are neither credited nor
  // counted as missed: the take is judged on the rest and the singer is told why (below).
  const outOfRangeAll = untrackableNotes(ref, al.teff);
  const unhearable = new Set(outOfRangeAll);
  let totalDur = 0;
  let matchedDur = 0;
  ref.notes.forEach((n, k) => {
    if (unhearable.has(k)) return;
    const d = n.end - n.start;
    totalDur += d;
    matchedDur += d * (perNote[k].matched ? 1 : al.notes[k].collapsed ? 0 : Math.min(1, al.notes[k].covered));
  });
  const coverage = totalDur > 0 ? matchedDur / totalDur : 0;
  const completeness = clamp(coverage / COMPLETE_AT, 0, 1);

  const baseW: Record<SkillKey, number> = { ...(speech ? WEIGHTS_SPEECH : WEIGHTS_SUNG), ...opts.weights };
  const weights = { pitch: 0, timing: 0, tone: 0, expression: 0 } as Record<SkillKey, number>;
  let wsum = 0;
  for (const s of SKILLS) if (results[s].score !== null) wsum += Math.max(0, baseW[s]);
  for (const s of SKILLS) weights[s] = results[s].score !== null && wsum > 0 ? Math.max(0, baseW[s]) / wsum : 0;
  const onSung = SKILLS.reduce((a, s) => a + weights[s] * (results[s].score ?? 0), 0);
  const overall = onSung * completeness;

  // Is this even the same phrase? Matched notes must be mostly near the right pitch AND roughly where the tempo model says.
  const matchedNotes = perNote.filter((n) => n.matched);
  const matchedW = matchedNotes.reduce((a, n) => a + (n.refEnd - n.refStart), 0);
  const nearPitchW = matchedNotes.reduce((a, n) => a + (Math.abs(n.cents ?? 999) <= 100 ? n.refEnd - n.refStart : 0), 0);
  const sameness = matchedW > 0 ? nearPitchW / matchedW : 0;
  const rho = al.tempo * rate;
  const tempoImplausible = al.tempoFitted && (rho < 0.6 || rho > 1.7);
  const keyImplausible = Math.abs(al.teff) > MAX_KEY_SHIFT;
  // A different phrase can be warped to look similar; what gives it away is that it does not agree with the rigid time model.
  const notSamePhrase = matchedNotes.length >= 4 && (al.rigid100 < NO_MATCH_RIGID || al.warpRmsMs > NO_MATCH_WARP_MS);
  const status: AttemptScore['status'] =
    coverage < 0.25 || (coverage < 0.4 && (pitch.score as number) < 50) || (pitch.score as number) < 12 || (!speech && sameness < 0.4) || notSamePhrase || tempoImplausible || keyImplausible
      ? 'no-match'
      : 'ok';

  // The lag is only known when at least one entrance anchored the time model; without one it would be a made-up number.
  const lagMs =
    mode === 'sing-along' && opts.refStartInCaptureSec !== undefined && al.onsetPairs.length >= 1
      ? (al.lag - opts.refStartInCaptureSec) * 1000 - (opts.latencyMs ?? 0)
      : null;

  // matched span of the attempt (everything outside it - lead-in, talking, tail - is ignored)
  let span: { start: number; end: number } | null = null;
  for (const n of al.notes) {
    if (!n.matched) continue;
    span = span ? { start: Math.min(span.start, n.u0), end: Math.max(span.end, n.u1) } : { start: n.u0, end: n.u1 };
  }

  // ---- trust ---------------------------------------------------------------------------------------------------
  const reasons: string[] = [];
  let level: AttemptScore['trust']['level'] = 'ok';
  const bump = (l: 'caution' | 'invalid', reason: string): void => {
    reasons.push(reason);
    if (l === 'invalid' || level === 'ok') level = l;
  };
  // "Too perfect": a person following a guide wobbles by tens of milliseconds and cents; a copy of the playback does not.
  let bleedSuspect = false;
  if (mode === 'sing-along' && Math.abs(al.teff) % 12 === 0 && al.onsetPairs.length >= 4) {
    const onsetRes = al.onsetPairs.map((p) => Math.abs((p.user - al.at(p.ref)) * 1000));
    const rawC = matchedNotes.map((n) => Math.abs(n.cents ?? 0) + Math.abs(al.keyOffset));
    const madOn = median(onsetRes);
    const medC = median(rawC);
    if (madOn < 12 && medC < 5) {
      bleedSuspect = true;
      bump('invalid', 'Your take matches the reference almost exactly, even its vibrato and timing. That usually means the reference leaked into the microphone. Use headphones and try again.');
    } else if (madOn < 20 && medC < 8) bump('caution', 'Your take is extremely close to the reference; if you were not wearing headphones the reference may have leaked into the microphone.');
  }
  if (attempt.issues.includes('noisy')) bump('caution', 'The recording is noisy, which blurs tone and timing measurements.');
  if (attempt.issues.includes('clipping')) bump('caution', 'The recording clips (too loud), which distorts the tone measurements.');
  if (attempt.issues.includes('too-quiet')) bump('caution', 'The recording is very quiet, so quiet notes may be missed.');
  if (mode === 'sing-along' && attempt.issues.includes('accompaniment')) bump('caution', 'The take sounds like it contains the backing; if you used speakers, use headphones.');
  if (refIsMix) bump('caution', 'The reference is a full mix: pitch and timing are compared from the extracted melody; tone and loudness are not compared.');
  if (coverage < 0.5) bump('caution', `Only ${Math.round(coverage * 100)}% of the reference phrase was matched.`);
  if (isShortPhrase(ref) || attempt.voicedSec < 2.5) bump('caution', 'This phrase is short, so the score is rough (a few notes decide it) and is shown to the nearest 5.');
  const outOfRange = status === 'no-match' ? [] : outOfRangeAll;
  const rangeLine =
    outOfRange.length === 0
      ? null
      : `${outOfRange.length === 1 ? 'One note of the original falls' : `${outOfRange.length} notes of the original fall`} outside the range the app can follow in your key (about C2, 65 Hz, up to F6), so ${outOfRange.length === 1 ? 'it' : 'they'} cannot be judged. Sing the phrase ${al.teff < 0 ? 'higher (in the original octave or an octave up)' : 'lower'}, or pick another key.`;
  if (rangeLine) bump('caution', rangeLine);
  if (speech) bump('caution', 'This phrase is speech-like: only its melody shape and rhythm are compared, not exact notes.');

  // ---- insights -> notes and fixes --------------------------------------------------------------------------
  const all: Insight[] = SKILLS.flatMap((s) => results[s].insights);
  const gain = (i: Insight): number => i.lossSkill * weights[i.skill] * completeness;
  const fixes: Fix[] = all
    .filter((i) => i.kind === 'fix' && gain(i) >= 0.7)
    .sort((a, b) => gain(b) - gain(a))
    .slice(0, 5)
    .map((i) => ({ id: i.id, skill: i.skill, title: i.title, advice: i.advice, gainPoints: round(gain(i), 1), notes: i.notes }));
  if (completeness < 0.98 && status !== 'no-match') {
    const missed = perNote.filter((n) => !n.matched && !unhearable.has(n.refIndex)).map((n) => n.refIndex);
    fixes.push({
      id: 'coverage', skill: 'pitch', title: 'Sing the whole phrase',
      advice: `Only ${Math.round(coverage * 100)}% of the reference was sung. Listen to the full phrase and sing it from first note to last${missed.length ? ` (missed: ${missed.slice(0, 4).map((k) => `note ${k + 1}`).join(', ')}${missed.length > 4 ? '...' : ''})` : ''}.`,
      gainPoints: round(onSung * (1 - completeness), 1), notes: missed,
    });
    fixes.sort((a, b) => b.gainPoints - a.gainPoints);
  }
  if (status === 'no-match') fixes.length = 0; // advice about a phrase the take does not match would only mislead
  settleFlags(perNote, fixes);
  const lines: string[] = [];
  if (status === 'no-match') lines.push('This does not line up with the reference phrase (the notes and timing are too different). Check you are singing the right phrase, then try again.');
  if (status !== 'no-match' && Math.abs(al.teff) > 0 && keyMode === 'free') {
    lines.push(`You sang this ${Math.abs(al.teff)} semitone${Math.abs(al.teff) === 1 ? '' : 's'} ${al.teff < 0 ? 'lower' : 'higher'} than the reference${Math.abs(al.teff) === 12 ? ' (an octave)' : ''}. A different key is fine and is not marked down.`);
  }
  if (keyMode === 'locked' && al.T !== al.teff) {
    const guideKey = Number.isFinite(opts.guideShift) && Math.round(opts.guideShift as number) !== 0;
    lines.push(`You sang ${Math.abs(al.T - al.teff)} semitone${Math.abs(al.T - al.teff) === 1 ? '' : 's'} ${al.T < al.teff ? 'below' : 'above'} the ${guideKey ? "guide's" : 'original'} key. With the guide playing that counts as wrong notes; switch to "my own key" if that was on purpose.`);
  }
  if (keyMode === 'free' && Math.abs(al.keyOffset) >= 20) {
    lines.push(`Your whole take sat ${Math.round(Math.abs(al.keyOffset))} cents ${al.keyOffset < 0 ? 'flat' : 'sharp'} of the nearest key to the reference. That is not marked down; it matters only if you are singing with the original track.`);
  }
  if (lagMs !== null && Math.abs(lagMs) >= 120) lines.push(`You were ${Math.round(Math.abs(lagMs))} ms ${lagMs > 0 ? 'behind' : 'ahead of'} the track throughout (not counted against note timing).`);
  if (rangeLine) lines.push(rangeLine);
  if (coverage < 0.9) lines.push(`You covered ${Math.round(coverage * 100)}% of the reference phrase.`);
  const order = fixes.map((f) => f.id);
  lines.push(...all.filter((i) => i.kind === 'fix' && order.includes(i.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map((i) => i.text));
  lines.push(...all.filter((i) => i.kind === 'info').map((i) => i.text));
  lines.push(...all.filter((i) => i.kind === 'good').map((i) => i.text).slice(0, 2));
  if (status === 'no-match') {
    const hint = floorHint(ref);
    if (hint) lines.push(hint);
  }

  const diagnostics: AttemptScore['diagnostics'] = {
    refNotes: ref.notes.length, attemptNotes: attempt.notes.length, matchedNotes: matchedNotes.length,
    tempoFitted: al.tempoFitted, lagSec: round(al.lag, 3), tempoRaw: round(al.tempo, 4), onsetPairs: al.onsetPairs.length,
    dtwFirstGuessT: base.transposeSemitones, dtwCostPerBin: round(al.dtwCostPerBin, 3), sameness: round(sameness, 3), rigid100: round(al.rigid100, 3), warpRmsMs: round(al.warpRmsMs, 0), wholePhrase: al.wholePhrase,
    shortPhrase: isShortPhrase(ref), refMix: refIsMix, bleedSuspect, outOfRangeNotes: outOfRange.length,
    ...Object.fromEntries(SKILLS.flatMap((s) => Object.entries(results[s].stats).map(([k, v]) => [`${s}.${k}`, v]))),
    ...Object.fromEntries(fixes.flatMap((f) => { const t = all.find((i) => i.id === f.id)?.text; return t ? [[`fix.${f.id}`, t]] : []; })),
  };
  const r0 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : round(clamp(x, 0, 100), 0));
  const overallRounded = r0(overall) ?? 0;
  return {
    status,
    overall: status === 'no-match' ? Math.min(20, overallRounded) : overallRounded,
    overallOnSung: r0(onSung) ?? 0,
    skills: { pitch: r0(pitch.score), timing: r0(timing.score), tone: r0(tone.score), expression: r0(expr.score) },
    weights, components: SKILLS.flatMap((s) => results[s].components), coverage: round(coverage, 3), completeness: round(completeness, 3),
    kind: speech ? 'speech-like' : 'sung', transposeSemitones: al.teff, keyOffsetCents: round(al.keyOffset, 1),
    timing: { lagMs: lagMs === null ? null : round(lagMs, 0), tempoRatio: al.tempoFitted ? round(rho, 3) : null, onsetMadMs: typeof timing.stats.onsetMadMs === 'number' ? timing.stats.onsetMadMs : null },
    matchedSpan: span, perNote, notes: lines, fixes, trust: { level, reasons }, diagnostics,
  };
}

const PITCH_SOFT: ReadonlySet<NoteFlag> = new Set(['flat', 'sharp']);
const TIMING_SOFT: ReadonlySet<NoteFlag> = new Set(['late', 'early', 'short', 'long']);

/**
 * A per-note flag is only worth showing if the score charged for it. Wrong, octave-displaced and missed notes always cost points;
 * a flat / sharp / late / early / short / long flag stays only on notes that belong to a ranked fix (a fix is shown from 0.7
 * points up), so a note a few cents past the threshold in an otherwise 99 take is not flagged. Every matched note ends up with
 * either real flags or an explicit 'ok'.
 */
function settleFlags(perNote: NoteScore[], fixes: Fix[]): void {
  const pitch = new Set<number>();
  const timing = new Set<number>();
  for (const f of fixes) {
    if (f.skill === 'pitch') f.notes.forEach((k) => pitch.add(k));
    else if (f.skill === 'timing') f.notes.forEach((k) => timing.add(k));
  }
  for (const n of perNote) {
    if (!n.matched) continue;
    n.flags = n.flags.filter((f) => !(PITCH_SOFT.has(f) && !pitch.has(n.refIndex)) && !(TIMING_SOFT.has(f) && !timing.has(n.refIndex)));
    if (n.flags.every((f): boolean => f === 'ornament')) n.flags.unshift('ok');
  }
}

/**
 * Words for a 0-100 score, from where simulated takes land (E3): a careful copy 97-100, a good amateur 88-95, a weak take 65-82,
 * a poor one 40-65. Short phrases (< 5 notes or < 4 s) are noisier (sd ~2x): show those rounded to the nearest 5.
 */
export function scoreBand(score: number): 'excellent' | 'good' | 'fair' | 'needs-work' {
  return score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'needs-work';
}
