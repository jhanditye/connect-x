// Single held notes: the pitch accuracy test and match-the-note (offline score and live lock-in).

import { mean } from '../../dsp/stats';
import { intervalPhrase } from '../theory/intervals';
import { registerThirdOf } from '../theory/range';
import type {
  Finding,
  HeldNoteScore,
  LiveReading,
  PitchTestSummary,
  RegisterStats,
  RegisterThird,
  ScoreOptions,
  VoiceRange,
} from '../types';
import { WIDE_BAND_CENTS } from '../types';
import {
  BIAS_FINDING_CENTS,
  BIAS_FINDING_MIN_NOTES,
  END_DRIFT_FINDING_CENTS,
  END_DRIFT_MIN_SEC,
  END_DRIFT_SEC,
  HELD_CONFIDENT_STEADY_SEC,
  LAND_SMOOTH_SEC,
  LAND_STAY_SEC,
  LANDING_WINDOW_SEC,
  LOCK_AVERAGE_SEC,
  LOCK_DROPOUT_SEC,
  LOCK_HOLD_SEC,
  MAX_FINDINGS,
  PRAISE_SHARE,
  REGISTER_FINDING_CENTS,
  REGISTER_FINDING_MIN_NOTES,
  SCOOP_FINDING_CENTS,
  SHORT_NOTE_MAX_SEC,
  SMOOTH_SEC,
  WANDER_FINDING_CENTS,
  WRONG_NOTE_CENTS,
} from './constants';
import { centsMeaning, sharpFlat } from './format';
import {
  analyseTake,
  foldCents,
  heldPitch,
  isPureTone,
  octaveAndCents,
  pureToneFinding,
  smoothRange,
  takeStatus,
  unscoredFindingFor,
  voiceCheck,
  voicedStretches,
  type TakeFrames,
} from './frames';
import { buildNote, type NoteSpan } from './segment';

/**
 * Landing: the mean pitch over the first LANDING_WINDOW_SEC (200 ms) of the voice, from the first voiced frame of the
 * stretch. A scoop pulls it down in proportion to its depth and length (a 150-cent scoop over 120 ms reads about -40,
 * a 300-cent one over 350 ms about -210), so "you arrived under the note" grows with the scoop. A vibrato that starts
 * at the onset moves it at most about 25 cents (+/-100 cents at 4 Hz), under the scoop finding's 30. (A window of one
 * vibrato cycle was tried: a vibrato that starts 150 ms late then reads +31 on an in-tune note.) Frames more than 6
 * semitones from the held pitch (tracker slips at the onset) are left out. Fractional MIDI, or null when unvoiced.
 */
export function onsetLanding(fr: TakeFrames, s0: number, s1: number, span: Pick<NoteSpan, 'note'>): number | null {
  let k0 = s0;
  while (k0 < s1 && Number.isNaN(fr.midi[k0])) k0++;
  k0++; // the very first voiced frame straddles the onset
  const k1 = Math.min(s1, k0 + Math.round(LANDING_WINDOW_SEC / fr.hop));
  let sum = 0;
  let n = 0;
  for (let k = k0; k < k1; k++) {
    const m = fr.midi[k];
    if (Number.isNaN(m) || Math.abs(m - span.note.midi) > 6) continue;
    sum += m;
    n++;
  }
  return n >= 3 ? sum / n : null;
}

/**
 * How far the pitch moved over the last END_DRIFT_SEC (`tailSec`) of a note's steady part against the steady part
 * before it, cents (- = sagged flat), each measured as a vibrato centre at the note's rate. Null when the note is too
 * short to tell (under END_DRIFT_MIN_SEC before the window).
 */
export function endDriftCents(fr: TakeFrames, steady: readonly number[], rateHz: number | null, tailSec = END_DRIFT_SEC): number | null {
  if (!steady.length) return null;
  const tEnd = steady[steady.length - 1];
  const cut = tEnd - Math.round(tailSec / fr.hop);
  const head = steady.filter((k) => k <= cut);
  const tail = steady.filter((k) => k > cut);
  if ((head.length ? head[head.length - 1] - head[0] : 0) * fr.hop < END_DRIFT_MIN_SEC || tail.length < 10) return null;
  const a = heldPitch(head.map((k) => fr.midi[k]), head, fr.hop, rateHz);
  const b = heldPitch(tail.map((k) => fr.midi[k]), tail, fr.hop, rateHz);
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) * 100 : null;
}

/** "sagged about 30 cents flat" / "crept up about 20 cents sharp" for an end drift. */
export function endDriftWords(c: number): string {
  return c < 0 ? `sagged about ${Math.round(-c)} cents flat` : `crept up about ${Math.round(c)} cents sharp`;
}

/**
 * Scores one held note against `targetMidi`. The main note is the longest voiced stretch (gaps under 100 ms
 * bridged). Held = pitch over the steady part (whole vibrato cycles); landing = the mean over the first moment of the
 * voice (onsetLanding: grows with the depth and length of a scoop); stability = SD of the smoothed pitch; endDriftCents
 * = the last 0.5 s against the rest (a sag is reported, not averaged away). A steady pure tone is refused (voice check),
 * a note too short to measure says so, and a short note (under HELD_CONFIDENT_STEADY_SEC of steady pitch) is marked
 * low confidence. Octave errors: pitch class is judged and octaveOffset says how many octaves away the voice was.
 */
export function scoreHeldNote(
  samples: Float32Array,
  sampleRate: number,
  targetMidi: number,
  opts: ScoreOptions & { range: VoiceRange },
): HeldNoteScore {
  const register = registerThirdOf(targetMidi, opts.range);
  const empty = (status: HeldNoteScore['status'], findings: Finding[]): HeldNoteScore => ({
    status,
    targetMidi,
    sung: null,
    octaveOffset: 0,
    landingCents: null,
    heldCents: null,
    stabilityCents: null,
    timeToLandSec: null,
    within: false,
    register,
    findings,
  });
  const fr = analyseTake(samples, sampleRate, opts.a4Hz);
  const status = takeStatus(fr);
  if (status !== 'ok') return empty(status, [unscoredFindingFor(fr, status)]);

  let best: [number, number] | null = null;
  let bestCount = 0;
  for (const [a, b] of voicedStretches(fr, 0.1)) {
    let c = 0;
    for (let k = a; k < b; k++) if (fr.voiced[k]) c++;
    if (c > bestCount) {
      bestCount = c;
      best = [a, b];
    }
  }
  const span = best ? buildNote(fr, best[0], best[1], 0.2) : null;
  if (!best || !span) return empty('no-pitch', [unscoredFindingFor(fr, 'no-pitch')]);
  // A steady pure tone (the prompt leaking from a speaker, a tuning app) is not a sung note.
  if (isPureTone(voiceCheck(samples, sampleRate, fr, span.i0, span.i1))) return empty('no-pitch', [pureToneFinding()]);
  const note = span.note;
  // A held note needs more steady pitch than a line note before its number is more than rough.
  const tooShort = note.steadySec < HELD_CONFIDENT_STEADY_SEC;
  if (tooShort) note.confidence = 'low';
  const lowConfidence = note.confidence === 'low';
  const hop = fr.hop;
  const tol = opts.toleranceCents;

  // An octave error only when the pitch class is right; a 5th up is a different note (+700), not "an octave up, 500 flat".
  const oc = octaveAndCents((note.midi - targetMidi) * 100);
  const octaveOffset = oc.octaves || 0;
  const heldCents = oc.cents;
  const wrongNote = Math.abs(heldCents) >= WRONG_NOTE_CENTS;
  const centsOf = (midi: number) => (midi - targetMidi - 12 * octaveOffset) * 100;

  // Landing and time to land are measured from the voice onset over the whole stretch (scoops included).
  const [s0, s1] = best;
  const sm = smoothRange(fr.midi, s0, s1, Math.max(3, Math.round(SMOOTH_SEC / hop) | 1));
  const landMidi = onsetLanding(fr, s0, s1, span);
  const landingCents: number | null = landMidi === null ? null : centsOf(landMidi);
  if (landingCents !== null) note.landingMidi = targetMidi + 12 * octaveOffset + landingCents / 100;
  // Time to land: averaged over whole vibrato cycles (LAND_SMOOTH_SEC), so a centred vibrato counts as landed.
  const smLand = smoothRange(fr.midi, s0, s1, Math.max(3, Math.round(LAND_SMOOTH_SEC / hop) | 1));
  let onset = 0;
  while (onset < sm.length && Number.isNaN(sm[onset])) onset++;
  const stay = Math.round(LAND_STAY_SEC / hop);
  let timeToLandSec: number | null = null;
  let run = 0;
  for (let k = onset; k < smLand.length; k++) {
    if (Number.isNaN(smLand[k])) continue;
    if (Math.abs(centsOf(smLand[k])) <= tol) {
      run++;
      if (run >= stay) {
        timeToLandSec = Math.max(0, (k - run + 1 - onset) * hop);
        break;
      }
    } else run = 0;
  }

  // A rough reading never claims "in tune": the number is shown, but `within` is not given on it.
  const within = !lowConfidence && Math.abs(heldCents) <= tol;
  const endDrift = endDriftCents(fr, span.steady, span.vibRateHz);
  const findings: Finding[] = [];
  if (octaveOffset !== 0) {
    findings.push({
      tone: 'info',
      text: `Right note, ${Math.abs(octaveOffset) === 1 ? 'one octave' : `${Math.abs(octaveOffset)} octaves`} ${octaveOffset < 0 ? 'lower' : 'higher'}. That is fine: the note name is what counts here.`,
    });
  }
  if (within) findings.push({ tone: 'good', text: `In tune: ${sharpFlat(heldCents)}.` });
  else if (wrongNote) findings.push({ tone: 'work', text: `That was a different note: ${differentNoteWords(heldCents)} the one played. Listen again and match it.` });
  else findings.push({ tone: 'work', text: `You held it ${sharpFlat(heldCents)} (${centsMeaning(heldCents)}).` });
  if (!wrongNote && landingCents !== null && landingCents - heldCents <= SCOOP_FINDING_CENTS) {
    findings.push({ tone: 'work', text: `You arrived about ${Math.round(heldCents - landingCents)} cents under the note and then slid up. Aim for the centre straight away.` });
  }
  if (!wrongNote && endDrift !== null && Math.abs(endDrift) >= END_DRIFT_FINDING_CENTS) {
    findings.push({ tone: 'work', text: `Towards the end the pitch ${endDriftWords(endDrift)}. Keep the air flowing right to the end of the note.` });
  }
  if (note.stabilityCents > WANDER_FINDING_CENTS) {
    findings.push({ tone: 'work', text: `The pitch wandered (about ${Math.round(note.stabilityCents)} cents up and down, vibrato not counted).` });
  }
  if (lowConfidence) {
    // Said first: the number is shown, but it is rough.
    // The reason given is the real one: a short note, or a long one whose pitch could not be pinned down.
    findings.unshift({
      tone: 'info',
      text: tooShort && note.endSec - note.startSec < SHORT_NOTE_MAX_SEC
        ? `That note was short (about ${(note.endSec - note.startSec).toFixed(1)} seconds), so this reading is rough and is not counted in your averages. Hold each note for about a second.`
        : `The pitch of that note was hard to pin down (it was very soft or unsteady), so this reading is rough and is not counted in your averages. Sing a little louder on a clear "ah".`,
    });
  }
  return {
    status: 'ok',
    targetMidi,
    sung: note,
    octaveOffset,
    landingCents,
    heldCents,
    stabilityCents: note.stabilityCents,
    timeToLandSec,
    within,
    register,
    endDriftCents: endDrift,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

const REGISTER_WORDS: Record<RegisterThird, string> = { low: 'low', mid: 'middle', high: 'high' };

/** "about a perfect 5th above", "a semitone below" for a different note (cents from the target). */
export function differentNoteWords(cents: number): string {
  const semis = Math.round(Math.abs(cents) / 100);
  const where = cents > 0 ? 'above' : 'below';
  if (semis <= 1) return `about a semitone ${where}`;
  if (semis <= 12) return `about ${intervalPhrase(semis, 'up').replace(/ up$/, '')} ${where}`;
  return `more than an octave ${where}`;
}

/** A held note sung as a different note (not just out of tune, not just another octave). */
export function isWrongHeldNote(n: Pick<HeldNoteScore, 'status' | 'heldCents'>): boolean {
  return n.status === 'ok' && n.heldCents !== null && Math.abs(n.heldCents) >= WRONG_NOTE_CENTS;
}

function registerStats(notes: HeldNoteScore[], tol: number): RegisterStats {
  const cents = notes.map((n) => n.heldCents).filter((c): c is number => c !== null);
  if (!cents.length) return { n: 0, meanAbsCents: null, biasCents: null, shareWithin: null };
  return {
    n: cents.length,
    meanAbsCents: mean(cents.map(Math.abs)),
    biasCents: mean(cents),
    shareWithin: cents.filter((c) => Math.abs(c) <= tol).length / cents.length,
  };
}

/** Summary of a pitch test: accuracy, bias, by register, and up to three plain findings. */
export function summarisePitchTest(notes: HeldNoteScore[], toleranceCents: number): PitchTestSummary {
  // Low-confidence notes (too short to measure reliably) are shown on their own but kept out of every figure here.
  const lowConfidence = notes.filter((n) => n.status === 'ok' && n.heldCents !== null && n.sung?.confidence === 'low');
  const allScored = notes.filter((n) => n.status === 'ok' && n.heldCents !== null && n.sung?.confidence !== 'low');
  // Different notes are counted, named and kept out of the averages (one misheard note must not read as a flat voice).
  const wrong = allScored.filter((n) => isWrongHeldNote(n));
  const scored = allScored.filter((n) => !isWrongHeldNote(n));
  const cents = scored.map((n) => n.heldCents as number);
  const nullable = (xs: number[]) => (xs.length ? mean(xs) : null);
  const stab = scored.map((n) => n.stabilityCents).filter((c): c is number => c !== null && Number.isFinite(c));
  const ttl = scored.map((n) => n.timeToLandSec).filter((c): c is number => c !== null);
  const byRegister: Record<RegisterThird, RegisterStats> = {
    low: registerStats(scored.filter((n) => n.register === 'low'), toleranceCents),
    mid: registerStats(scored.filter((n) => n.register === 'mid'), toleranceCents),
    high: registerStats(scored.filter((n) => n.register === 'high'), toleranceCents),
  };
  const shareWithin = allScored.length ? cents.filter((c) => Math.abs(c) <= toleranceCents).length / allScored.length : null;
  const shareWithin50 = allScored.length ? cents.filter((c) => Math.abs(c) <= WIDE_BAND_CENTS).length / allScored.length : null;
  const biasCents = nullable(cents);
  const meanAbsCents = nullable(cents.map(Math.abs));
  const octaveSlips = scored.filter((n) => n.octaveOffset !== 0).length;

  const findings: Finding[] = [];
  if (!allScored.length) {
    findings.push(
      lowConfidence.length
        ? {
            tone: 'info',
            text: `${lowConfidence.length === 1 ? 'The note was' : `All ${lowConfidence.length} notes were`} too short or too unsteady to measure reliably, so nothing is scored this time. Hold each note for about a second.`,
          }
        : { tone: 'info', text: 'No notes could be scored this time. Check the microphone and sing a clear "ah".' },
    );
  } else {
    if (shareWithin !== null && shareWithin >= PRAISE_SHARE) {
      findings.push({ tone: 'good', text: `${Math.round(shareWithin * 100)} % of your notes were within ${toleranceCents} cents. Strong, reliable tuning.` });
    }
    let worst: RegisterThird | null = null;
    for (const r of ['low', 'mid', 'high'] as RegisterThird[]) {
      const s = byRegister[r];
      if (s.n < REGISTER_FINDING_MIN_NOTES || s.biasCents === null || Math.abs(s.biasCents) < REGISTER_FINDING_CENTS) continue;
      if (!worst || Math.abs(s.biasCents) > Math.abs(byRegister[worst].biasCents ?? 0)) worst = r;
    }
    if (worst) {
      const b = byRegister[worst].biasCents as number;
      findings.push({ tone: 'work', text: `Your ${REGISTER_WORDS[worst]} notes sit about ${Math.round(Math.abs(b))} cents ${b > 0 ? 'sharp' : 'flat'} (${centsMeaning(b)}).` });
    }
    if (biasCents !== null && scored.length >= BIAS_FINDING_MIN_NOTES && Math.abs(biasCents) >= BIAS_FINDING_CENTS) {
      findings.push({ tone: 'work', text: `Overall you tend to sit ${sharpFlat(biasCents)}.` });
    }
    const scoops = scored.filter((n) => n.landingCents !== null).map((n) => (n.landingCents as number) - (n.heldCents as number));
    if (scoops.length >= 3 && mean(scoops) <= SCOOP_FINDING_CENTS) {
      findings.push({ tone: 'work', text: `You often start under the note and slide up (about ${Math.round(-mean(scoops))} cents). Hear the note first, then start right on it.` });
    }
    if (stab.length && mean(stab) > WANDER_FINDING_CENTS) {
      findings.push({ tone: 'work', text: `Held notes wander about ${Math.round(mean(stab))} cents (vibrato not counted). Long tones will help.` });
    }
    if (wrong.length > 0) {
      const w = wrong[0].heldCents as number;
      findings.push({
        tone: 'work',
        text:
          wrong.length === 1
            ? `One note came out as a different note (${differentNoteWords(w)} the one played), so it is left out of the averages. Listen to each note before you sing.`
            : `${wrong.length} notes came out as different notes, so they are left out of the averages. Listen to each note before you sing.`,
      });
    }
    if (octaveSlips > 0) {
      findings.push({ tone: 'info', text: `${octaveSlips} ${octaveSlips === 1 ? 'note was' : 'notes were'} sung in a different octave. That is fine: the note name was judged.` });
    }
    if (lowConfidence.length > 0) {
      findings.push({
        tone: 'info',
        text: `${lowConfidence.length} ${lowConfidence.length === 1 ? 'note was' : 'notes were'} too short to measure reliably, so ${lowConfidence.length === 1 ? 'it is' : 'they are'} left out of these figures. Hold each note for about a second.`,
      });
    }
    if (!findings.length && meanAbsCents !== null) {
      findings.push({ tone: 'info', text: `On average you were ${Math.round(meanAbsCents)} cents from the note (${centsMeaning(meanAbsCents)}).` });
    }
  }
  return {
    scored: allScored.length,
    unscored: notes.length - allScored.length,
    meanAbsCents,
    shareWithin,
    shareWithin50,
    biasCents,
    meanStabilityCents: nullable(stab),
    meanTimeToLandSec: nullable(ttl),
    octaveSlips,
    wrongNotes: wrong.length,
    byRegister,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

export interface LockState {
  /** Pitch-class error of the last 500 ms of voiced readings, cents; null when not singing. */
  centsNow: number | null;
  inside: boolean;
  /** Seconds continuously inside the tolerance so far. */
  heldSec: number;
  locked: boolean;
  /** Seconds from the first voiced reading to the start of the hold that locked (0 = found it at once). */
  lockSec: number | null;
}

/**
 * Live lock-in for "Match the note": pass = `holdSec` continuously inside the tolerance. Readings are averaged over
 * 500 ms (whole vibrato cycles) so vibrato does not throw the needle out of the band; a voicing dropout up to 150 ms does not reset the hold.
 */
export function createLockTracker(
  targetMidi: number,
  toleranceCents: number,
  holdSec = LOCK_HOLD_SEC,
): { push(r: LiveReading): LockState; reset(): void } {
  let win: { t: number; midi: number }[] = [];
  let firstVoiced: number | null = null;
  let lastVoiced: number | null = null;
  let insideSince: number | null = null;
  let locked = false;
  let lockSec: number | null = null;
  return {
    push(r: LiveReading): LockState {
      if (r.midi !== null && Number.isFinite(r.midi)) {
        win.push({ t: r.t, midi: r.midi });
        if (firstVoiced === null) firstVoiced = r.t;
        lastVoiced = r.t;
      }
      while (win.length && win[0].t < r.t - LOCK_AVERAGE_SEC) win.shift();
      let centsNow: number | null = null;
      if (lastVoiced === null || r.t - lastVoiced > LOCK_DROPOUT_SEC || !win.length) {
        win = [];
        insideSince = null;
      } else {
        let s = 0;
        for (const w of win) s += w.midi;
        centsNow = foldCents((s / win.length - targetMidi) * 100);
      }
      const inside = centsNow !== null && Math.abs(centsNow) <= toleranceCents;
      if (inside) {
        if (insideSince === null) insideSince = r.t;
      } else if (centsNow !== null) insideSince = null;
      const heldSec = insideSince !== null ? r.t - insideSince : 0;
      if (!locked && insideSince !== null && heldSec >= holdSec - 1e-9) {
        locked = true;
        // The average describes the middle of its window, so the voice got there about half a window earlier.
        lockSec = Math.max(0, insideSince - LOCK_AVERAGE_SEC / 2 - (firstVoiced ?? insideSince));
      }
      return { centsNow, inside, heldSec, locked, lockSec };
    },
    reset() {
      win = [];
      firstVoiced = null;
      lastVoiced = null;
      insideSince = null;
      locked = false;
      lockSec = null;
    },
  };
}
