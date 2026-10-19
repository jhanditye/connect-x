// Scale-degree lines and sung intervals: segment the take, align it to the expected pitches, score each note against
// the key, the steps between neighbours, the drift over the line and the whole-take octave.

import { mean, median } from '../../dsp/stats';
import { intervalName, intervalPhrase } from '../theory/intervals';
import { degreeOfMidi } from '../theory/scales';
import type {
  Finding,
  IntervalTarget,
  ScoreOptions,
  SequenceNoteScore,
  SequenceScore,
  SequenceTarget,
  SungIntervalScore,
  SungNote,
  TakeStatus,
} from '../types';
import { alignWithCost, bestOctaveAlignment } from './align';
import {
  ALIGN_SHORT_EXTRA_SEC,
  DRIFT_FINDING_CENTS,
  DRIFT_MIN_NOTES,
  FORCE_SPLIT_MIN_CENTS,
  LINE_SHIFT_CENTS,
  LINE_SHIFT_SPREAD_CENTS,
  LOW_CONF_MARGIN_CENTS,
  MAX_FINDINGS,
  MIN_COUNTED_SHARE,
  NOTE_MIN_SEC,
  OCTAVE_OFFSETS,
  PRAISE_SHARE,
  ROUGH_WRONG_NOTE_CENTS,
  WRONG_DIRECTION_CENTS,
  WRONG_NOTE_CENTS,
} from './constants';
import { centsMeaning, sharpFlat } from './format';
import { analyseTake, foldCents, isPureTone, octaveAndCents, pureToneFinding, takeStatus, unscoredFindingFor, voiceCheck, type TakeFrames } from './frames';
import { buildNote, segmentSpans, splitSpanInTwo, type NoteSpan } from './segment';

function sungSpansOf(samples: Float32Array, sampleRate: number, a4Hz: number): { status: TakeStatus; spans: NoteSpan[]; fr: TakeFrames; why: Finding | null } {
  const fr = analyseTake(samples, sampleRate, a4Hz);
  const status = takeStatus(fr);
  if (status !== 'ok') return { status, spans: [], fr, why: unscoredFindingFor(fr, status) };
  const spans = segmentSpans(fr);
  if (!spans.length) return { status: 'no-pitch', spans, fr, why: unscoredFindingFor(fr, 'no-pitch') };
  // Voice check: a take whose notes are mostly steady pure tones (a speaker, a tuning app) is not singing.
  const pure = spans.filter((sp) => sp.steady.length > 0 && isPureTone(voiceCheck(samples, sampleRate, fr, sp.steady[0], sp.steady[sp.steady.length - 1] + 1, 4))).length;
  if (pure * 2 > spans.length) return { status: 'no-pitch', spans: [], fr, why: pureToneFinding() };
  return { status: 'ok', spans, fr, why: null };
}

/** A sung note whose pitch was too short or swung too widely to measure reliably (shown, not counted). */
const isLow = (n: SungNote | null): boolean => n?.confidence === 'low';

/**
 * How far a rough (low-confidence) note's reading can be trusted, in cents: its own swing (the whole 10-90 % range of
 * its steady pitch, or twice the vibrato extent found), at least LOW_CONF_MARGIN_CENTS. A partial vibrato cycle can
 * pull a short note's centre by most of one extent (72 cents with a +/-100 vibrato), so half the range is not enough.
 */
function roughMarginCents(fr: TakeFrames, sp: NoteSpan): number {
  const v = sp.steady.map((k) => fr.midi[k]).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const range = v.length ? v[Math.floor(0.9 * (v.length - 1))] - v[Math.floor(0.1 * (v.length - 1))] : 0;
  return Math.max(LOW_CONF_MARGIN_CENTS, 100 * Math.max(range, 2 * sp.vibAmp));
}

/** A matched note that is a different note from the written one (not just out of tune), or in another octave. */
export function isWrongNote(n: Pick<SequenceNoteScore, 'cents' | 'octaveSlip'>): boolean {
  return n.cents !== null && (n.octaveSlip || Math.abs(n.cents) >= WRONG_NOTE_CENTS);
}

/**
 * Whether a scored note may feed the per-degree tuning profile: sung, in the take's octave, a tuning error rather than
 * a different note, measured with confidence (not a note too short to trust), and the line was in the key (not the
 * right shape a few semitones away).
 */
export function countsForTuning(n: SequenceNoteScore, score: Pick<SequenceScore, 'keyShiftCents'>): boolean {
  return n.sung !== null && n.cents !== null && !isWrongNote(n) && !isLow(n.sung) && (score.keyShiftCents ?? null) === null;
}

const withArticle = (name: string) => `${/^[aeiou]/.test(name) || name.startsWith('octave') ? 'an' : 'a'} ${name}`;

/** "a minor 3rd up", "the same note", "an octave and a 2nd down" for a sung step in semitones (signed). */
export function sungStepPhrase(semis: number): string {
  const r = Math.round(Math.abs(semis));
  if (r === 0) return 'the same note';
  const dir = semis > 0 ? 'up' : 'down';
  if (r <= 12) return intervalPhrase(r, dir);
  const rest = r - 12;
  return `an octave and ${rest === 0 ? '' : withArticle(intervalName(rest) || `${rest} semitones`)} ${dir}`.replace('  ', ' ');
}

/**
 * Theil-Sen slope (median of pairwise slopes). Used for drift instead of least squares so one badly tuned note (a flat
 * 7 at the start of "7 6 5 4 3 2") does not read as the whole line sliding; a genuine steady slide reads the same.
 */
export function theilSenSlope(x: readonly number[], y: readonly number[]): number {
  const s: number[] = [];
  for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) if (x[j] !== x[i]) s.push((y[j] - y[i]) / (x[j] - x[i]));
  return s.length ? median(s) : NaN;
}

/** The sung note matched before expected note i (null when none). */
function prevSung(notes: readonly SequenceNoteScore[], i: number): SungNote | null {
  for (let p = i - 1; p >= 0; p--) if (notes[p].sung) return notes[p].sung;
  return null;
}

const octaveWords = (k: number) =>
  `${Math.abs(k) === 1 ? 'an octave' : `${Math.abs(k)} octaves`} ${k < 0 ? 'lower' : 'higher'}`;

/**
 * Scores a sung scale-degree line. Notes are aligned to the target with a DP that tolerates extra and missing notes;
 * the whole take may sit 1-2 octaves away (fine, and said so). A single note an octave away from the rest is flagged
 * and never counts as in tune, a note 70 cents or more away is a different note (named, and kept out of the tuning
 * figures), steps are measured from the sung notes themselves (so a leap the wrong way or into the wrong octave shows
 * as a large step error), and a line with the right shape in another key is recognised and said so.
 */
export function scoreSequence(samples: Float32Array, sampleRate: number, target: SequenceTarget, opts: ScoreOptions): SequenceScore {
  const tol = opts.toleranceCents;
  const { status, spans, fr, why } = sungSpansOf(samples, sampleRate, opts.a4Hz);
  const sung = spans.map((s) => s.note);
  const margins = new Map<SungNote, number>(spans.map((sp) => [sp.note, roughMarginCents(fr, sp)]));
  const blankNotes = (): SequenceNoteScore[] =>
    target.notes.map((n, i) => ({
      index: i,
      degree: n.degree,
      written: n.written,
      expectedMidi: target.midis[i],
      sung: null,
      cents: null,
      intervalCents: null,
      within: false,
      octaveSlip: false,
    }));
  if (status !== 'ok') {
    return {
      status,
      target,
      notes: blankNotes(),
      extras: [],
      missing: target.notes.length,
      octaveOffset: 0,
      noteAccuracy: null,
      meanAbsCents: null,
      biasCents: null,
      meanAbsIntervalCents: null,
      driftCents: null,
      keyShiftCents: null,
      findings: why ? [why] : [],
    };
  }
  let al = bestOctaveAlignment(target.midis, sung);
  // Right shape in another key: try whole-semitone shifts of the target; take one only when it is clearly cheaper.
  let shiftSemis = 0;
  for (let t = -6; t <= 6; t++) {
    if (t === 0) continue;
    const shifted = target.midis.map((m) => m + t);
    for (const k of OCTAVE_OFFSETS) {
      const a = alignWithCost(shifted, sung, k);
      if (a.cost + 1.5 < al.cost - 1e-9) {
        al = { ...a, octaveOffset: k };
        shiftSemis = t;
      }
    }
  }
  const k = al.octaveOffset;
  const notes = blankNotes();
  let prev: SequenceNoteScore | null = null;
  for (let i = 0; i < notes.length; i++) {
    const j = al.match[i];
    if (j === null) continue;
    const s = sung[j];
    const raw = (s.midi - target.midis[i] - 12 * k) * 100;
    const slip = Math.abs(raw) > 600;
    const cents = slip ? foldCents(raw) : raw;
    const ns = notes[i];
    ns.sung = s;
    ns.cents = cents;
    ns.octaveSlip = slip;
    ns.within = !slip && Math.abs(cents) <= tol;
    // The step from the previous matched note, from the sung pitches themselves (never folded).
    if (prev && prev.sung) ns.intervalCents = (s.midi - prev.sung.midi) * 100 - (target.midis[i] - prev.expectedMidi) * 100;
    prev = ns;
  }
  const matched = notes.filter((n) => n.cents !== null);
  // Notes too short to measure reliably are shown with their numbers and kept out of the tuning figures. They are not
  // ignored: one that is a different note even after allowing for its own swing is still named (and counted as not
  // in tune), and one that reads off by more than the tolerance and its swing is named as rough and blocks praise.
  const lowConf = matched.filter((n) => isLow(n.sung));
  const confident = matched.filter((n) => !isLow(n.sung));
  const beyondSwing = (n: SequenceNoteScore) => Math.abs(n.cents as number) - (margins.get(n.sung as SungNote) ?? LOW_CONF_MARGIN_CENTS);
  const lowWrong = lowConf.filter((n) => !n.octaveSlip && beyondSwing(n) >= ROUGH_WRONG_NOTE_CENTS);
  const lowOff = lowConf.filter((n) => !lowWrong.includes(n) && !n.octaveSlip && Math.abs(n.cents as number) > tol && beyondSwing(n) > 0);
  const uncounted = lowConf.filter((n) => !lowWrong.includes(n));
  const tuned = confident.filter((n) => !isWrongNote(n));
  const wrong = [...confident.filter((n) => isWrongNote(n)), ...lowWrong];
  const missing = notes.length - matched.length;
  const allSteps = notes.filter((n) => n.intervalCents !== null && !isLow(n.sung) && !isLow(prevSung(notes, n.index)));
  const wrongSteps = allSteps.filter((n) => Math.abs(n.intervalCents as number) >= WRONG_NOTE_CENTS * 1.5);
  const steps = allSteps.filter((n) => Math.abs(n.intervalCents as number) < WRONG_NOTE_CENTS * 1.5).map((n) => n.intervalCents as number);

  // A whole line shifted off the key with the right shape (every note about the same distance away).
  let keyShiftCents: number | null = null;
  if (confident.length >= 3 && !confident.some((n) => n.octaveSlip)) {
    const c = confident.map((n) => n.cents as number);
    const med = median(c);
    const spread = Math.max(...c.map((x) => Math.abs(x - med)));
    if (Math.abs(med) >= LINE_SHIFT_CENTS && spread <= LINE_SHIFT_SPREAD_CENTS) keyShiftCents = med;
  }
  if (keyShiftCents === null && shiftSemis !== 0 && confident.length >= 2) keyShiftCents = median(confident.map((n) => n.cents as number));

  let driftCents: number | null = null;
  if (tuned.length >= 3) {
    const t = tuned.map((n) => (n.sung as SungNote).startSec);
    const slope = theilSenSlope(
      t,
      tuned.map((n) => n.cents as number),
    );
    if (Number.isFinite(slope)) driftCents = slope * (t[t.length - 1] - t[0]);
  }
  // Accuracy is over the notes that could be judged (a clear wrong note is judged, even when short). With fewer than
  // MIN_COUNTED_SHARE of the line judged there is no accuracy figure: "not scored", not a number from one or two notes.
  const counted = notes.length - uncounted.length;
  const noteAccuracy = counted > 0 && counted >= MIN_COUNTED_SHARE * notes.length ? confident.filter((n) => n.within).length / counted : null;
  const tunedCents = tuned.map((n) => n.cents as number);
  const meanAbsCents = tunedCents.length ? mean(tunedCents.map(Math.abs)) : confident.length ? mean(confident.map((n) => Math.abs(n.cents as number))) : null;
  const biasCents = tunedCents.length ? mean(tunedCents) : null;
  const extras = al.extras.map((j) => sung[j]);

  const findings: Finding[] = [];
  if (keyShiftCents !== null) {
    const a = Math.abs(keyShiftCents);
    const how = a >= 80 ? `about ${Math.round(a / 100) === 1 ? 'a semitone' : `${Math.round(a / 100)} semitones`}` : `about ${Math.round(a)} cents`;
    findings.push({
      tone: 'work',
      text: `Right shape, but the whole line sat ${how} ${keyShiftCents > 0 ? 'above' : 'below'} the key. Listen to the chords and the home note again, then start on the ${target.notes[0].written}.`,
    });
  }
  // Praise needs nearly the whole line judged (PRAISE_SHARE of the notes), not one or two notes among many rough ones.
  const praise =
    keyShiftCents === null &&
    noteAccuracy !== null &&
    noteAccuracy >= PRAISE_SHARE &&
    counted >= PRAISE_SHARE * notes.length &&
    missing === 0 &&
    wrong.length === 0 &&
    lowOff.length === 0 &&
    wrongSteps.length === 0;
  if (praise) {
    findings.push({ tone: 'good', text: `${confident.filter((n) => n.within).length} of ${counted} notes within ${tol} cents. Well pitched.` });
  }
  if (keyShiftCents === null) {
    // A wrong leap first (the shape of the line), then a different note, then the worst tuning.
    const leap = wrongSteps.reduce<SequenceNoteScore | null>((w, n) => (!w || Math.abs(n.intervalCents as number) > Math.abs(w.intervalCents as number) ? n : w), null);
    if (leap) {
      const i = leap.index;
      let p = i - 1;
      while (p >= 0 && notes[p].sung === null) p--;
      const from = notes[p];
      const sungSemis = (leap.sung as SungNote).midi - (from.sung as SungNote).midi;
      const askedSemis = leap.expectedMidi - from.expectedMidi;
      findings.push({
        tone: 'work',
        text: `From ${from.written} to ${leap.written} you sang ${sungStepPhrase(sungSemis)}; it should be ${sungStepPhrase(askedSemis)}.`,
      });
    }
    const wrongOnly = wrong.filter((n) => !n.octaveSlip);
    if (wrongOnly.length) {
      const n = wrongOnly.reduce((w, x) => (Math.abs(x.cents as number) > Math.abs(w.cents as number) ? x : w));
      const deg = degreeOfMidi(target.key, Math.round((n.sung as SungNote).midi - 12 * k));
      const c = n.cents as number;
      const semis = Math.round(Math.abs(c) / 100);
      const away = semis >= 1 ? `${semis === 1 ? 'a semitone' : `${semis} semitones`} ${c > 0 ? 'sharp' : 'flat'}` : sharpFlat(c);
      findings.push({
        tone: 'work',
        // A rough note is named as a different note, but its size and the note it landed on are not claimed.
        text: isLow(n.sung)
          ? `Your ${n.written} was clearly a different note (it read about ${Math.round(Math.abs(c))} cents ${c > 0 ? 'sharp' : 'flat'}, but it was short, so that size is rough).`
          : deg !== null && deg !== n.degree
            ? `You sang a ${deg} where the ${n.written} was written (${away}).`
            : `Your ${n.written} was a different note, ${away}.`,
      });
    }
    const worst = tuned.reduce<SequenceNoteScore | null>((w, n) => (!w || Math.abs(n.cents as number) > Math.abs(w.cents as number) ? n : w), null);
    if (worst && !worst.within) {
      const c = worst.cents as number;
      findings.push({ tone: 'work', text: `Your ${worst.written} sat ${sharpFlat(c)} (${centsMeaning(c)}).` });
    } else if (lowOff.length) {
      // No measured note was out of tune, but a rough one read clearly off: say so, as a rough reading.
      const n = lowOff.reduce((w, x) => (Math.abs(x.cents as number) > Math.abs(w.cents as number) ? x : w));
      const c = n.cents as number;
      // The size is given only when the note held still (its margin is the floor); a note that swung widely gets the
      // direction alone.
      const still = (margins.get(n.sung as SungNote) ?? Infinity) <= LOW_CONF_MARGIN_CENTS;
      findings.push({
        tone: 'work',
        text: still
          ? `Your ${n.written} sounded about ${Math.round(Math.abs(c))} cents ${c > 0 ? 'sharp' : 'flat'}, but it was too short to measure reliably.`
          : `Your ${n.written} sounded ${c > 0 ? 'sharp' : 'flat'}, but it was too short and swung too widely to say how far.`,
      });
    }
    if (driftCents !== null && tuned.length >= DRIFT_MIN_NOTES && Math.abs(driftCents) >= DRIFT_FINDING_CENTS) {
      findings.push({
        tone: 'work',
        text: `The line slid about ${Math.round(Math.abs(driftCents))} cents ${driftCents < 0 ? 'flat' : 'sharp'} from start to finish. Keep the key note in your ear.`,
      });
    }
  }
  if (missing > 0 || extras.length > 0) {
    // A repeated note sung as one long note (no break between them) reads as a missing note: say what to do instead.
    const merged = notes.some((n, i) => n.sung === null && ((i > 0 && notes[i - 1].sung !== null && notes[i - 1].expectedMidi === n.expectedMidi) || (i + 1 < notes.length && notes[i + 1].sung !== null && notes[i + 1].expectedMidi === n.expectedMidi)));
    if (merged) {
      findings.push({ tone: 'info', text: 'I heard one long note where the same note was written twice. Give each one its own start ("la-la").' });
    } else {
      const parts: string[] = [];
      if (missing > 0) parts.push(`${missing} ${missing === 1 ? 'note' : 'notes'} I could not hear`);
      if (extras.length > 0) parts.push(`${extras.length} extra ${extras.length === 1 ? 'note' : 'notes'}`);
      findings.push({ tone: 'info', text: `${parts.join(' and ')}; the rest were matched in order.` });
    }
  }
  if (uncounted.length > 0) {
    findings.push({
      tone: 'info',
      text: `${uncounted.length} ${uncounted.length === 1 ? 'note was' : 'notes were'} too short to measure reliably, so ${uncounted.length === 1 ? 'it is' : 'they are'} shown but not counted${noteAccuracy === null ? ', and the line is not scored' : ''}. Give each note a little more time.`,
    });
  }
  if (k !== 0) findings.push({ tone: 'info', text: `You sang the line ${octaveWords(k)}. That is fine: each note was judged in your octave.` });
  const slips = confident.filter((n) => n.octaveSlip).length;
  if (slips > 0) {
    findings.push({
      tone: 'work',
      text: `${slips} ${slips === 1 ? 'note jumped' : 'notes jumped'} to a different octave from the rest of the line, so ${slips === 1 ? 'it does' : 'they do'} not count as in tune.`,
    });
  }

  return {
    status: 'ok',
    target,
    notes,
    extras,
    missing,
    octaveOffset: k,
    noteAccuracy,
    meanAbsCents,
    biasCents,
    meanAbsIntervalCents: steps.length ? mean(steps.map(Math.abs)) : null,
    driftCents,
    keyShiftCents,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

/** Two spans this close to an exact octave apart that touch (no gap between them) are one note read in two octaves. */
const OCTAVE_SLIP_ST = 0.5;

/**
 * Pitch-tracker octave slips inside the second note: after the first note, two spans that touch (no unvoiced frame
 * between them) and sit an octave apart (within OCTAVE_SLIP_ST) are one note read in two octaves, since no voice
 * jumps an exact octave mid-note without a break. They are rebuilt as one note in the octave nearer the expected
 * second note (the pitch class, which is all the octave choice changes, is the same either way).
 */
function foldOctaveSlips(fr: TakeFrames, use: NoteSpan[], step: number): NoteSpan[] {
  if (use.length < 3) return use;
  const out = [...use];
  for (let i = 1; i + 1 < out.length; i++) {
    const a = out[i];
    const b = out[i + 1];
    const d = b.note.midi - a.note.midi;
    if (b.i0 - a.i1 > 1 || Math.abs(Math.abs(d) - 12) > OCTAVE_SLIP_ST) continue;
    const expected = out[0].note.midi + step;
    // Keep the octave of whichever reading is nearer the expected note; shift the other one onto it.
    const keepA = Math.abs(a.note.midi - expected) <= Math.abs(b.note.midi - expected);
    const midi = fr.midi.slice();
    const [s0, s1, shift] = keepA ? [b.i0, b.i1, -Math.sign(d) * 12] : [a.i0, a.i1, Math.sign(d) * 12];
    for (let k = s0; k < s1; k++) if (!Number.isNaN(midi[k])) midi[k] += shift;
    const merged = buildNote({ ...fr, midi }, a.i0, b.i1, NOTE_MIN_SEC, a.vibRateHz ?? b.vibRateHz);
    if (!merged) continue;
    out.splice(i, 2, merged);
    i--;
  }
  return out;
}

/** The two notes of an interval take, in time order: blips under 200 ms are skipped, tracker octave slips inside the
 * second note are folded back (foldOctaveSlips), and one long note that glides from the first pitch to the second (or
 * a unison sung without a break) is split in two. `step` is the expected step in semitones (signed). */
function twoNotes(fr: TakeFrames, spans: NoteSpan[], unison: boolean, step: number): [SungNote | null, SungNote | null] {
  let use = foldOctaveSlips(fr, spans.filter((s) => s.note.endSec - s.note.startSec >= ALIGN_SHORT_EXTRA_SEC), step);
  if (use.length < 2 && spans.length >= 2) use = spans;
  if (use.length === 1) {
    const sp = splitSpanInTwo(fr, use[0], unison);
    if (sp && (unison || Math.abs(sp[1].note.midi - sp[0].note.midi) * 100 >= FORCE_SPLIT_MIN_CENTS)) use = sp;
  }
  return [use[0]?.note ?? null, use[1]?.note ?? null];
}

/**
 * Scores "sing the note, then an interval up/down" in one take. The two notes are the first two steady notes in time
 * order (no pitch-based matching, so a wrong interval is reported as what was sung, not as "not heard"). The core
 * number is the interval size error, independent of where the first note started: sign(direction) * (second - first)
 * * 100 - semitones * 100, + too wide. It is never folded: a jump into the wrong octave is about 1200 cents off.
 * `within` needs the right size and direction.
 */
export function scoreSungInterval(samples: Float32Array, sampleRate: number, target: IntervalTarget, opts: ScoreOptions): SungIntervalScore {
  const tol = opts.toleranceCents;
  const sign = target.direction === 'down' ? -1 : 1;
  const semis = Math.abs(target.semitones);
  const targetMidi = target.referenceMidi + sign * semis;
  const base: SungIntervalScore = {
    status: 'ok',
    target,
    first: null,
    second: null,
    referenceCents: null,
    intervalCents: null,
    targetCents: null,
    sungSemitones: null,
    wrongDirection: false,
    octaveOffset: 0,
    within: false,
    findings: [],
  };
  const { status, spans, fr, why } = sungSpansOf(samples, sampleRate, opts.a4Hz);
  if (status !== 'ok') return { ...base, status, findings: why ? [why] : [] };
  const [first, second] = twoNotes(fr, spans, semis === 0, sign * semis);
  const ref = first ? octaveAndCents((first.midi - target.referenceMidi) * 100) : { octaves: 0, cents: 0 };
  const k = ref.octaves;
  const out: SungIntervalScore = { ...base, first, second, octaveOffset: k };
  const findings: Finding[] = [];
  if (first) out.referenceCents = ref.cents;
  if (second) out.targetCents = (second.midi - targetMidi - 12 * k) * 100;
  const name = intervalName(semis) || 'interval';
  if (first && second) {
    const sungSemis = second.midi - first.midi;
    out.sungSemitones = sungSemis;
    const raw = (sign * sungSemis - semis) * 100;
    out.intervalCents = raw;
    out.wrongDirection = semis !== 0 && sign * sungSemis * 100 <= -WRONG_DIRECTION_CENTS;
    out.within = Math.abs(raw) <= tol && !out.wrongDirection;
    const asked = semis === 0 ? 'the same note' : intervalPhrase(semis, target.direction === 'down' ? 'down' : 'up');
    const sang = sungStepPhrase(sungSemis);
    if (out.within) {
      const a = Math.round(Math.abs(raw));
      findings.push({ tone: 'good', text: `A clean ${name}: ${a} ${a === 1 ? 'cent' : 'cents'} from exact.` });
    } else if (out.wrongDirection) {
      findings.push({
        tone: 'work',
        text: `The second note went ${sign > 0 ? 'down' : 'up'} instead of ${sign > 0 ? 'up' : 'down'}: you sang ${sang}; the target was ${asked}.`,
      });
    } else if (Math.abs(raw) < WRONG_NOTE_CENTS * 1.5) {
      findings.push({ tone: 'work', text: `Your ${name} was ${Math.round(Math.abs(raw))} cents too ${raw > 0 ? 'wide' : 'narrow'} (${centsMeaning(raw)}).` });
    } else {
      const sameName = Math.abs(foldCents(raw)) <= 100;
      findings.push({
        tone: 'work',
        text: sameName
          ? `The second note had the right name but was in another octave: you sang ${sang}; the target was ${asked}.`
          : `You sang ${sang}; the target was ${asked}.`,
      });
    }
  } else {
    findings.push({ tone: 'info', text: first ? 'I heard the first note but not a clear second one. Hold each note for about a second.' : 'I could not hear two clear notes. Sing each one for about a second.' });
  }
  if (out.referenceCents !== null && Math.abs(out.referenceCents) > tol) {
    const c = out.referenceCents;
    findings.push({
      tone: 'info',
      text:
        Math.abs(c) >= WRONG_NOTE_CENTS
          ? `Your first note was ${sungStepPhrase(c / 100).replace(/ (up|down)$/, (m) => (m === ' up' ? ' above' : ' below'))} the given note; the interval is judged from where you started.`
          : `Your first note started ${sharpFlat(c)}; the interval is judged from where you started.`,
    });
  }
  if (isLow(first) || isLow(second)) {
    // Said first: the numbers are shown but rough, and `within` is not claimed on them (nor praised: "a clean ..."
    // would contradict "rough").
    out.within = false;
    for (let i = findings.length - 1; i >= 0; i--) if (findings[i].tone === 'good') findings.splice(i, 1);
    findings.unshift({ tone: 'info', text: 'One of the notes was too short to measure reliably, so these numbers are rough. Hold each note for about a second.' });
  }
  if (k !== 0) findings.push({ tone: 'info', text: `You sang it ${octaveWords(k)}; that is fine.` });
  out.findings = findings.slice(0, MAX_FINDINGS);
  if (!first && !second) out.status = 'no-pitch';
  return out;
}
