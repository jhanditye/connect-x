// Single held notes: the pitch accuracy test and match-the-note (offline score and live lock-in).

import { mean } from '../../dsp/stats';
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
  LAND_STAY_SEC,
  LANDING_SLOPE_ST_PER_SEC,
  LANDING_WINDOW_SEC,
  LOCK_AVERAGE_SEC,
  LOCK_DROPOUT_SEC,
  LOCK_HOLD_SEC,
  MAX_FINDINGS,
  PRAISE_SHARE,
  REGISTER_FINDING_CENTS,
  REGISTER_FINDING_MIN_NOTES,
  SCOOP_FINDING_CENTS,
  SMOOTH_SEC,
  WANDER_FINDING_CENTS,
} from './constants';
import { centsMeaning, sharpFlat } from './format';
import { analyseTake, foldCents, slopeAt, smoothRange, takeStatus, unscoredFinding, voicedStretches } from './frames';
import { buildNote, landingPitch } from './segment';

/**
 * Scores one held note against `targetMidi`. The main note is the longest voiced stretch (gaps under 100 ms
 * bridged). Held = pitch over the steady part (whole vibrato cycles); landing = the first 200 ms after the 200 ms-
 * smoothed slope first drops under 3 semitones/s, measured from the voice onset (a flat landing that is then
 * corrected shows here; a quick scoop does not, it shows in timeToLandSec); stability = SD of the smoothed pitch.
 * Octave errors: pitch class is judged and octaveOffset says how many octaves away the voice was.
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
  if (status !== 'ok') return empty(status, [unscoredFinding(status)]);

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
  if (!best || !span) return empty('no-pitch', [unscoredFinding('no-pitch')]);
  const note = span.note;
  const hop = fr.hop;
  const tol = opts.toleranceCents;

  const octaveOffset = Math.round((note.midi - targetMidi) / 12) || 0;
  const heldCents = foldCents((note.midi - targetMidi) * 100);

  // Landing and time to land are measured from the voice onset over the whole stretch (scoops included).
  const [s0, s1] = best;
  const sm = smoothRange(fr.midi, s0, s1, Math.max(3, Math.round(SMOOTH_SEC / hop) | 1));
  const lw = Math.round(LANDING_WINDOW_SEC / hop);
  let landingCents: number | null = null;
  for (let k = 0; k + lw <= sm.length; k++) {
    const sl = slopeAt(sm, k, hop);
    if (Number.isNaN(sl) || Math.abs(sl) >= LANDING_SLOPE_ST_PER_SEC) continue;
    const m = landingPitch(fr, s0 + k, lw);
    if (!Number.isNaN(m)) landingCents = foldCents((m - targetMidi) * 100);
    break;
  }
  if (landingCents !== null) note.landingMidi = targetMidi + 12 * octaveOffset + landingCents / 100;
  let onset = 0;
  while (onset < sm.length && Number.isNaN(sm[onset])) onset++;
  const stay = Math.round(LAND_STAY_SEC / hop);
  let timeToLandSec: number | null = null;
  let run = 0;
  for (let k = onset; k < sm.length; k++) {
    if (Number.isNaN(sm[k])) continue;
    if (Math.abs(foldCents((sm[k] - targetMidi) * 100)) <= tol) {
      run++;
      if (run >= stay) {
        timeToLandSec = Math.max(0, (k - run + 1 - onset) * hop);
        break;
      }
    } else run = 0;
  }

  const within = Math.abs(heldCents) <= tol;
  const findings: Finding[] = [];
  if (octaveOffset !== 0) {
    findings.push({
      tone: 'info',
      text: `Right note, ${Math.abs(octaveOffset) === 1 ? 'one octave' : `${Math.abs(octaveOffset)} octaves`} ${octaveOffset < 0 ? 'lower' : 'higher'}. That is fine: the note name is what counts here.`,
    });
  }
  if (within) findings.push({ tone: 'good', text: `In tune: ${sharpFlat(heldCents)}.` });
  else findings.push({ tone: 'work', text: `You held it ${sharpFlat(heldCents)} (${centsMeaning(heldCents)}).` });
  if (landingCents !== null && landingCents - heldCents <= SCOOP_FINDING_CENTS) {
    findings.push({ tone: 'work', text: `You arrived about ${Math.round(heldCents - landingCents)} cents under the note and then slid up. Aim for the centre straight away.` });
  }
  if (note.stabilityCents > WANDER_FINDING_CENTS) {
    findings.push({ tone: 'work', text: `The pitch wandered (about ${Math.round(note.stabilityCents)} cents up and down, vibrato not counted).` });
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
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

const REGISTER_WORDS: Record<RegisterThird, string> = { low: 'low', mid: 'middle', high: 'high' };

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
  const scored = notes.filter((n) => n.status === 'ok' && n.heldCents !== null);
  const cents = scored.map((n) => n.heldCents as number);
  const nullable = (xs: number[]) => (xs.length ? mean(xs) : null);
  const stab = scored.map((n) => n.stabilityCents).filter((c): c is number => c !== null && Number.isFinite(c));
  const ttl = scored.map((n) => n.timeToLandSec).filter((c): c is number => c !== null);
  const byRegister: Record<RegisterThird, RegisterStats> = {
    low: registerStats(scored.filter((n) => n.register === 'low'), toleranceCents),
    mid: registerStats(scored.filter((n) => n.register === 'mid'), toleranceCents),
    high: registerStats(scored.filter((n) => n.register === 'high'), toleranceCents),
  };
  const shareWithin = cents.length ? cents.filter((c) => Math.abs(c) <= toleranceCents).length / cents.length : null;
  const shareWithin50 = cents.length ? cents.filter((c) => Math.abs(c) <= WIDE_BAND_CENTS).length / cents.length : null;
  const biasCents = nullable(cents);
  const meanAbsCents = nullable(cents.map(Math.abs));
  const octaveSlips = scored.filter((n) => n.octaveOffset !== 0).length;

  const findings: Finding[] = [];
  if (!scored.length) {
    findings.push({ tone: 'info', text: 'No notes could be scored this time. Check the microphone and sing a clear "ah".' });
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
    if (octaveSlips > 0) {
      findings.push({ tone: 'info', text: `${octaveSlips} ${octaveSlips === 1 ? 'note was' : 'notes were'} sung in a different octave. That is fine: the note name was judged.` });
    }
    if (!findings.length && meanAbsCents !== null) {
      findings.push({ tone: 'info', text: `On average you were ${Math.round(meanAbsCents)} cents from the note (${centsMeaning(meanAbsCents)}).` });
    }
  }
  return {
    scored: scored.length,
    unscored: notes.length - scored.length,
    meanAbsCents,
    shareWithin,
    shareWithin50,
    biasCents,
    meanStabilityCents: nullable(stab),
    meanTimeToLandSec: nullable(ttl),
    octaveSlips,
    byRegister,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

export interface LockState {
  /** Pitch-class error of the last 200 ms of voiced readings, cents; null when not singing. */
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
 * 200 ms so vibrato does not throw the needle out of the band; a voicing dropout up to 150 ms does not reset the hold.
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
        lockSec = Math.max(0, insideSince - (firstVoiced ?? insideSince));
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
