// Scale-degree lines and sung intervals: segment the take, align it to the expected pitches, score each note against
// the key, the steps between neighbours, the drift over the line and the whole-take octave.

import { mean, median } from '../../dsp/stats';
import { intervalName } from '../theory/intervals';
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
import { bestOctaveAlignment } from './align';
import { DRIFT_FINDING_CENTS, DRIFT_MIN_NOTES, MAX_FINDINGS, PRAISE_SHARE, WRONG_DIRECTION_CENTS } from './constants';
import { centsMeaning, sharpFlat } from './format';
import { analyseTake, foldCents, takeStatus, unscoredFinding } from './frames';
import { segmentSpans } from './segment';

function sungNotesOf(samples: Float32Array, sampleRate: number, a4Hz: number): { status: TakeStatus; notes: SungNote[] } {
  const fr = analyseTake(samples, sampleRate, a4Hz);
  const status = takeStatus(fr);
  if (status !== 'ok') return { status, notes: [] };
  const notes = segmentSpans(fr).map((s) => s.note);
  return { status: notes.length ? 'ok' : 'no-pitch', notes };
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
 * the whole take may sit 1-2 octaves away (fine, and said so); a single note an octave away from the rest is folded
 * and flagged. Every number is against the key (absolute pitch at the singer's A4).
 */
export function scoreSequence(samples: Float32Array, sampleRate: number, target: SequenceTarget, opts: ScoreOptions): SequenceScore {
  const tol = opts.toleranceCents;
  const { status, notes: sung } = sungNotesOf(samples, sampleRate, opts.a4Hz);
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
      findings: [unscoredFinding(status)],
    };
  }
  const al = bestOctaveAlignment(target.midis, sung);
  const k = al.octaveOffset;
  const notes = blankNotes();
  let prev: SequenceNoteScore | null = null;
  for (let i = 0; i < notes.length; i++) {
    const j = al.match[i];
    if (j === null) continue;
    const s = sung[j];
    const raw = (s.midi - target.midis[i] - 12 * k) * 100;
    const cents = foldCents(raw);
    const ns = notes[i];
    ns.sung = s;
    ns.cents = cents;
    ns.octaveSlip = Math.abs(raw) > 600;
    ns.within = Math.abs(cents) <= tol;
    if (prev && prev.cents !== null) ns.intervalCents = cents - prev.cents;
    prev = ns;
  }
  const matched = notes.filter((n) => n.cents !== null);
  const cents = matched.map((n) => n.cents as number);
  const steps = notes.map((n) => n.intervalCents).filter((c): c is number => c !== null);
  const missing = notes.length - matched.length;
  let driftCents: number | null = null;
  if (matched.length >= 3) {
    const t = matched.map((n) => (n.sung as SungNote).startSec);
    const slope = theilSenSlope(t, cents);
    if (Number.isFinite(slope)) driftCents = slope * (t[t.length - 1] - t[0]);
  }
  const noteAccuracy = notes.length ? matched.filter((n) => n.within).length / notes.length : null;
  const meanAbsCents = cents.length ? mean(cents.map(Math.abs)) : null;
  const biasCents = cents.length ? mean(cents) : null;
  const extras = al.extras.map((j) => sung[j]);

  const findings: Finding[] = [];
  if (noteAccuracy !== null && noteAccuracy >= PRAISE_SHARE && missing === 0) {
    findings.push({ tone: 'good', text: `${matched.filter((n) => n.within).length} of ${notes.length} notes within ${tol} cents. Well pitched.` });
  }
  const worst = matched.reduce<SequenceNoteScore | null>((w, n) => (!w || Math.abs(n.cents as number) > Math.abs(w.cents as number) ? n : w), null);
  if (worst && !worst.within) {
    const c = worst.cents as number;
    findings.push({ tone: 'work', text: `Your ${worst.written} sat ${sharpFlat(c)} (${centsMeaning(c)}).` });
  }
  if (driftCents !== null && matched.length >= DRIFT_MIN_NOTES && Math.abs(driftCents) >= DRIFT_FINDING_CENTS) {
    findings.push({
      tone: 'work',
      text: `The line slid about ${Math.round(Math.abs(driftCents))} cents ${driftCents < 0 ? 'flat' : 'sharp'} from start to finish. Keep the key note in your ear.`,
    });
  }
  if (missing > 0 || extras.length > 0) {
    const parts: string[] = [];
    if (missing > 0) parts.push(`${missing} ${missing === 1 ? 'note' : 'notes'} I could not hear`);
    if (extras.length > 0) parts.push(`${extras.length} extra ${extras.length === 1 ? 'note' : 'notes'}`);
    findings.push({ tone: 'info', text: `${parts.join(' and ')}; the rest were matched in order.` });
  }
  if (k !== 0) findings.push({ tone: 'info', text: `You sang the line ${octaveWords(k)}. That is fine: each note was judged in your octave.` });
  const slips = matched.filter((n) => n.octaveSlip).length;
  if (slips > 0) findings.push({ tone: 'info', text: `${slips} ${slips === 1 ? 'note jumped' : 'notes jumped'} to a different octave; judged on the note name.` });

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
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

/**
 * Scores "sing the note, then an interval up/down" in one take. The core number is the interval size error
 * (independent of where the first note started): sign(direction) * (second - first) * 100 - semitones * 100, + too wide.
 * An interval more than 600 cents off (an inversion, or the wrong octave) is folded, flagged and never "within".
 */
export function scoreSungInterval(samples: Float32Array, sampleRate: number, target: IntervalTarget, opts: ScoreOptions): SungIntervalScore {
  const tol = opts.toleranceCents;
  const sign = target.direction === 'down' ? -1 : 1;
  const targetMidi = target.referenceMidi + sign * Math.abs(target.semitones);
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
  const { status, notes: sung } = sungNotesOf(samples, sampleRate, opts.a4Hz);
  if (status !== 'ok') return { ...base, status, findings: [unscoredFinding(status)] };
  const al = bestOctaveAlignment([target.referenceMidi, targetMidi], sung);
  const k = al.octaveOffset;
  const first = al.match[0] !== null ? sung[al.match[0]] : null;
  const second = al.match[1] !== null ? sung[al.match[1]] : null;
  const out: SungIntervalScore = { ...base, first, second, octaveOffset: k };
  const findings: Finding[] = [];
  if (first) out.referenceCents = foldCents((first.midi - target.referenceMidi - 12 * k) * 100);
  if (second) out.targetCents = foldCents((second.midi - targetMidi - 12 * k) * 100);
  if (first && second) {
    const sungSemis = second.midi - first.midi;
    out.sungSemitones = sungSemis;
    const raw = (sign * sungSemis - Math.abs(target.semitones)) * 100;
    const folded = Math.abs(raw) > 600 ? foldCents(raw) : raw;
    out.intervalCents = folded;
    out.wrongDirection = target.semitones !== 0 && sign * sungSemis * 100 <= -WRONG_DIRECTION_CENTS;
    out.within = Math.abs(raw) <= 600 && Math.abs(folded) <= tol && !out.wrongDirection;
    const name = intervalName(target.semitones) || 'interval';
    if (out.wrongDirection) {
      findings.push({ tone: 'work', text: `The second note went ${sign > 0 ? 'down' : 'up'} instead of ${sign > 0 ? 'up' : 'down'}. Listen again: ${target.direction === 'up' ? 'rise' : 'fall'} by a ${name}.` });
    } else if (Math.abs(raw) > 600) {
      findings.push({ tone: 'work', text: `The second note was the right note name but in another octave, so the jump was not a ${name}.` });
    } else if (out.within) {
      findings.push({ tone: 'good', text: `A clean ${name}: ${Math.round(Math.abs(folded))} cents from exact.` });
    } else {
      findings.push({ tone: 'work', text: `Your ${name} was ${Math.round(Math.abs(folded))} cents too ${folded > 0 ? 'wide' : 'narrow'} (${centsMeaning(folded)}).` });
    }
  } else {
    findings.push({ tone: 'info', text: first ? 'I heard the first note but not a clear second one.' : 'I could not hear two clear notes. Sing each one for about a second.' });
  }
  if (out.referenceCents !== null && Math.abs(out.referenceCents) > tol) {
    findings.push({ tone: 'info', text: `Your first note started ${sharpFlat(out.referenceCents)}; the interval is judged from where you started.` });
  }
  if (k !== 0) findings.push({ tone: 'info', text: `You sang it ${octaveWords(k)}; that is fine.` });
  out.findings = findings.slice(0, MAX_FINDINGS);
  if (!first && !second) out.status = 'no-pitch';
  return out;
}
