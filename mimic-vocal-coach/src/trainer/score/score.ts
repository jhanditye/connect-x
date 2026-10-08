// scoreAttempt(ref, attempt, opts): the phrase-level scorer. Formulas are in the header of each skill module; every number is in constants.ts.

import { leadExtractionOf } from '../../analysis/mixMode';
import { compareToReference } from '../../coach/reference';
import { median } from '../../dsp/stats';
import type { VoiceAnalysis } from '../../types';
import { TRACKER_CEILING_MIDI, TRACKER_FLOOR_MIDI } from '../keys';
import { alignContours } from './align';
import { COMPLETE_AT, DOUBTFUL_NOTE_TRUST, EXCELLENT_IF_PITCH_LOOSE, EXCELLENT_PITCH_MIN, ROUGH_CONFIDENCE, ROUGH_NOTE_RATIO, ROUGH_SPAN_SHARE, QUIET_VOICED_DB, FIX_LISTED_POINTS, FIX_ONLY_BELOW, FIX_SHOWN_POINTS, LATE_EARLY_MS, MAX_KEY_SHIFT, OFF_CENTS, MIN_REF_NOTES, NO_MATCH_RIGID, NO_MATCH_WARP_MS, MIN_VOICED_SEC, ORNAMENT_NOTE_SEC, WEIGHTS_SPEECH, WEIGHTS_SUNG } from './constants';
import { midiName, prepare } from './contour';
import { userNoteFor, type Ctx, type Insight, type SkillResult } from './ctx';
import { scoreExpression } from './expression';
import { scorePitch } from './pitch';
import { stretchAnalysis } from './stretch';
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
  /**
   * The speed the guide was played at (0.5..1, default 1; falls back to `rate`). A take that follows a slowed guide runs 1 / guideRate
   * times longer than the reference, so the reference is laid out at that speed before the alignment and tempo is judged against it:
   * a perfect copy at 50 % is a perfect copy. Everything reported (note windows, entrances) stays in the reference's own time.
   */
  guideRate?: number;
}

export function scoreAttempt(ref: VoiceAnalysis, attempt: VoiceAnalysis, opts: ScoreRunOptions = {}): AttemptScore {
  const mode = opts.mode ?? 'turn-taking';
  const keyMode = opts.keyMode ?? 'free';
  const rate = clamp(opts.guideRate ?? opts.rate ?? 1, 0.25, 1.5);

  if (ref.notes.length < MIN_REF_NOTES || ref.voicedSec < MIN_VOICED_SEC) {
    return emptyScore('low-evidence', 'The reference phrase has too little singing to score against (needs at least two notes and a second of voice).');
  }
  if (attempt.voicedSec < MIN_VOICED_SEC || attempt.notes.length < 1) {
    return emptyScore('low-evidence', attempt.voicedSec < 0.3 ? 'No singing was heard in this take. Check the microphone and try again.' : 'Too little singing was heard in this take to score (needs about a second of clear voice).', {}, floorHint(ref));
  }
  // compareToReference supplies only a first guess for the key shift; the aligner verifies it against other candidates.
  const base = (opts.compare ?? compareToReference)(attempt, ref);

  // the reference as it was played: the take is expected to follow it at tempo 1 (see ScoreRunOptions.guideRate)
  const R = prepare(stretchAnalysis(ref, 1 / rate));
  const A = prepare(attempt);
  const al = alignContours(R, A, Number.isFinite(base.transposeSemitones) ? { T: base.transposeSemitones } : null, { rate: 1, keyMode, guideShift: opts.guideShift });
  const speech = !!opts.forceSpeech || ref.issues.includes('speech-like');
  const ornament = ref.notes.map((n) => n.end - n.start < ORNAMENT_NOTE_SEC || ref.runs.some((r) => n.start >= r.start - 0.02 && n.end <= r.end + 0.02));
  const perNote: NoteScore[] = ref.notes.map((n, k) => ({
    refIndex: k, refStart: n.start, refEnd: n.end, refName: midiName(al.refPitch[k] + al.teff), matched: false, userIndex: null, userName: null, cents: null, semitones: null,
    pitchScore: null, onsetMs: null, onsetScore: null, durRatio: null, durScore: null, levelDeltaDb: null, refVibrato: !!n.vibrato, userVibrato: null,
    contourScore: null, ornament: ornament[k], flags: ['missed'],
  }));
  // ---- is the reference's melody a rough guide? --------------------------------------------------------------------------
  // The melody extracted from a full song can contain the band (a bass line, a chord tone, a harmony): then the reference has more notes
  // than the singer sang, and the score would blame the singer for notes nobody was meant to sing. What gives it away is the singer's
  // side: the original has well over a third more notes than the take, and the take still spans most of the original. A half-sung
  // take is short on span instead, so it is still told to finish the phrase. A solo-read reference needs the 'noisy' flag as well
  // (a singer who simplifies a run also sings fewer notes than the original). A low extractor confidence (a ranking, not a promise)
  // counts too, and is the reason such a take is not counted toward mastery.
  const fullSong = isMixReference(ref);
  const lead = leadExtractionOf(ref);
  const refConfidence = lead?.confidence ?? null;
  // The extractor's own estimate of which of its notes are the lead voice (absent on older analyses and on solo ones). A doubtful note is as
  // likely a bass or guitar note as a sung one: not charging a take for missing it, or for singing something else there, is the honest reading.
  const doubtful = new Set<number>();
  if (fullSong && lead?.noteTrust) lead.noteTrust.forEach((t, k) => (t < DOUBTFUL_NOTE_TRUST ? doubtful.add(k) : undefined));
  const noteRatio = ref.notes.length / Math.max(1, attempt.notes.length);
  const alMatched = al.notes.filter((n) => n.matched);
  const refSpanSec = ref.notes[ref.notes.length - 1].end - ref.notes[0].start;
  const spanShare = alMatched.length > 0 && refSpanSec > 0 ? (Math.max(...alMatched.map((n) => ref.notes[n.k].end)) - Math.min(...alMatched.map((n) => ref.notes[n.k].start))) / refSpanSec : 0;
  const excessNotes = noteRatio >= ROUGH_NOTE_RATIO && spanShare >= ROUGH_SPAN_SHARE && alMatched.length >= 3;
  // an uncertain extraction: a low clip confidence, or the extractor's own verdict that too much of what it found is the band (the confidence
  // stays high when it follows a moving bass line, which is why the second test exists)
  const lowConfidence = fullSong && ((refConfidence !== null && refConfidence < ROUGH_CONFIDENCE) || lead?.roughGuide === true);
  const soloBand = !fullSong && excessNotes && ref.issues.includes('noisy');
  const rough = !speech && ((fullSong && (excessNotes || lowConfidence)) || soloBand);
  // What a rough guide forgives (the notes the take did not sing, a far-off answer to a note) only applies to a take that spans most of
  // the original: one that stopped halfway has not "missed the band's notes", it has stopped.
  const forgive = rough && spanShare >= ROUGH_SPAN_SHARE;
  // ...and so does doubting a note: the half of a phrase a singer did not get to is not "probably the band's" because the extractor was unsure of it
  if (spanShare < ROUGH_SPAN_SHARE) doubtful.clear();
  const ctx: Ctx = { ref: R, att: A, al, mode, keyMode, rate, speech, perNote, ornament, toneBias: opts.toneBias ?? {}, rough: forgive, doubtful };

  // A full-mix reference measures pitch and timing from the extracted melody only: its tone and level belong to the band.
  const refIsMix = fullSong || soloBand;

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
    if (unhearable.has(k) || (doubtful.has(k) && !perNote[k].matched)) return; // not heard, or probably not sung by the lead voice in the first place
    const d = n.end - n.start;
    totalDur += d;
    matchedDur += d * (perNote[k].matched ? 1 : al.notes[k].collapsed ? 0 : Math.min(1, al.notes[k].covered));
  });
  const coverage = totalDur > 0 ? matchedDur / totalDur : 0;
  // In a rough guide the notes the take did not sing are probably the band's: they are not held against it (the coverage figure stays
  // honest, and keeps such a take from counting as a full-phrase attempt when most of the reference was not matched).
  const completeness = forgive ? 1 : clamp(coverage / COMPLETE_AT, 0, 1);

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
  const rho = al.tempo; // relative to the speed the guide was played at
  const tempoImplausible = al.tempoFitted && (rho < 0.6 || rho > 1.7);
  const keyImplausible = Math.abs(al.teff) > MAX_KEY_SHIFT;
  // A different phrase can be warped to look similar; what gives it away is that it does not agree with the rigid time model.
  const notSamePhrase = matchedNotes.length >= 4 && (al.rigid100 < NO_MATCH_RIGID || al.warpRmsMs > NO_MATCH_WARP_MS);
  const gateCoverage = forgive ? Math.max(coverage, spanShare) : coverage;
  const status: AttemptScore['status'] =
    gateCoverage < 0.25 || (gateCoverage < 0.4 && (pitch.score as number) < 50) || (pitch.score as number) < 12 || (!speech && sameness < 0.4) || notSamePhrase || tempoImplausible || keyImplausible
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

  // A very quiet take: notes may be missing because they were not heard, not because they were not sung.
  const voicedLevels = Array.from(A.level).filter(Number.isFinite);
  const quietTake = attempt.issues.includes('too-quiet') || (voicedLevels.length >= 20 && median(voicedLevels) < QUIET_VOICED_DB);
  const r0 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : round(clamp(x, 0, 100), 0));
  const skillScores: Record<SkillKey, number | null> = { pitch: r0(pitch.score), timing: r0(timing.score), tone: r0(tone.score), expression: r0(expr.score) };

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
  if (quietTake) bump('caution', 'The recording is very quiet, so quiet notes may be missed.');
  if (mode === 'sing-along' && attempt.issues.includes('accompaniment')) bump('caution', 'The take sounds like it contains the backing; if you used speakers, use headphones.');
  if (rough) {
    bump(
      'caution',
      lowConfidence
        ? 'The melody found in this full song is uncertain, so this score is a rough guide only and is not counted toward mastery. A vocal-only file gives a real score.'
        : excessNotes
          ? `The original has about ${round(noteRatio, 1)} times as many notes as you sang. ${fullSong ? 'In a full song some of them belong to the band' : 'In a noisy recording some of them may be background'}, so the notes you did not sing are not counted as missed and the score is a rough guide. A vocal-only file gives a real score.`
          : 'Some of the notes found in this full song are probably the band, so the score is a rough guide only. A vocal-only file gives a real score.',
    );
  } else if (refIsMix) bump('caution', 'The reference is a full mix: pitch and timing are compared from the extracted melody; tone and loudness are not compared.');
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
  // In a rough guide only what is true of the whole take is worth saying: a claim about one note ("note 7 starts early", "note 3 is sharp")
  // may be about a note that belongs to the band.
  const candidates = all.filter((i) => i.kind === 'fix' && gain(i) >= FIX_LISTED_POINTS && (!rough || ROUGH_FIX_IDS.has(i.id))).sort((a, b) => gain(b) - gain(a));
  // A fix worth about a point is below what repeated takes of the same performance move by (channel noise), so it is only shown when
  // it is worth FIX_SHOWN_POINTS, or when it is the one thing there is to say about a take that is not already near-perfect.
  const shown = candidates.filter((i) => gain(i) >= FIX_SHOWN_POINTS);
  const keep = shown.length > 0 ? shown : overall < FIX_ONLY_BELOW ? candidates.slice(0, 1) : [];
  const fixes: Fix[] = keep
    .slice(0, 5)
    .map((i) => ({ id: i.id, skill: i.skill, title: i.title, advice: i.advice, gainPoints: round(gain(i), 1), notes: i.notes }));
  let coverageEvidence: string | null = null;
  if (completeness < 0.98 && status !== 'no-match') {
    // Notes that fell before the first or after the last sound of a very quiet take were probably not sung quietly but not heard.
    const missedAll = perNote.filter((n) => !n.matched && !unhearable.has(n.refIndex) && !doubtful.has(n.refIndex)).map((n) => n.refIndex);
    const firstHeard = perNote.findIndex((n) => n.matched);
    const lastHeard = perNote.length - 1 - [...perNote].reverse().findIndex((n) => n.matched);
    const missed = quietTake ? missedAll.filter((k) => k > firstHeard && k < lastHeard) : missedAll;
    coverageEvidence = `Only ${Math.round(coverage * 100)}% of the original was sung${missed.length ? ` (missed: ${missed.slice(0, 4).map((k) => `note ${k + 1}`).join(', ')}${missed.length > 4 ? '...' : ''})` : ''}.${quietTake ? ' The recording is very quiet, so the app may simply not have heard the quietest notes.' : ''}`;
    fixes.push({
      id: 'coverage', skill: 'pitch', title: 'Sing the whole phrase',
      advice: 'Listen once more, then sing from the first note to the last without stopping.',
      gainPoints: round(onSung * (1 - completeness), 1), notes: missedAll,
    });
    fixes.sort((a, b) => b.gainPoints - a.gainPoints);
  }
  if (status === 'no-match') fixes.length = 0; // advice about a phrase the take does not match would only mislead
  settleFlags(perNote, fixes);

  // Why a take was not matched, when the scorer can tell (the practice screen words the notice from this).
  let noMatchWhy: 'locked-key' | 'pitch-far' | 'rough-reference' | null = null;
  if (status === 'no-match') {
    // Does the rhythm agree even though the pitches do not? Read from the entrances themselves (a take whose every note is far off has
    // no pitch-based timing score), as the share of them within 100 ms of the time model.
    const heard = al.onsetPairs.filter((p) => p.found);
    const rhythmShare = heard.length >= 4 ? heard.filter((p) => Math.abs(p.user - al.at(p.ref)) <= 0.1).length / heard.length : 0;
    const rhythmAgrees = rhythmShare >= 0.7 && coverage >= 0.9 && !tempoImplausible && !keyImplausible && matchedNotes.length >= 4;
    const lockedKeyOff = keyMode === 'locked' && al.T !== al.teff && Math.abs(al.T - al.teff) <= 11 && rhythmShare >= 0.6 && coverage >= 0.8;
    noMatchWhy = rough ? 'rough-reference' : lockedKeyOff ? 'locked-key' : rhythmAgrees ? 'pitch-far' : null;
  }
  const lockedKeyLine = (): string => {
    const n = Math.abs(al.T - al.teff);
    const guideKey = Number.isFinite(opts.guideShift) && Math.round(opts.guideShift as number) !== 0;
    return `You sang ${n} semitone${n === 1 ? '' : 's'} ${al.T < al.teff ? 'below' : 'above'} the ${guideKey ? "guide's" : 'original'} key. While you sing along with the guide only octaves count as the same key. Move the guide to your key (Key, Other), or choose Listen then sing, where any key is fine.`;
  };

  const lines: string[] = [];
  if (status === 'no-match') {
    if (noMatchWhy === 'locked-key') lines.push(lockedKeyLine());
    else if (noMatchWhy === 'pitch-far') lines.push(PITCH_FAR_LINE);
    else if (noMatchWhy === 'rough-reference') lines.push(ROUGH_NO_MATCH_LINE);
    else lines.push('This does not line up with the reference phrase (the notes and timing are too different). Check you are singing the right phrase, then try again.');
  }
  const keyLines: string[] = [];
  if (status !== 'no-match' && Math.abs(al.teff) > 0 && keyMode === 'free') {
    keyLines.push(`You sang this ${Math.abs(al.teff)} semitone${Math.abs(al.teff) === 1 ? '' : 's'} ${al.teff < 0 ? 'lower' : 'higher'} than the reference${Math.abs(al.teff) === 12 ? ' (an octave)' : ''}. A different key is fine and is not marked down.`);
  }
  if (keyMode === 'locked' && al.T !== al.teff && noMatchWhy !== 'locked-key') keyLines.push(lockedKeyLine());
  if (keyMode === 'free' && Math.abs(al.keyOffset) >= 20) {
    keyLines.push(`Your whole take sat ${Math.round(Math.abs(al.keyOffset))} cents ${al.keyOffset < 0 ? 'flat' : 'sharp'} of the nearest key to the reference. That is not marked down; it matters only if you are singing with the original track.`);
  }
  if (lagMs !== null && Math.abs(lagMs) >= 120) keyLines.push(`You were ${Math.round(Math.abs(lagMs))} ms ${lagMs > 0 ? 'behind' : 'ahead of'} the track throughout (not counted against note timing).`);
  if (rangeLine) keyLines.push(rangeLine);
  const order = fixes.map((f) => f.id);
  const fixTexts = all.filter((i) => i.kind === 'fix' && order.includes(i.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map((i) => i.text);
  // The sentence that opens the list is a verdict on the take. When there is a fix to show, the fix's own words come after it and the key,
  // offset and lag lines (the screen also prints those beside the dial) come last, so the opening line never repeats the first card.
  const verdict = status === 'ok' && fixes.length > 0 ? (verdictLine(fixes[0], perNote) ?? skillsLine(skillScores)) : null;
  if (verdict) lines.push(verdict, ...fixTexts, ...keyLines);
  else lines.push(...keyLines, ...fixTexts);
  if (coverage < 0.9) lines.push(`You covered ${Math.round(coverage * 100)}% of the reference phrase.`);
  if (status !== 'no-match') {
    lines.push(...all.filter((i) => i.kind === 'info').map((i) => i.text));
    lines.push(...all.filter((i) => i.kind === 'good').map((i) => i.text).slice(0, 2));
  }
  if (status === 'no-match') {
    const hint = floorHint(ref);
    if (hint) lines.push(hint);
  }

  const diagnostics: AttemptScore['diagnostics'] = {
    refNotes: ref.notes.length, attemptNotes: attempt.notes.length, matchedNotes: matchedNotes.length,
    tempoFitted: al.tempoFitted, lagSec: round(al.lag, 3), tempoRaw: round(al.tempo / rate, 4), onsetPairs: al.onsetPairs.length,
    dtwFirstGuessT: base.transposeSemitones, dtwCostPerBin: round(al.dtwCostPerBin, 3), sameness: round(sameness, 3), rigid100: round(al.rigid100, 3), warpRmsMs: round(al.warpRmsMs, 0), wholePhrase: al.wholePhrase,
    shortPhrase: isShortPhrase(ref), refMix: refIsMix, bleedSuspect, outOfRangeNotes: outOfRange.length,
    ...Object.fromEntries(SKILLS.flatMap((s) => Object.entries(results[s].stats).map(([k, v]) => [`${s}.${k}`, v]))),
    ...Object.fromEntries(fixes.flatMap((f) => { const t = f.id === 'coverage' ? coverageEvidence : all.find((i) => i.id === f.id)?.text; return t ? [[`fix.${f.id}`, t]] : []; })),
    mode, noMatchWhy, quietTake, roughGuide: rough, refLowConfidence: lowConfidence, refConfidence: refConfidence === null ? null : round(refConfidence, 3), doubtfulNotes: doubtful.size, refPurity: lead?.purity === undefined ? null : round(lead.purity, 2), noteRatio: round(noteRatio, 2), spanShare: round(spanShare, 2),
  };
  const overallRounded = r0(overall) ?? 0;
  return {
    status,
    overall: status === 'no-match' ? Math.min(20, overallRounded) : overallRounded,
    overallOnSung: r0(onSung) ?? 0,
    skills: skillScores,
    weights, components: SKILLS.flatMap((s) => results[s].components), coverage: round(coverage, 3), completeness: round(completeness, 3),
    kind: speech ? 'speech-like' : 'sung', transposeSemitones: al.teff, keyOffsetCents: round(al.keyOffset, 1),
    timing: { lagMs: lagMs === null ? null : round(lagMs, 0), tempoRatio: al.tempoFitted ? round(rho, 3) : null, onsetMadMs: typeof timing.stats.onsetMadMs === 'number' ? timing.stats.onsetMadMs : null },
    matchedSpan: span, perNote, notes: lines, fixes, trust: { level, reasons }, diagnostics,
  };
}

/** Fixes that stay in a rough guide: they describe the whole take, not single notes. */
const ROUGH_FIX_IDS: ReadonlySet<string> = new Set(['timing.tempo', 'pitch.drift', 'pitch.height']);

const ROUGH_NO_MATCH_LINE =
  'The melody found in this full song does not line up with your take well enough to score it. That is usually the band, not you: try a vocal-only file, or a section where the voice stands out more.';

const PITCH_FAR_LINE =
  'The rhythm matched, but many notes were far from the original (about a semitone or more). Slow down, listen to a few notes one at a time, and try again.';

const SKILL_WORD: Record<SkillKey, string> = { pitch: 'pitch', timing: 'timing', tone: 'tone', expression: 'expression' };

/** One sentence that says how the take went, from the notes themselves, so it never repeats the wording of the first fix card. */
function verdictLine(top: Fix, perNote: NoteScore[]): string | null {
  if (top.id === 'coverage') return null;
  const matched = perNote.filter((n) => n.matched);
  if (top.skill === 'pitch') {
    const withCents = matched.filter((n) => n.cents !== null);
    const off = withCents.filter((n) => Math.abs(n.cents as number) > OFF_CENTS).length;
    return off > 0 ? `${off} of ${withCents.length} notes were more than ${OFF_CENTS} cents from the original.` : null;
  }
  if (top.skill === 'timing') {
    const withOnset = matched.filter((n) => n.onsetMs !== null);
    const off = withOnset.filter((n) => Math.abs(n.onsetMs as number) >= LATE_EARLY_MS).length;
    return off > 0 ? `${off} of ${withOnset.length} note entrances were more than ${LATE_EARLY_MS} ms away from the original's rhythm.` : null;
  }
  if (top.skill === 'tone') return 'The biggest difference from the original is the tone colour (an estimate: your microphone and vowel move it too).';
  return 'The biggest difference from the original is the shaping: loudness, vibrato and how the notes start and end.';
}

/** "Closest on pitch (96), furthest on timing (78)." null when fewer than two skills were measured or they are level. */
function skillsLine(skills: Record<SkillKey, number | null>): string | null {
  const have = SKILLS.filter((k) => skills[k] !== null).sort((a, b) => (skills[b] as number) - (skills[a] as number));
  if (have.length < 2) return null;
  const best = have[0];
  const worst = have[have.length - 1];
  if ((skills[best] as number) - (skills[worst] as number) < 3) return null;
  return `Closest on ${SKILL_WORD[best]} (${skills[best]}), furthest on ${SKILL_WORD[worst]} (${skills[worst]}).`;
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
 *
 * Pass the pitch sub-score when it is known: tone and expression read 95-100 for almost any voice that follows the original's shape,
 * so a take whose notes scatter by 30 cents can reach 90 overall. 'excellent' ("Very close") then needs 93 unless pitch is 85 or more.
 */
export function scoreBand(score: number, pitch?: number | null): 'excellent' | 'good' | 'fair' | 'needs-work' {
  const excellent = typeof pitch === 'number' && Number.isFinite(pitch) && pitch < EXCELLENT_PITCH_MIN ? score >= EXCELLENT_IF_PITCH_LOOSE : score >= 90;
  return excellent ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'needs-work';
}
