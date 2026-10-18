import { describe, expect, it } from 'vitest';
import type { AutoStopRule, LiveReading, StopReason } from '../types';
import { AUTO_STOP_RULES, createAutoStop, createFloorTracker } from './autoStop';

const STEP = 0.03; // the capture loop reads the analyser about every 30 ms

type Frame = { midi: number | null; db: number };

/** Readings every STEP seconds from a function of time. */
function stream(durSec: number, at: (t: number) => Frame): LiveReading[] {
  const out: LiveReading[] = [];
  for (let t = 0; t <= durSec + 1e-9; t += STEP) {
    const f = at(t);
    out.push({ t, hz: f.midi === null ? null : 440 * 2 ** ((f.midi - 69) / 12), midi: f.midi, rmsDb: f.db, periodicity: f.midi === null ? 0 : 0.9 });
  }
  return out;
}

/** Runs a rule over readings; the time and reason of the stop (null if it never stopped) and the final counters. */
function run(rule: AutoStopRule, readings: LiveReading[]) {
  const a = createAutoStop(rule);
  let stop: { t: number; reason: StopReason } | null = null;
  for (const r of readings) {
    const reason = a.push(r);
    if (reason && !stop) stop = { t: r.t, reason };
  }
  return { stop, notesHeard: a.notesHeard, soundStarted: a.soundStarted, auto: a };
}

const ROOM: Frame = { midi: null, db: -70 };
const vib = (t: number, cents = 40, rate = 5.5) => (cents / 100) * Math.sin(2 * Math.PI * rate * t);

/** A sung line: notes of `durSec` with `gapSec` of silence between (or legato glides of `glideSec` when gap is 0). */
function line(midis: number[], o: { lead?: number; durSec?: number; gapSec?: number; glideSec?: number; tail?: number; db?: number } = {}) {
  const lead = o.lead ?? 0.4;
  const dur = o.durSec ?? 0.6;
  const gap = o.gapSec ?? 0.06;
  const glide = o.glideSec ?? 0;
  const db = o.db ?? -28;
  const starts = midis.map((_, i) => lead + i * (dur + gap));
  const end = starts[starts.length - 1] + dur;
  const at = (t: number): Frame => {
    for (let i = 0; i < midis.length; i++) {
      if (t >= starts[i] && t < starts[i] + dur) {
        const into = t - starts[i];
        let m = midis[i];
        if (i > 0 && gap === 0 && into < glide) m = midis[i - 1] + (midis[i] - midis[i - 1]) * (into / glide);
        return { midi: m + vib(t), db };
      }
    }
    return ROOM;
  };
  return { at, end, starts };
}

describe('held-note rule (pitch test)', () => {
  const rule = AUTO_STOP_RULES.pitchTest();

  it('stops about 1.5 s into a steady note with a wide vibrato', () => {
    const r = run(rule, stream(6, (t) => (t < 0.4 ? ROOM : { midi: 57 + vib(t), db: -30 })));
    expect(r.stop?.reason).toBe('auto-held');
    expect(r.stop!.t).toBeGreaterThanOrEqual(0.4 + 1.5);
    expect(r.stop!.t).toBeLessThanOrEqual(0.4 + 1.5 + 0.15);
  });

  it('starts counting after a scoop into the note', () => {
    // 150 cents below, rising over 120 ms.
    const r = run(rule, stream(6, (t) => (t < 0.4 ? ROOM : { midi: 57 - 1.5 * Math.max(0, 1 - (t - 0.4) / 0.12) + vib(t), db: -30 })));
    expect(r.stop?.reason).toBe('auto-held');
    expect(r.stop!.t).toBeGreaterThanOrEqual(0.4 + 1.5);
    expect(r.stop!.t).toBeLessThanOrEqual(0.4 + 0.12 + 1.5 + 0.3);
  });

  it('bridges a short breathy dropout', () => {
    const r = run(rule, stream(6, (t) => (t < 0.4 || (t > 1.2 && t < 1.27) ? ROOM : { midi: 57 + vib(t), db: -30 })));
    expect(r.stop?.reason).toBe('auto-held');
    expect(r.stop!.t).toBeLessThanOrEqual(0.4 + 1.5 + 0.15);
  });

  it('restarts after a real move to another note', () => {
    const r = run(rule, stream(6, (t) => (t < 0.4 ? ROOM : { midi: (t < 1.4 ? 57 : 59) + vib(t), db: -30 })));
    expect(r.stop?.reason).toBe('auto-held');
    expect(r.stop!.t).toBeGreaterThanOrEqual(1.4 + 1.5);
  });

  it('a pitch that keeps sliding never counts as held: the cap ends it', () => {
    const r = run(rule, stream(6, (t) => (t < 0.4 ? ROOM : { midi: 55 + (t - 0.4) * 1.2, db: -30 })));
    expect(r.stop?.reason).toBe('cap');
    expect(r.stop!.t).toBeCloseTo(5, 1);
  });

  it('silence only: the cap, and no sound heard', () => {
    const r = run(rule, stream(6, () => ROOM));
    expect(r.stop).toEqual({ t: expect.closeTo(5, 1), reason: 'cap' });
    expect(r.soundStarted).toBe(false);
    expect(r.notesHeard).toBe(0);
  });

  it('reports held progress and keeps returning the reason once stopped', () => {
    const a = createAutoStop(rule);
    let progress = 0;
    let reason: StopReason | null = null;
    for (const r of stream(3, (t) => (t < 0.4 ? ROOM : { midi: 57 + vib(t), db: -30 }))) {
      reason = a.push(r);
      if (!reason) progress = Math.max(progress, a.heldSec);
      else break;
    }
    expect(progress).toBeGreaterThan(1.3);
    expect(progress).toBeLessThan(1.5);
    expect(a.push({ t: 10, hz: null, midi: null, rmsDb: -90, periodicity: 0 })).toBe(reason);
  });
});

describe('notes rule (intervals and lines)', () => {
  // "7 6 5 4 3 2" in C major.
  const LINE = [71, 69, 67, 65, 64, 62];
  const rule = AUTO_STOP_RULES.sequence(LINE.length);

  it('counts six detached notes and stops 1.2 s after the last', () => {
    const l = line(LINE);
    const r = run(rule, stream(l.end + 4, l.at));
    expect(r.notesHeard).toBe(6);
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop!.t).toBeGreaterThanOrEqual(l.end + 1.2 - STEP);
    expect(r.stop!.t).toBeLessThanOrEqual(l.end + 1.2 + 0.1);
  });

  it('legato glides between notes add no extra notes', () => {
    const l = line(LINE, { gapSec: 0, glideSec: 0.08 });
    const r = run({ ...rule, capSec: 30 }, stream(l.end + 4, l.at));
    expect(r.notesHeard).toBe(6);
    expect(r.stop?.reason).toBe('auto-silence');
  });

  it('fast notes (0.35 s) with vibrato are each counted once', () => {
    const l = line(LINE, { durSec: 0.35, gapSec: 0.09 });
    expect(run(rule, stream(l.end + 3, l.at)).notesHeard).toBe(6);
  });

  it('a breath pause in the middle does not end the line', () => {
    const first = line(LINE.slice(0, 3));
    const restStart = first.end + 1.6;
    const rest = line(LINE.slice(3), { lead: restStart });
    const r = run(rule, stream(rest.end + 3, (t) => (t < first.end + 0.01 ? first.at(t) : rest.at(t))));
    expect(r.notesHeard).toBe(6);
    expect(r.stop!.t).toBeGreaterThan(rest.end);
    expect(r.stop?.reason).toBe('auto-silence');
  });

  it('one note short: twice the silence ends a line of four or more', () => {
    const l = line(LINE.slice(0, 5));
    const r = run(rule, stream(l.end + 5, l.at));
    expect(r.notesHeard).toBe(5);
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop!.t).toBeGreaterThanOrEqual(l.end + 2.4 - STEP);
    expect(r.stop!.t).toBeLessThanOrEqual(l.end + 2.4 + 0.1);
  });

  it('an interval waits through a long pause between its two notes', () => {
    const rule2 = AUTO_STOP_RULES.interval();
    const a = line([60]);
    const b = line([69], { lead: a.end + 2.5 });
    const r = run(rule2, stream(b.end + 3, (t) => (t < a.end + 0.01 ? a.at(t) : b.at(t))));
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop!.t).toBeGreaterThan(b.end + 1.1);
    expect(r.notesHeard).toBe(2);
  });

  it('room noise and unvoiced breaths never count as notes; the cap ends it', () => {
    const r = run(rule, stream(rule.capSec + 1, (t) => ({ midi: null, db: t % 2 < 0.5 ? -40 : -70 })));
    expect(r.notesHeard).toBe(0);
    expect(r.stop?.reason).toBe('cap');
    expect(r.stop!.t).toBeCloseTo(rule.capSec, 1);
  });

  it('caps a line at min(45, 4 + 3 n) seconds (room for a slow, careful singer)', () => {
    expect(AUTO_STOP_RULES.sequence(6)).toEqual({ kind: 'notes', expectedNotes: 6, silenceSec: 1.2, capSec: 22 });
    expect(AUTO_STOP_RULES.sequence(4).capSec).toBe(16);
    expect(AUTO_STOP_RULES.sequence(16).capSec).toBe(45);
    expect(AUTO_STOP_RULES.sequence(40).capSec).toBe(45);
  });
});

describe('sustain rule (hiss and long tone)', () => {
  const hiss = AUTO_STOP_RULES.hiss();

  it('stops 0.8 s after a hiss ends, in a quiet room', () => {
    const r = run(hiss, stream(6, (t) => (t >= 0.6 && t < 3.6 ? { midi: null, db: -35 + 1.5 * Math.sin(t * 7) } : { midi: null, db: -65 })));
    expect(r.soundStarted).toBe(true);
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop!.t).toBeGreaterThanOrEqual(3.6 + 0.8 - STEP);
    expect(r.stop!.t).toBeLessThanOrEqual(3.6 + 0.8 + 0.1);
  });

  it('works in a noisy room (floor -46 dBFS)', () => {
    const r = run(hiss, stream(6, (t) => (t >= 0.6 && t < 3.6 ? { midi: null, db: -30 } : { midi: null, db: -46 })));
    expect(r.auto.floorDb).toBeCloseTo(-46, 0);
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop!.t).toBeLessThanOrEqual(3.6 + 0.8 + 0.1);
  });

  it('works when the hiss starts at once (no quiet half second)', () => {
    const r = run(hiss, stream(6, (t) => (t < 3 ? { midi: null, db: -35 } : { midi: null, db: -68 })));
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop!.t).toBeLessThanOrEqual(3 + 0.8 + 0.1);
  });

  it('short dips inside the sound do not end it', () => {
    const r = run(hiss, stream(8, (t) => (t >= 0.6 && t < 5 && !(t > 2 && t < 2.5) ? { midi: null, db: -38 } : { midi: null, db: -66 })));
    expect(r.stop!.t).toBeGreaterThan(5);
  });

  it('a long tone ends the same way', () => {
    const r = run(AUTO_STOP_RULES.longTone(), stream(12, (t) => (t >= 0.5 && t < 8.5 ? { midi: 60 + vib(t, 20), db: -26 } : ROOM)));
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop!.t).toBeGreaterThan(8.5 + 0.7);
    expect(r.stop!.t).toBeLessThan(8.5 + 0.95);
  });

  it('silence only: the cap', () => {
    const r = run({ kind: 'sustain', silenceSec: 0.8, capSec: 4 }, stream(6, () => ROOM));
    expect(r.stop?.reason).toBe('cap');
  });
});

describe('match the note', () => {
  it('ends about 1.5 s after the singer stops without locking in, instead of waiting for the 20 s cap', () => {
    const l = line([60]);
    const r = run(AUTO_STOP_RULES.match(), stream(25, l.at));
    expect(r.stop?.reason).toBe('auto-silence');
    expect(r.stop?.t as number).toBeLessThan(l.end + 2);
    expect(r.stop?.t as number).toBeGreaterThan(l.end + 1.3);
  });

  it('room noise alone never ends it early (only the cap)', () => {
    const r = run(AUTO_STOP_RULES.match(), stream(25, () => ROOM));
    expect(r.stop?.reason).toBe('cap');
  });
});

describe('manual rule and the floor', () => {
  it('only the cap ends a manual take, whatever is sung', () => {
    const l = line([60, 62]);
    const r = run({ kind: 'manual', capSec: 20 }, stream(25, l.at));
    expect(r.stop).toEqual({ t: expect.closeTo(20, 1), reason: 'cap' });
    expect(r.notesHeard).toBe(2);
  });

  it('floor: quiet room measured, loud start assumed quiet, silence line never above room + 6', () => {
    const quiet = createFloorTracker();
    for (let t = 0; t < 1; t += STEP) quiet.push(t, -72);
    expect(quiet.floorDb).toBeCloseTo(-72);
    expect(quiet.silenceDb).toBe(-55);
    const loud = createFloorTracker();
    for (let t = 0; t < 1; t += STEP) loud.push(t, -30);
    expect(loud.floorDb).toBe(-60);
    for (let t = 1; t < 2; t += STEP) loud.push(t, -66);
    expect(loud.floorDb).toBeCloseTo(-66);
    const noisy = createFloorTracker();
    for (let t = 0; t < 1; t += STEP) noisy.push(t, -47);
    expect(noisy.silenceDb).toBeCloseTo(-41);
  });

  it('matches the SPEC rules', () => {
    expect(AUTO_STOP_RULES.pitchTest()).toEqual({ kind: 'held-note', holdSec: 1.5, steadyCents: 50, capSec: 5 });
    expect(AUTO_STOP_RULES.match()).toEqual({ kind: 'notes', expectedNotes: 1, silenceSec: 1.5, capSec: 20 });
    expect(AUTO_STOP_RULES.interval()).toEqual({ kind: 'notes', expectedNotes: 2, silenceSec: 1.2, capSec: 8 });
    expect(AUTO_STOP_RULES.hiss()).toEqual({ kind: 'sustain', silenceSec: 0.8, capSec: 90 });
    expect(AUTO_STOP_RULES.longTone()).toEqual({ kind: 'sustain', silenceSec: 0.8, capSec: 60 });
  });
});
