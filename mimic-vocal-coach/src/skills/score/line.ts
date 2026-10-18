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
  MAX_FINDINGS,
  OCTAVE_OFFSETS,
  PRAISE_SHARE,
  WRONG_DIRECTION_CENTS,
  WRONG_NOTE_CENTS,
} from './constants';
import { centsMeaning, sharpFlat } from './format';
import { analyseTake, foldCents, octaveAndCents, takeStatus, unscoredFinding, type TakeFrames } from './frames';
import { segmentSpans, splitSpanInTwo, type NoteSpan } from './segment';

function sungSpansOf(samples: Float32Array, sampleRate: number, a4Hz: number): { status: TakeStatus; spans: NoteSpan[]; fr: TakeFrames } {
  const fr = analyseTake(samples, sampleRate, a4Hz);
  const status = takeStatus(fr);
  if (status !== 'ok') return { status, spans: [], fr };
  const spans = segmentSpans(fr);
  return { status: spans.length ? 'ok' : 'no-pitch', spans, fr };
}

/** A matched note that is a different note from the written one (not just out of tune), or in another octave. */
export function isWrongNote(n: Pick<SequenceNoteScore, 'cents' | 'octaveSlip'>): boolean {
  return n.cents !== null && (n.octaveSlip || Math.abs(n.cents) >= WRONG_NOTE_CENTS);
}

/**
 * Whether a scored note may feed the per-degree tuning profile: sung, in the take's octave, a tuning error rather than
 * a different note, and the line was in the key (not the right shape a few semitones away).
 */
export function countsForTuning(n: SequenceNoteScore, score: Pick<SequenceScore, 'keyShiftCents'>): boolean {
  return n.sung !== null && n.cents !== null && !isWrongNote(n) && (score.keyShiftCents ?? null) === null;
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
  const { status, spans } = sungSpansOf(samples, sampleRate, opts.a4Hz);
  const sung = spans.map((s) => s.note);
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
      findings: [unscoredFinding(status)],
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
  const tuned = matched.filter((n) => !isWrongNote(n));
  const wrong = matched.filter((n) => isWrongNote(n));
  const missing = notes.length - matched.length;
  const allSteps = notes.filter((n) => n.intervalCents !== null);
  const wrongSteps = allSteps.filter((n) => Math.abs(n.intervalCents as number) >= WRONG_NOTE_CENTS * 1.5);
  const steps = allSteps.filter((n) => Math.abs(n.intervalCents as number) < WRONG_NOTE_CENTS * 1.5).map((n) => n.intervalCents as number);

  // A whole line shifted off the key with the right shape (every note about the same distance away).
  let keyShiftCents: number | null = null;
  if (matched.length >= 3 && !matched.some((n) => n.octaveSlip)) {
    const c = matched.map((n) => n.cents as number);
    const med = median(c);
    const spread = Math.max(...c.map((x) => Math.abs(x - med)));
    if (Math.abs(med) >= LINE_SHIFT_CENTS && spread <= LINE_SHIFT_SPREAD_CENTS) keyShiftCents = med;
  }
  if (keyShiftCents === null && shiftSemis !== 0 && matched.length >= 2) keyShiftCents = median(matched.map((n) => n.cents as number));

  let driftCents: number | null = null;
  if (tuned.length >= 3) {
    const t = tuned.map((n) => (n.sung as SungNote).startSec);
    const slope = theilSenSlope(
      t,
      tuned.map((n) => n.cents as number),
    );
    if (Number.isFinite(slope)) driftCents = slope * (t[t.length - 1] - t[0]);
  }
  const noteAccuracy = notes.length ? matched.filter((n) => n.within).length / notes.length : null;
  const tunedCents = tuned.map((n) => n.cents as number);
  const meanAbsCents = tunedCents.length ? mean(tunedCents.map(Math.abs)) : matched.length ? mean(matched.map((n) => Math.abs(n.cents as number))) : null;
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
  const praise =
    keyShiftCents === null && noteAccuracy !== null && noteAccuracy >= PRAISE_SHARE && missing === 0 && wrong.length === 0 && wrongSteps.length === 0;
  if (praise) {
    findings.push({ tone: 'good', text: `${matched.filter((n) => n.within).length} of ${notes.length} notes within ${tol} cents. Well pitched.` });
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
        text:
          deg !== null && deg !== n.degree
            ? `You sang a ${deg} where the ${n.written} was written (${away}).`
            : `Your ${n.written} was a different note, ${away}.`,
      });
    }
    const worst = tuned.reduce<SequenceNoteScore | null>((w, n) => (!w || Math.abs(n.cents as number) > Math.abs(w.cents as number) ? n : w), null);
    if (worst && !worst.within) {
      const c = worst.cents as number;
      findings.push({ tone: 'work', text: `Your ${worst.written} sat ${sharpFlat(c)} (${centsMeaning(c)}).` });
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
  if (k !== 0) findings.push({ tone: 'info', text: `You sang the line ${octaveWords(k)}. That is fine: each note was judged in your octave.` });
  const slips = matched.filter((n) => n.octaveSlip).length;
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

/** The two notes of an interval take, in time order: blips under 200 ms are skipped, and one long note that glides
 * from the first pitch to the second (or a unison sung without a break) is split in two. */
function twoNotes(fr: TakeFrames, spans: NoteSpan[], unison: boolean): [SungNote | null, SungNote | null] {
  let use = spans.filter((s) => s.note.endSec - s.note.startSec >= ALIGN_SHORT_EXTRA_SEC);
  if (use.length < 2 && spans.length >= 2) use = spans;
  if (use.length === 1) {
    const sp = splitSpanInTwo(fr, use[0]);
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
  const { status, spans, fr } = sungSpansOf(samples, sampleRate, opts.a4Hz);
  if (status !== 'ok') return { ...base, status, findings: [unscoredFinding(status)] };
  const [first, second] = twoNotes(fr, spans, semis === 0);
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
  if (k !== 0) findings.push({ tone: 'info', text: `You sang it ${octaveWords(k)}; that is fine.` });
  out.findings = findings.slice(0, MAX_FINDINGS);
  if (!first && !second) out.status = 'no-pitch';
  return out;
}
