// When to end a Skills take on its own, from the live readings (pure: no audio, no timers). The rules are the
// SPEC's (section 4): a steady held note for the pitch test, silence after the expected number of notes for
// intervals and lines, silence after a sustained sound for the hiss and the long tone, and a cap for everything.
// The live note count is deliberately cautious: counting too few notes only means the cap (or the singer's
// button) ends the take; counting too many could cut a line off during a breath.

import type { AutoStopRule, LiveReading, StopReason } from '../types';

export const AUTO_STOP_TUNING = Object.freeze({
  /** Mean of the voiced readings over this window smooths vibrato (about one cycle at 5.5 Hz leaves ±8 of ±40 cents). */
  smoothSec: 0.15,
  /** A note counts once its smoothed pitch has stayed within noteWithinCents of its centre this long. */
  noteMinSec: 0.15,
  noteWithinCents: 50,
  /** A move away from the note's centre by more than this, held moveHoldSec, starts a new note. */
  moveCents: 70,
  moveHoldSec: 0.12,
  /** Voiced readings this far apart end a note (gaps are measured between voiced readings, ~30 ms apart). */
  noteGapSec: 0.08,
  /** Held-note rule: voiced readings up to this far apart are bridged (breathy dropouts of about 0.12 s). */
  heldGapSec: 0.15,
  /** Room-noise floor: median level of the first half second ... */
  floorCalibSec: 0.5,
  /** ... unless that was already this loud (the singer started at once): then assume a quiet room ... */
  floorLoudDb: -45,
  floorDefaultDb: -60,
  /** ... and lower it whenever a quieter 300 ms window turns up. */
  floorWindowSec: 0.3,
  /** Silence = level below max(silenceAbsDb, floor + silenceAboveFloorDb). */
  silenceAbsDb: -55,
  silenceAboveFloorDb: 6,
  /** Sound has started after this much continuous level above the silence line. */
  soundStartSec: 0.15,
  /**
   * Lines of at least relaxedMinNotes: once all but one note has been heard, twice the silence also ends the take
   * (the singer skipped a note, or two notes ran together on one vowel). Not used for two-note intervals, where a
   * pause to think between the notes is normal.
   */
  relaxedMinNotes: 4,
  relaxedSilenceFactor: 2,
  /** Readings further apart than this (a stalled clock) count as this much time. */
  maxDtSec: 0.1,
});

export interface AutoStop {
  /** Feed every live reading in time order; returns a reason once the take should end (and keeps returning it). */
  push(r: LiveReading): StopReason | null;
  /** Notes counted so far (cautious, see the file comment). */
  readonly notesHeard: number;
  /** Sound above the silence line has been heard for at least soundStartSec. */
  readonly soundStarted: boolean;
  /** How long the current steady note has been held, seconds (0 when none): progress for the held-note rule. */
  readonly heldSec: number;
  /** Seconds since the last singing (or, for 'sustain', since the last sound), once sound has started. */
  readonly silentSec: number;
  /** Current room-noise estimate, dBFS. */
  readonly floorDb: number;
  /** Level below which a reading counts as silence, dBFS. */
  readonly silenceDb: number;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Room-noise floor and the silence line (see AUTO_STOP_TUNING). */
export function createFloorTracker() {
  const T = AUTO_STOP_TUNING;
  const calib: number[] = [];
  let floor: number | null = null;
  let firstT: number | null = null;
  const win: { t: number; db: number }[] = [];
  return {
    push(t: number, db: number): void {
      if (!Number.isFinite(db)) return;
      firstT ??= t;
      if (floor === null) {
        calib.push(db);
        if (t - firstT >= T.floorCalibSec) {
          const m = median(calib);
          floor = m > T.floorLoudDb ? T.floorDefaultDb : m;
        }
      }
      win.push({ t, db });
      while (win.length > 0 && t - win[0].t > T.floorWindowSec) win.shift();
      if (floor !== null && t - firstT >= T.floorWindowSec) {
        let sum = 0;
        for (const w of win) sum += w.db;
        const mean = sum / win.length;
        if (mean < floor) floor = mean;
      }
    },
    get floorDb(): number {
      return floor ?? T.floorDefaultDb;
    },
    get silenceDb(): number {
      return Math.max(T.silenceAbsDb, (floor ?? T.floorDefaultDb) + T.silenceAboveFloorDb);
    },
  };
}

type RunEvent = 'none' | 'start' | 'same' | 'outside' | 'move';

/**
 * Follows the pitch of voiced readings and tells, reading by reading, whether it stays on the current note
 * ('same': the smoothed pitch within `withinCents` of the note's centre and the raw pitch within moveCents),
 * has strayed ('outside'), has settled somewhere else for moveHoldSec ('move': re-centred on the median of the
 * raw readings since it left, with the smoothing restarted there, so a new note is not blurred with the last one)
 * or starts after a gap ('start').
 */
export function createPitchRuns(p: { withinCents: number; gapSec: number }) {
  const T = AUTO_STOP_TUNING;
  let recent: { t: number; m: number }[] = [];
  let lastVoiced = -Infinity;
  let run: { start: number; sms: number[]; centre: number } | null = null;
  let pending: { t: number; m: number }[] | null = null;
  const MAX_SMS = 100;
  return {
    /** midi null = not singing (unvoiced or below the silence line). */
    push(t: number, midi: number | null): { kind: RunEvent; moveCents: number } {
      if (midi === null || !Number.isFinite(midi)) {
        if (t - lastVoiced >= p.gapSec) {
          run = null;
          pending = null;
          recent = [];
        }
        return { kind: 'none', moveCents: 0 };
      }
      const gap = t - lastVoiced;
      lastVoiced = t;
      if (gap >= p.gapSec) {
        recent = [];
        run = null;
        pending = null;
      }
      recent.push({ t, m: midi });
      while (recent.length > 1 && t - recent[0].t > T.smoothSec) recent.shift();
      let sum = 0;
      for (const r of recent) sum += r.m;
      const sm = sum / recent.length;
      if (!run) {
        run = { start: t, sms: [sm], centre: sm };
        return { kind: 'start', moveCents: 0 };
      }
      const smDev = Math.abs(sm - run.centre) * 100;
      const rawDev = Math.abs(midi - run.centre) * 100;
      if (smDev <= p.withinCents && rawDev <= T.moveCents) {
        pending = null;
        run.sms.push(sm);
        if (run.sms.length > MAX_SMS) run.sms.shift();
        run.centre = median(run.sms);
        return { kind: 'same', moveCents: 0 };
      }
      pending ??= [];
      pending.push({ t, m: midi });
      if (t - pending[0].t >= T.moveHoldSec) {
        const centre = median(pending.map((x) => x.m));
        const moveCents = (centre - run.centre) * 100;
        run = { start: pending[0].t, sms: [centre], centre };
        recent = pending;
        pending = null;
        return { kind: 'move', moveCents };
      }
      return { kind: 'outside', moveCents: 0 };
    },
    get runStart(): number | null {
      return run ? run.start : null;
    },
  };
}

/** Live auto-stop for one take (SPEC section 4). Pure: feed it readings, it returns a StopReason when it is time. */
export function createAutoStop(rule: AutoStopRule): AutoStop {
  const T = AUTO_STOP_TUNING;
  const floor = createFloorTracker();
  const notes = createPitchRuns({ withinCents: T.noteWithinCents, gapSec: T.noteGapSec });
  const steadyCents = rule.kind === 'held-note' && Number.isFinite(rule.steadyCents) && rule.steadyCents > 0 ? rule.steadyCents : T.noteWithinCents;
  const held = createPitchRuns({ withinCents: steadyCents, gapSec: T.heldGapSec });
  const capSec = Number.isFinite(rule.capSec) && rule.capSec > 0 ? rule.capSec : 30;

  let stopped: StopReason | null = null;
  let prevT: number | null = null;
  let notesHeard = 0;
  let cand: { within: number; counted: boolean } | null = null;
  let heldSec = 0;
  let loudRunStart: number | null = null;
  let lastLoudT = -Infinity;
  let soundStarted = false;
  let lastSingT = -Infinity;
  let lastT = 0;

  const silentFor = (): number => {
    if (!soundStarted) return 0;
    const since = rule.kind === 'sustain' ? lastLoudT : lastSingT;
    return Number.isFinite(since) ? Math.max(0, lastT - since) : 0;
  };

  return {
    push(r: LiveReading): StopReason | null {
      if (stopped) return stopped;
      const t = Number.isFinite(r.t) ? r.t : lastT;
      const dt = prevT === null ? 0 : Math.min(T.maxDtSec, Math.max(0, t - prevT));
      prevT = t;
      lastT = t;
      floor.push(t, r.rmsDb);
      const loud = Number.isFinite(r.rmsDb) && r.rmsDb >= floor.silenceDb;
      const singing = loud && r.midi !== null && Number.isFinite(r.midi);

      // Sound start: continuous level above the silence line (short dips up to a note gap are bridged).
      if (loud) {
        if (loudRunStart === null || t - lastLoudT > T.noteGapSec) loudRunStart = t;
        lastLoudT = t;
        if (t - loudRunStart >= T.soundStartSec) soundStarted = true;
      }
      if (singing) lastSingT = t;

      // Live note count.
      const ev = notes.push(t, singing ? r.midi : null);
      if (ev.kind === 'start' || (ev.kind === 'move' && Math.abs(ev.moveCents) > T.moveCents)) cand = { within: 0, counted: false };
      else if (ev.kind === 'same' && cand) {
        cand.within += dt;
        if (!cand.counted && cand.within >= T.noteMinSec) {
          cand.counted = true;
          notesHeard++;
          soundStarted = true;
        }
      }

      // Steady held note.
      const hev = held.push(t, singing ? r.midi : null);
      // Short excursions and dropouts are bridged by the run itself; a real move or a gap restarts it.
      const runStart = held.runStart;
      heldSec = runStart !== null ? t - runStart : 0;

      let reason: StopReason | null = null;
      switch (rule.kind) {
        case 'held-note':
          if (hev.kind === 'same' && heldSec >= rule.holdSec) reason = 'auto-held';
          break;
        case 'notes': {
          const silent = soundStarted && !singing ? silentFor() : 0;
          const expected = Math.max(1, Math.round(rule.expectedNotes));
          if (notesHeard >= expected && silent >= rule.silenceSec) reason = 'auto-silence';
          else if (expected >= T.relaxedMinNotes && notesHeard >= expected - 1 && silent >= rule.silenceSec * T.relaxedSilenceFactor) reason = 'auto-silence';
          break;
        }
        case 'sustain':
          if (soundStarted && !loud && silentFor() >= rule.silenceSec) reason = 'auto-silence';
          break;
        case 'manual':
          break;
      }
      if (!reason && t >= capSec) reason = 'cap';
      if (reason) stopped = reason;
      return reason;
    },
    get notesHeard() {
      return notesHeard;
    },
    get soundStarted() {
      return soundStarted;
    },
    get heldSec() {
      return heldSec;
    },
    get silentSec() {
      return silentFor();
    },
    get floorDb() {
      return floor.floorDb;
    },
    get silenceDb() {
      return floor.silenceDb;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The SPEC's rule for each exercise, so screens do not repeat the numbers.

export const AUTO_STOP_RULES = Object.freeze({
  /** Pitch test: stop once a steady note has been held 1.5 s, or at 5 s. */
  pitchTest: (): AutoStopRule => ({ kind: 'held-note', holdSec: 1.5, steadyCents: 50, capSec: 5 }),
  /**
   * Match the note: the lock tracker (score) ends it on a lock; otherwise 1.5 s of silence once a sung note has been
   * heard (the singer stopped without locking in), the button, or 20 s.
   */
  match: (): AutoStopRule => ({ kind: 'notes', expectedNotes: 1, silenceSec: 1.5, capSec: 20 }),
  /** Sing an interval: two notes, then 1.2 s of silence, or 8 s. */
  interval: (): AutoStopRule => ({ kind: 'notes', expectedNotes: 2, silenceSec: 1.2, capSec: 8 }),
  /**
   * A scale-degree line of n notes: n notes, then 1.2 s of silence, or min(45, 4 + 3 n) s. The copy says "at your own
   * pace", so the cap leaves room for a slow, careful singer (3 s a note); the screen shows the time left.
   */
  sequence: (n: number): AutoStopRule => ({ kind: 'notes', expectedNotes: Math.max(1, Math.round(n)), silenceSec: 1.2, capSec: Math.min(45, 4 + 3 * Math.max(1, Math.round(n))) }),
  /** Hiss test: 0.8 s of silence after the hiss, or 90 s. */
  hiss: (): AutoStopRule => ({ kind: 'sustain', silenceSec: 0.8, capSec: 90 }),
  /** Long tone: 0.8 s of silence after the tone, or 60 s. */
  longTone: (): AutoStopRule => ({ kind: 'sustain', silenceSec: 0.8, capSec: 60 }),
});
