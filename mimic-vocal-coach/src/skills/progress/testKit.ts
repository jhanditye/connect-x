// Test helpers for the Skills progress store: an in-memory Storage and small session builders. Not used by the app.

import type {
  BreathSession,
  Degree,
  EarSession,
  IntervalDirection,
  MatchSession,
  PitchTestSession,
  RegisterThird,
  ScaleMode,
  SequenceSession,
  SingIntervalsSession,
  SungDirection,
  WorkoutSession,
} from '../types';

/** Minimal in-memory Storage; `failWrites` / `failAll` / `maxChars` simulate quota errors and blocked storage. */
export class FakeStorage implements Storage {
  data = new Map<string, string>();
  failWrites = false;
  failAll = false;
  /** Writes whose value is longer than this throw a quota error. */
  maxChars = Infinity;
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(k: string): string | null {
    if (this.failAll) throw new DOMException('blocked', 'SecurityError');
    return this.data.has(k) ? (this.data.get(k) as string) : null;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    if (this.failAll) throw new DOMException('blocked', 'SecurityError');
    this.data.delete(k);
  }
  setItem(k: string, v: string): void {
    if (this.failAll) throw new DOMException('blocked', 'SecurityError');
    if (this.failWrites || String(v).length > this.maxChars) throw new DOMException('full', 'QuotaExceededError');
    this.data.set(k, String(v));
  }
}

let counter = 0;
/** ISO time `minutes` after 2026-10-01 09:00 local time. */
export function at(minutes: number): string {
  return new Date(2026, 9, 1, 9, minutes).toISOString();
}

function base(id: string | undefined, minutes: number) {
  return { id: id ?? `t${++counter}`, at: at(minutes), durationSec: 60, strictness: 'standard' as const, voiceType: 'baritone' as const, a4Hz: 440 };
}

export function earSession(
  answers: { semitones: number; direction?: IntervalDirection; correct: boolean }[],
  minutes = 0,
  id?: string,
): EarSession {
  const list = answers.map((a, i) => ({
    questionId: `q${i}`,
    kind: 'interval' as const,
    correctValue: a.semitones,
    chosenValue: a.correct ? a.semitones : (a.semitones + 1) % 13,
    correct: a.correct,
    direction: a.direction ?? 'up',
    mode: null,
    replays: 0,
    responseMs: 1500,
  }));
  return { ...base(id, minutes), kind: 'ear', mode: 'interval', answers: list, correct: list.filter((a) => a.correct).length, total: list.length };
}

export function degreeEarSession(answers: { degree: Degree; mode?: ScaleMode; correct: boolean }[], minutes = 0, id?: string): EarSession {
  const list = answers.map((a, i) => ({
    questionId: `d${i}`,
    kind: 'degree' as const,
    correctValue: a.degree,
    chosenValue: a.correct ? a.degree : a.degree === 7 ? 1 : a.degree + 1,
    correct: a.correct,
    direction: null,
    mode: a.mode ?? 'major',
    replays: 1,
    responseMs: 2000,
  }));
  return { ...base(id, minutes), kind: 'ear', mode: 'degree', answers: list, correct: list.filter((a) => a.correct).length, total: list.length };
}

export function singSession(items: { semitones: number; direction?: SungDirection; intervalCents: number | null }[], minutes = 0, id?: string): SingIntervalsSession {
  const list = items.map((i) => ({
    mode: 'read' as const,
    semitones: i.semitones,
    direction: i.direction ?? 'up',
    referenceMidi: 52,
    status: i.intervalCents === null ? ('too-quiet' as const) : ('ok' as const),
    referenceCents: i.intervalCents === null ? null : 3,
    intervalCents: i.intervalCents,
    targetCents: i.intervalCents,
  }));
  const scored = list.flatMap((i) => (i.intervalCents === null ? [] : [Math.abs(i.intervalCents)]));
  return { ...base(id, minutes), kind: 'sing-intervals', items: list, meanAbsIntervalCents: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null };
}

export function sequenceSession(perNote: { degree: Degree; cents: number }[], noteAccuracy: number, minutes = 0, id?: string, scaleMode: ScaleMode = 'major'): SequenceSession {
  const abs = perNote.map((p) => Math.abs(p.cents));
  return {
    ...base(id, minutes),
    kind: 'sequence',
    items: [
      {
        mode: 'read',
        text: perNote.map((p) => p.degree).join(' '),
        scaleMode,
        tonicMidi: 48,
        status: 'ok',
        noteAccuracy,
        meanAbsCents: abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null,
        meanAbsIntervalCents: 12,
        driftCents: -4,
        octaveOffset: 0,
        perNote,
        missing: 0,
        extras: 0,
      },
    ],
  };
}

export function pitchTestSession(notes: { register: RegisterThird; heldCents: number | null }[], minutes = 0, id?: string): PitchTestSession {
  const scored = notes.flatMap((n) => (n.heldCents === null ? [] : [n.heldCents]));
  const meanAbs = scored.length ? scored.reduce((a, b) => a + Math.abs(b), 0) / scored.length : null;
  const empty = { n: 0, meanAbsCents: null, biasCents: null, shareWithin: null };
  return {
    ...base(id, minutes),
    kind: 'pitch-test',
    notes: notes.map((n) => ({
      targetMidi: n.register === 'low' ? 47 : n.register === 'mid' ? 54 : 61,
      register: n.register,
      status: n.heldCents === null ? 'too-quiet' : 'ok',
      heldCents: n.heldCents,
      landingCents: n.heldCents,
      stabilityCents: 8,
      timeToLandSec: 0.4,
      octaveOffset: 0,
    })),
    summary: {
      scored: scored.length,
      unscored: notes.length - scored.length,
      meanAbsCents: meanAbs,
      shareWithin: scored.length ? scored.filter((c) => Math.abs(c) <= 25).length / scored.length : null,
      shareWithin50: scored.length ? scored.filter((c) => Math.abs(c) <= 50).length / scored.length : null,
      biasCents: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      meanStabilityCents: 8,
      meanTimeToLandSec: 0.4,
      octaveSlips: 0,
      byRegister: { low: empty, mid: empty, high: empty },
    },
  };
}

export function matchSession(attempts: { register: RegisterThird; heldCents: number | null; locked?: boolean }[], minutes = 0, id?: string): MatchSession {
  return {
    ...base(id, minutes),
    kind: 'match',
    drone: false,
    attempts: attempts.map((a) => ({ targetMidi: 54, register: a.register, locked: a.locked ?? a.heldCents !== null, lockSec: a.heldCents === null ? null : 1.8, heldCents: a.heldCents })),
  };
}

export function breathSession(parts: { hissSec?: number; longToneSec?: number; pacedRounds?: number; maxExhale?: number }, minutes = 0, id?: string): BreathSession {
  return {
    ...base(id, minutes),
    kind: 'breath',
    paced: parts.pacedRounds ? { rounds: parts.pacedRounds, maxExhaleCounts: parts.maxExhale ?? 10 } : null,
    hiss: parts.hissSec !== undefined ? { status: 'ok', durationSec: parts.hissSec, steadinessDb: 2.1 } : null,
    longTone: parts.longToneSec !== undefined ? { status: 'ok', durationSec: parts.longToneSec, midi: 52, pitchSdCents: 12, loudnessSdDb: 1.5 } : null,
  };
}

export function workoutSession(partIds: string[], minutes = 0, id?: string): WorkoutSession {
  return { ...base(id, minutes), kind: 'workout', partIds, completedSteps: partIds.length, totalSteps: 6 };
}
