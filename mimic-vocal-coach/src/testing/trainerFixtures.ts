// Fakes for the Clip Trainer screens and their tests: canned PhraseComparison results from the design scenarios, a
// 12-phrase clip with attempt history, a scripted FakeTrainerEngine and a FakeTrainerController. Everything is built in
// code (no audio files, no analysis run, no timers) so screens can be developed and tested before the real modules land.
// Numbers are illustrative; they follow the scenario tables in the scoring and trainer design notes, not new measurements.

import type { RouteInfo } from '../audio/duplex';
import { midiToNoteName } from '../dsp/music';
import { UNKNOWN_STORAGE } from '../storage/quota';
import type { TrainerController } from '../state/trainerContext';
import type { PracticeEngine, PracticeOptions, PracticeResult, PracticeSnapshot, PracticeState } from '../trainer/engine';
import { buildFixes } from '../trainer/feedback';
import type { CommitEdits, PreparedClip } from '../trainer/import';
import type { SegPhrase } from '../trainer/segment';
import { afterAttempt, practiceQueue, type AttemptLite } from '../trainer/srs';
import type {
  AttemptNoteSummary,
  AttemptRecord,
  AttemptScore,
  ClipRecord,
  Fix,
  FrameFeatures,
  NoteCompare,
  NoteFlag,
  NoteScore,
  NoteSegment,
  PhraseComparison,
  PhraseRecord,
  PhraseStats,
  PlayMode,
  ScoreComponent,
  SingerProfile,
  ToneFinding,
  VoiceAnalysis,
} from '../types';
import { FAKE_STYLE, makeFakeAnalysis, makeFakeProfile, makeFakeReferenceComparison } from './fixtures';

// ---------------------------------------------------------------------------------------------
// The reference phrase: an 8-note line, G3 B3 D4 E4 D4 C4 A3 G3 (6.1 s, 0.15 s of room tone before the first note)

interface PhraseNote {
  midi: number;
  start: number;
  end: number;
}

const LINE: { midi: number; dur: number }[] = [
  { midi: 55, dur: 0.7 },
  { midi: 59, dur: 0.5 },
  { midi: 62, dur: 0.6 },
  { midi: 64, dur: 1.2 },
  { midi: 62, dur: 0.5 },
  { midi: 60, dur: 0.6 },
  { midi: 57, dur: 0.7 },
  { midi: 55, dur: 1.3 },
];
const LEAD_SEC = 0.15;
const TAIL_SEC = 0.2;

export const FAKE_PHRASE_NOTES: readonly PhraseNote[] = (() => {
  let t = LEAD_SEC;
  return LINE.map((n) => {
    const note = { midi: n.midi, start: t, end: t + n.dur };
    t += n.dur;
    return note;
  });
})();

/** Length of the fake phrase window in seconds (6.45). */
export const FAKE_PHRASE_SEC = FAKE_PHRASE_NOTES[FAKE_PHRASE_NOTES.length - 1].end + TAIL_SEC;

/** A VoiceAnalysis of the 8-note line (frames, notes, one phrase), as the reference side of a practice screen. */
export function makeFakePhraseAnalysis(): VoiceAnalysis {
  const base = makeFakeAnalysis();
  const hop = base.hopSec;
  const frames: FrameFeatures[] = [];
  const total = Math.round(FAKE_PHRASE_SEC / hop);
  for (let i = 0; i < total; i++) {
    const t = i * hop;
    const note = FAKE_PHRASE_NOTES.find((n) => t >= n.start + 0.04 && t < n.end - 0.04);
    const held = note !== undefined && note.end - note.start >= 0.6 && t - note.start > 0.3;
    const midi = note ? note.midi + (held ? 0.4 * Math.sin(2 * Math.PI * 5.5 * t) : 0) : NaN;
    frames.push({
      t,
      f0: note ? 440 * Math.pow(2, (midi - 69) / 12) : NaN,
      midi,
      voiced: note !== undefined,
      periodicity: note ? 0.93 : 0.2,
      rmsDb: note ? -24 : -62,
      h1h2Db: note ? 4 : NaN,
      alphaRatioDb: note ? -14 : NaN,
      centroidHz: note ? 1400 : NaN,
      tiltDbPerOct: note ? -12 : NaN,
      cppDb: note ? 17 : NaN,
      hnrDb: note ? 18 : NaN,
      register: note ? 'chest' : null,
    });
  }
  const notes: NoteSegment[] = FAKE_PHRASE_NOTES.map((n) => ({
    start: n.start,
    end: n.end,
    midi: n.midi,
    nearestMidi: n.midi,
    centsOff: 0,
    vibrato: n.end - n.start >= 1 ? { rateHz: 5.5, extentCents: 45 } : null,
    register: 'chest',
    meanRmsDb: -24,
  }));
  const voicedSec = frames.filter((f) => f.voiced).length * hop;
  return {
    ...base,
    durationSec: FAKE_PHRASE_SEC,
    frames,
    voicedRatio: voicedSec / FAKE_PHRASE_SEC,
    voicedSec,
    pitch: { medianMidi: 60, lowMidi: 55, highMidi: 64, tessituraLowMidi: 57, tessituraHighMidi: 62, tuningOffsetCents: 0 },
    notes,
    phrases: [{ start: FAKE_PHRASE_NOTES[0].start, end: FAKE_PHRASE_NOTES[FAKE_PHRASE_NOTES.length - 1].end }],
    onsets: [{ t: FAKE_PHRASE_NOTES[0].start, type: 'balanced' }],
    style: { ...FAKE_STYLE },
  };
}

// ---------------------------------------------------------------------------------------------
// Canned comparisons

export type ComparisonScenario = 'perfect' | 'flat' | 'late' | 'wrong-note' | 'partial' | 'no-match';
export const COMPARISON_SCENARIOS: readonly ComparisonScenario[] = ['perfect', 'flat', 'late', 'wrong-note', 'partial', 'no-match'];

interface NoteSpec {
  /** Absent or false: the note was not sung. */
  sung?: boolean;
  cents?: number;
  onsetMs?: number;
  durMs?: number;
  /** MIDI of the note the singer actually held, when it is not the right one. */
  userMidi?: number;
  flags?: NoteFlag[];
}

interface ScenarioSpec {
  notes: NoteSpec[];
  overall: number;
  pitch: number;
  timing: number | null;
  tone: number | null;
  expression: number | null;
  coverage: number;
  status: AttemptScore['status'];
  trust: AttemptScore['trust'];
  fixes: Fix[];
  lines: string[];
  toneFindings: ToneFinding[];
  tempoRatio: number;
  bias: number;
}

const sung = (over: NoteSpec = {}): NoteSpec => ({ sung: true, ...over });
/** Eight notes sung well: a few cents and milliseconds of natural scatter. */
const OK_NOTES = (): NoteSpec[] => [
  sung({ cents: 3, onsetMs: -8, durMs: 20 }),
  sung({ cents: -4, onsetMs: 6, durMs: -25 }),
  sung({ cents: 2, onsetMs: 12, durMs: 10 }),
  sung({ cents: -3, onsetMs: -5, durMs: 30 }),
  sung({ cents: 4, onsetMs: 9, durMs: -15 }),
  sung({ cents: -2, onsetMs: -10, durMs: 5 }),
  sung({ cents: 3, onsetMs: 4, durMs: -20 }),
  sung({ cents: 1, onsetMs: 7, durMs: 25 }),
];

const SCENARIOS: Record<ComparisonScenario, () => ScenarioSpec> = {
  perfect: () => ({
    notes: OK_NOTES(),
    overall: 99,
    pitch: 100,
    timing: 100,
    tone: 100,
    expression: 99,
    coverage: 1,
    status: 'ok',
    trust: { level: 'ok', reasons: [] },
    fixes: [],
    lines: ['Very close to the original. Nothing stood out to fix.'],
    toneFindings: [],
    tempoRatio: 1,
    bias: 2,
  }),
  // Two notes under the pitch (about 40 cents), a little airier than the original, no vibrato on the long notes.
  flat: () => {
    const notes = OK_NOTES();
    notes[2] = sung({ cents: -38, onsetMs: 10, durMs: 10, flags: ['flat'] });
    notes[3] = sung({ cents: -46, onsetMs: -4, durMs: 30, flags: ['flat'] });
    return {
      notes,
      overall: 91,
      pitch: 84,
      timing: 100,
      tone: 90,
      expression: 88,
      coverage: 1,
      status: 'ok',
      trust: { level: 'ok', reasons: [] },
      fixes: [
        { id: 'pitch.flat', skill: 'pitch', title: 'Lift the flat notes', advice: 'Think the note slightly higher before you sing it and keep the breath steady to the end.', gainPoints: 4.1, notes: [2, 3] },
        { id: 'expr.vibrato', skill: 'expression', title: 'Add the vibrato', advice: 'Let the long notes settle, then add a gentle wobble.', gainPoints: 1.8, notes: [3] },
      ],
      lines: ['Two notes sat about 40 cents under the original.', 'Your tone was a little airier than the original.'],
      toneFindings: [
        { key: 'breathiness', diff: 0.14, strength: 1.4 },
        { key: 'vibratoPresence', diff: -1, strength: 2 },
      ],
      tempoRatio: 1,
      bias: -4,
    };
  },
  // Three entrances 130-180 ms behind the original once the sync offset is removed.
  late: () => {
    const notes = OK_NOTES();
    notes[3] = sung({ cents: 4, onsetMs: 165, durMs: -20, flags: ['late'] });
    notes[4] = sung({ cents: -2, onsetMs: 140, durMs: -30, flags: ['late'] });
    notes[5] = sung({ cents: 5, onsetMs: 180, durMs: 10, flags: ['late'] });
    return {
      notes,
      overall: 92,
      pitch: 100,
      timing: 72,
      tone: 100,
      expression: 98,
      coverage: 1,
      status: 'ok',
      trust: { level: 'ok', reasons: [] },
      fixes: [{ id: 'timing.late', skill: 'timing', title: 'Come in on time', advice: 'Breathe in during the note before so the next one starts the moment the original does.', gainPoints: 5.2, notes: [3, 4, 5] }],
      lines: ['Three notes came in about 150 ms behind the original.'],
      toneFindings: [],
      tempoRatio: 1,
      bias: 3,
    };
  },
  // The third note was sung a tone too high and ran on into the fourth (same pitch), which is then judged merged.
  'wrong-note': () => {
    const notes = OK_NOTES();
    notes[2] = sung({ cents: 204, userMidi: 64, flags: ['wrong-note'] });
    notes[3] = { ...sung({ cents: 3 }), onsetMs: undefined, durMs: undefined, flags: ['merged'] };
    return {
      notes,
      overall: 95,
      pitch: 93,
      timing: 93,
      tone: 99,
      expression: 97,
      coverage: 1,
      status: 'ok',
      trust: { level: 'ok', reasons: [] },
      fixes: [{ id: 'pitch.wrong-notes', skill: 'pitch', title: 'Check the note on D4', advice: 'Play the phrase at 75 %, hum just that note first, then sing it on the vowel.', gainPoints: 2.9, notes: [2] }],
      lines: ['On D4 you sang E4 (about 200 cents higher).'],
      toneFindings: [],
      tempoRatio: 1,
      bias: 0,
    };
  },
  // Only the first four notes were sung.
  partial: () => {
    const notes: NoteSpec[] = OK_NOTES().map((n, i) => (i < 4 ? n : { sung: false }));
    return {
      notes,
      overall: 57,
      pitch: 98,
      timing: 98,
      tone: 100,
      expression: 98,
      coverage: 0.52,
      status: 'ok',
      trust: { level: 'caution', reasons: ['Only 52% of the reference phrase was matched.'] },
      fixes: [{ id: 'coverage', skill: 'pitch', title: 'Sing the whole phrase', advice: 'Only 52% of the reference was sung. Listen to the full phrase and sing it from first note to last.', gainPoints: 41, notes: [4, 5, 6, 7] }],
      lines: ['You covered 52% of the reference phrase.'],
      toneFindings: [],
      tempoRatio: 1,
      bias: 1,
    };
  },
  // A different melody altogether.
  'no-match': () => ({
    notes: OK_NOTES().map(() => ({ sung: false })),
    overall: 20,
    pitch: 0,
    timing: null,
    tone: null,
    expression: null,
    coverage: 0.08,
    status: 'no-match',
    trust: { level: 'caution', reasons: ['Only 8% of the reference phrase was matched.'] },
    fixes: [],
    lines: ['This does not line up with the reference phrase (the notes and timing are too different). Check you are singing the right phrase, then try again.'],
    toneFindings: [],
    tempoRatio: 1,
    bias: 0,
  }),
};

const pitchBell = (cents: number): number => 100 * Math.exp(-0.5 * (Math.max(0, Math.abs(cents) - 10) / 30) ** 2);

function noteRows(spec: ScenarioSpec, shift: number): { rows: NoteCompare[]; scored: NoteScore[] } {
  const rows: NoteCompare[] = [];
  const scored: NoteScore[] = [];
  FAKE_PHRASE_NOTES.forEach((n, k) => {
    const s = spec.notes[k] ?? { sung: false };
    const refName = midiToNoteName(n.midi + shift);
    const matched = s.sung === true;
    const userName = matched ? midiToNoteName((s.userMidi ?? n.midi) + shift) : null;
    const flags: NoteFlag[] = !matched ? ['missed'] : s.flags && s.flags.length > 0 ? [...s.flags] : ['ok'];
    const refDurMs = (n.end - n.start) * 1000;
    rows.push({
      refIndex: k,
      refStart: n.start,
      refEnd: n.end,
      refName,
      matched,
      userName,
      cents: matched ? (s.cents ?? 0) : null,
      onsetMs: matched && s.onsetMs !== undefined ? s.onsetMs : null,
      durationDeltaMs: matched && s.durMs !== undefined ? s.durMs : null,
      refVibrato: n.end - n.start >= 1,
      userVibrato: matched ? n.end - n.start >= 1 && !spec.toneFindings.some((t) => t.key === 'vibratoPresence') : null,
      levelDeltaDb: matched ? 0 : null,
      refRegister: 'chest',
      userRegister: matched ? 'chest' : null,
      vibratoStartDeltaSec: null,
      flags,
    });
    scored.push({
      refIndex: k,
      refStart: n.start,
      refEnd: n.end,
      refName,
      matched,
      userIndex: matched ? k : null,
      userName,
      cents: matched ? (s.cents ?? 0) : null,
      semitones: matched ? ((s.userMidi ?? n.midi) - n.midi) + (s.cents ?? 0) / 100 : null,
      pitchScore: matched ? Math.round(pitchBell(s.cents ?? 0)) : null,
      onsetMs: matched && s.onsetMs !== undefined ? s.onsetMs : null,
      onsetScore: matched && s.onsetMs !== undefined ? Math.round(100 * Math.exp(-0.5 * (Math.max(0, Math.abs(s.onsetMs) - 30) / 55) ** 2)) : null,
      durRatio: matched && s.durMs !== undefined ? (refDurMs + s.durMs) / refDurMs : null,
      durScore: matched && s.durMs !== undefined ? 100 : null,
      levelDeltaDb: matched ? 0 : null,
      refVibrato: n.end - n.start >= 1,
      userVibrato: null,
      contourScore: matched ? Math.round(pitchBell(s.cents ?? 0)) : null,
      ornament: false,
      flags,
    });
  });
  return { rows, scored };
}

/**
 * A canned PhraseComparison for one design scenario. `shift` is the key the singer used relative to the original
 * (semitones; note names are in the singer's key). `mode` 'sing-along' reports a sync offset of 160 ms, 'turn-taking' none.
 */
export function makeFakePhraseComparison(scenario: ComparisonScenario, opts: { shift?: number; mode?: PlayMode } = {}): PhraseComparison {
  const shift = opts.shift ?? 0;
  const mode = opts.mode ?? 'sing-along';
  const spec = SCENARIOS[scenario]();
  const sync = mode === 'sing-along' ? 160 : null;
  const { rows, scored } = noteRows(spec, shift);
  const skills = { pitch: spec.status === 'no-match' ? 0 : spec.pitch, timing: spec.timing, tone: spec.tone, expression: spec.expression };
  const weights = { pitch: 0.4, timing: 0.25, tone: 0.2, expression: 0.15 };
  const measured = (Object.keys(weights) as (keyof typeof weights)[]).filter((k) => skills[k] !== null);
  const wSum = measured.reduce((a, k) => a + weights[k], 0);
  const effective = { pitch: 0, timing: 0, tone: 0, expression: 0 };
  for (const k of measured) effective[k] = weights[k] / wSum;
  const components: ScoreComponent[] = measured.map((k) => ({ id: `${k}.overall`, skill: k, label: k[0].toUpperCase() + k.slice(1), score: skills[k], weight: 1 }));
  const score: AttemptScore = {
    status: spec.status,
    overall: spec.overall,
    overallOnSung: spec.status === 'no-match' ? 20 : Math.min(100, Math.round(spec.overall / Math.min(1, spec.coverage / 0.9))),
    skills,
    weights: effective,
    components,
    coverage: spec.coverage,
    completeness: Math.min(1, spec.coverage / 0.9),
    kind: 'sung',
    transposeSemitones: shift,
    keyOffsetCents: spec.bias,
    timing: { lagMs: sync, tempoRatio: spec.tempoRatio, onsetMadMs: spec.timing === null ? null : 18 },
    matchedSpan: spec.coverage > 0.1 ? { start: 0.4, end: 0.4 + FAKE_PHRASE_SEC * spec.coverage } : null,
    perNote: scored,
    notes: spec.lines,
    fixes: spec.fixes,
    trust: spec.trust,
    diagnostics: { refNotes: 8, matchedNotes: rows.filter((r) => r.matched).length, mode, noMatchWhy: null, roughGuide: false, refLowConfidence: false },
  };
  return {
    transposeSemitones: shift,
    biasCents: spec.bias,
    syncOffsetMs: sync,
    syncConfidence: sync === null ? 'none' : 'high',
    tempoRatio: spec.tempoRatio,
    notes: rows,
    extraNotes: 0,
    coverage: spec.coverage,
    withinFifty: spec.status === 'no-match' ? 0.1 : spec.coverage * (scenario === 'flat' ? 0.8 : 1),
    tone: spec.toneFindings,
    score,
    scores: { overall: spec.overall, pitch: skills.pitch, timing: skills.timing, tone: skills.tone, expression: skills.expression },
    base: { ...makeFakeReferenceComparison(), transposeSemitones: shift },
    bleedSuspect: false,
  };
}

// ---------------------------------------------------------------------------------------------
// A 12-phrase clip with attempt history

export const FAKE_CLIP_ID = 'fake-clip';
const PHRASE_STRIDE_SEC = 7;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** Reference "now" for the fake history (the day the design notes were written). */
export const FAKE_NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function phraseId(clipId: string, index: number): string {
  return `${clipId}-p${index + 1}`;
}

function emptyStats(): PhraseStats {
  return { attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null };
}

/** Which scenario each fake attempt scored, newest last, per phrase index (see makeFakeAttempts for the resulting statuses). */
const HISTORY: Record<number, { scenario: ComparisonScenario; rate: number; daysAgo: number; overall?: number }[]> = {
  0: [{ scenario: 'flat', rate: 1, daysAgo: 9 }, { scenario: 'late', rate: 1, daysAgo: 8 }, { scenario: 'perfect', rate: 1, daysAgo: 7 }, { scenario: 'perfect', rate: 1, daysAgo: 6 }, { scenario: 'perfect', rate: 1, daysAgo: 5 }],
  1: [{ scenario: 'late', rate: 1, daysAgo: 6 }, { scenario: 'perfect', rate: 1, daysAgo: 5 }, { scenario: 'perfect', rate: 1, daysAgo: 4 }, { scenario: 'perfect', rate: 1, daysAgo: 3 }],
  2: [{ scenario: 'flat', rate: 0.75, daysAgo: 4 }, { scenario: 'perfect', rate: 1, daysAgo: 3 }, { scenario: 'perfect', rate: 1, daysAgo: 2 }, { scenario: 'perfect', rate: 1, daysAgo: 1 }],
  3: [{ scenario: 'wrong-note', rate: 1, daysAgo: 3 }, { scenario: 'perfect', rate: 1, daysAgo: 2 }, { scenario: 'perfect', rate: 1, daysAgo: 1 }, { scenario: 'perfect', rate: 1, daysAgo: 0 }],
  4: [{ scenario: 'flat', rate: 1, daysAgo: 2 }, { scenario: 'late', rate: 1, daysAgo: 1 }],
  5: [{ scenario: 'partial', rate: 1, daysAgo: 2 }, { scenario: 'flat', rate: 0.75, daysAgo: 1 }],
  6: [{ scenario: 'wrong-note', rate: 1, daysAgo: 1 }],
  7: [{ scenario: 'late', rate: 1, daysAgo: 1 }, { scenario: 'late', rate: 1, daysAgo: 0 }],
  8: [{ scenario: 'flat', rate: 1, daysAgo: 0 }],
  // Six full-speed tries that never got past 66: the "stuck" status.
  9: [52, 58, 61, 55, 66, 63].map((overall, n) => ({ scenario: 'flat' as const, rate: 1, daysAgo: 6 - n, overall })),
};

/** Builds the stored AttemptRecord for a comparison (what the real engine saves after a take). */
export function attemptFromComparison(c: PhraseComparison, base: { id: string; clipId: string; phraseId: string; at: number; rate?: number; mode?: PlayMode }): AttemptRecord {
  const notes: AttemptNoteSummary[] = c.notes.map((n) => ({
    i: n.refIndex,
    refName: n.refName,
    userName: n.userName,
    cents: n.cents === null ? null : Math.round(n.cents),
    onsetMs: n.onsetMs === null ? null : Math.round(n.onsetMs),
    durationDeltaMs: n.durationDeltaMs === null ? null : Math.round(n.durationDeltaMs),
    flags: n.flags,
  }));
  return {
    id: base.id,
    clipId: base.clipId,
    phraseId: base.phraseId,
    at: base.at,
    mode: base.mode ?? 'sing-along',
    keyMode: 'free',
    rate: base.rate ?? 1,
    transposeSemitones: c.transposeSemitones,
    scores: { overall: c.scores.overall, pitch: c.scores.pitch, timing: c.scores.timing, tone: c.scores.tone, expression: c.scores.expression },
    trust: c.score.trust.level,
    coverage: c.coverage,
    wrongNotes: c.notes.filter((n) => n.flags.includes('wrong-note')).length,
    syncOffsetMs: c.syncOffsetMs,
    tempoRatio: c.tempoRatio,
    route: 'wired',
    notes,
    style: { ...FAKE_STYLE },
    tone: c.tone.map((t) => ({ key: t.key, diff: t.diff })),
    fixIds: buildFixes(c, 'generic').map((f) => f.id),
    analysisVersion: 1,
    hasAudio: false,
  };
}

function liteOf(a: AttemptRecord): AttemptLite {
  return { at: a.at, overall: a.scores.overall, pitch: a.scores.pitch, timing: a.scores.timing, tone: a.scores.tone, rate: a.rate, coverage: a.coverage, wrongNotes: a.wrongNotes };
}

/** The attempt history of the fake clip, oldest first per phrase. Phrases 0-3 are mastered (three are due for review), 4-8 learning, 9 stuck, 10-11 new. */
export function makeFakeAttempts(clipId = FAKE_CLIP_ID, now = FAKE_NOW): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const [index, list] of Object.entries(HISTORY)) {
    list.forEach((h, n) => {
      const c = makeFakePhraseComparison(h.scenario, { shift: -12 });
      const a = attemptFromComparison(c, { id: `${phraseId(clipId, Number(index))}-a${n + 1}`, clipId, phraseId: phraseId(clipId, Number(index)), at: now - h.daysAgo * DAY - (6 - n) * MINUTE, rate: h.rate });
      out.push(h.overall === undefined ? a : { ...a, scores: { ...a.scores, overall: h.overall } });
    });
  }
  return out;
}

/** A clip of 12 phrases, a third of them mastered (three due for review), with stats and review state consistent with makeFakeAttempts. */
export function makeFakeClip(overrides: Partial<ClipRecord> = {}, now = FAKE_NOW): ClipRecord {
  const id = overrides.id ?? FAKE_CLIP_ID;
  const attempts = makeFakeAttempts(id, now);
  const phrases: PhraseRecord[] = Array.from({ length: 12 }, (_, i) => {
    const start = i * PHRASE_STRIDE_SEC;
    const pid = phraseId(id, i);
    const mine = attempts.filter((a) => a.phraseId === pid).sort((a, b) => a.at - b.at);
    let srs = { rung: 0, dueAt: null as number | null, masteredAt: null as number | null };
    const lite: AttemptLite[] = [];
    for (const a of mine) {
      lite.push(liteOf(a));
      srs = afterAttempt(srs, lite, a.at);
    }
    const stats: PhraseStats =
      mine.length === 0
        ? emptyStats()
        : {
            attempts: mine.length,
            fullSpeedAttempts: mine.filter((a) => a.rate >= 0.9 && a.coverage >= 0.9).length,
            best: Math.max(...mine.map((a) => a.scores.overall)),
            last: mine[mine.length - 1].scores.overall,
            recent: mine.slice(-5).map((a) => a.scores.overall),
            lastAt: mine[mine.length - 1].at,
          };
    return {
      id: pid,
      index: i,
      start,
      end: start + FAKE_PHRASE_SEC,
      voicedStart: start + LEAD_SEC,
      voicedEnd: start + FAKE_PHRASE_SEC - TAIL_SEC,
      source: 'auto',
      label: `Phrase ${i + 1}`,
      lyrics: '',
      hidden: false,
      summary: { durationSec: FAKE_PHRASE_SEC, voicedSec: 5.4, medianMidi: 60, lowMidi: 55, highMidi: 64, noteCount: 8, hasVibrato: true, style: { ...FAKE_STYLE } },
      keyHint: mine.length > 0 ? -12 : null,
      rate: 1,
      srs,
      stats,
    };
  });
  const durationSec = 12 * PHRASE_STRIDE_SEC;
  const sampleRate = 44100;
  return {
    schema: 1,
    id,
    title: 'Fake clip, 12 phrases',
    singerId: 'shawn-mendes',
    singerLabel: '',
    sourceFileName: 'fake-clip.m4a',
    sourceBytes: 3_400_000,
    fingerprint: '3400000:84000:0123456789abcdef',
    addedAt: new Date(now - 10 * DAY).toISOString(),
    updatedAt: new Date(now - DAY).toISOString(),
    durationSec,
    kind: 'solo',
    analysisKind: 'solo',
    audio: { mix: { kind: 'mix', sampleRate, frames: Math.round(durationSec * sampleRate), chunkFrames: 10 * sampleRate }, vocal: null },
    audioMissing: false,
    analysis: {
      analysisVersion: 1,
      voiceType: 'tenor',
      a4Hz: 440,
      durationSec,
      voicedSec: 12 * 5.4,
      style: { ...FAKE_STYLE },
      pitch: { medianMidi: 60, lowMidi: 55, highMidi: 64, tessituraLowMidi: 57, tessituraHighMidi: 62 },
      issues: [],
      usableAsTarget: true,
      unusableReason: null,
    },
    phrases,
    notes: '',
    tags: [],
    difficulty: 2,
    contributesToSinger: false,
    ownedConfirmedAt: new Date(now - 10 * DAY).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// FakeTrainerEngine: a PracticeEngine whose takes return scripted scenarios

export const FAKE_ROUTE: RouteInfo = {
  inputLabel: 'EarPods',
  inputs: [
    { id: 'default', label: 'EarPods' },
    { id: 'builtin', label: 'iPhone Microphone' },
  ],
  kind: 'wired',
  headphonesLikely: true,
  sampleRate: 48000,
};

export const DEFAULT_PRACTICE_OPTIONS: PracticeOptions = { rate: 1, guideShift: 0, mode: 'sing-along', countInBeats: 3, loop: null };

export interface FakeEngineOptions {
  clip?: ClipRecord;
  phrase?: PhraseRecord;
  /** Scenarios returned by successive takes; the last one repeats. Default: a flat take, then a perfect one. */
  script?: ComparisonScenario[];
  initialState?: PracticeState;
  options?: Partial<PracticeOptions>;
  route?: RouteInfo | null;
  /** Make every sing() end in this state instead of a result. */
  failSing?: { state: 'interrupted' | 'error'; message: string };
}

export function makeFakePracticeResult(scenario: ComparisonScenario, clip: ClipRecord, phrase: PhraseRecord, at = FAKE_NOW): PracticeResult {
  const comparison = makeFakePhraseComparison(scenario, { shift: -12 });
  const attempt = attemptFromComparison(comparison, { id: `${phrase.id}-live-${at}`, clipId: clip.id, phraseId: phrase.id, at });
  const invalid = comparison.score.trust.level === 'invalid';
  return {
    comparison,
    fixes: buildFixes(comparison, 'generic'),
    attempt,
    saved: !invalid,
    notice: invalid ? 'This sounds like the playback, not you. Use headphones and try again.' : null,
    keyMode: 'free',
  };
}

export class FakeTrainerEngine implements PracticeEngine {
  readonly clip: ClipRecord;
  readonly phrase: PhraseRecord;
  /** Every method call in order, e.g. 'sing', 'listen', 'playAttempt:both', 'setOptions', 'stop', 'dispose'. */
  readonly calls: string[] = [];
  private snapshot: PracticeSnapshot;
  private listeners = new Set<() => void>();
  private takes = 0;
  private positionSec = NaN;
  private readonly script: ComparisonScenario[];
  private readonly failSing?: FakeEngineOptions['failSing'];

  constructor(opts: FakeEngineOptions = {}) {
    this.clip = opts.clip ?? makeFakeClip();
    this.phrase = opts.phrase ?? this.clip.phrases[0];
    this.script = opts.script && opts.script.length > 0 ? opts.script : ['flat', 'perfect'];
    this.failSing = opts.failSing;
    this.snapshot = {
      state: opts.initialState ?? 'idle',
      message: null,
      route: opts.route === undefined ? FAKE_ROUTE : opts.route,
      options: { ...DEFAULT_PRACTICE_OPTIONS, ...opts.options },
      countIn: null,
      liveMidi: null,
      level: 0,
      reference: opts.initialState === 'preparing' ? null : makeFakePhraseAnalysis(),
      result: null,
    };
  }

  getSnapshot(): PracticeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  position(): number {
    return this.positionSec;
  }

  /** Test hook: put the engine in any state (for example 'error' with a message, or 'result' with a scenario). */
  force(patch: Partial<PracticeSnapshot>): void {
    this.emit(patch);
  }

  /** Test hook: the playhead the screen reads. NaN = stopped. */
  setPosition(sec: number): void {
    this.positionSec = sec;
  }

  setOptions(patch: Partial<PracticeOptions>): void {
    this.calls.push('setOptions');
    this.emit({ options: { ...this.snapshot.options, ...patch } });
  }

  async listen(): Promise<void> {
    this.calls.push('listen');
    if (this.closed()) return;
    this.positionSec = 0;
    this.emit({ state: 'listening', message: null });
    await Promise.resolve();
    // The fake guide "finishes" immediately; a test that needs the listening state calls force().
    this.positionSec = NaN;
    this.emit({ state: this.snapshot.result ? 'result' : 'idle' });
  }

  async sing(): Promise<void> {
    this.calls.push('sing');
    if (this.closed()) return;
    const beats = this.snapshot.options.countInBeats;
    for (let b = beats; b >= 1; b--) {
      this.emit({ state: 'countin', countIn: b, message: null, result: null });
      await Promise.resolve();
    }
    this.emit({ state: 'singing', countIn: null, liveMidi: 55, level: 0.5 });
    await Promise.resolve();
    if (this.closed()) return;
    if (this.failSing) {
      this.emit({ state: this.failSing.state, message: this.failSing.message, liveMidi: null, level: 0 });
      return;
    }
    this.emit({ state: 'processing', liveMidi: null, level: 0 });
    await Promise.resolve();
    const scenario = this.script[Math.min(this.takes, this.script.length - 1)];
    this.takes++;
    this.emit({ state: 'result', result: makeFakePracticeResult(scenario, this.clip, this.phrase, FAKE_NOW + this.takes * MINUTE) });
  }

  stop(): void {
    this.calls.push('stop');
    this.positionSec = NaN;
    if (this.closed()) return;
    if (['listening', 'countin', 'singing', 'processing'].includes(this.snapshot.state)) {
      this.emit({ state: this.snapshot.result ? 'result' : 'idle', countIn: null, liveMidi: null, level: 0 });
    }
  }

  async playAttempt(which: 'original' | 'you' | 'both'): Promise<void> {
    this.calls.push(`playAttempt:${which}`);
    await Promise.resolve();
  }

  dispose(): void {
    this.calls.push('dispose');
    if (this.closed()) return;
    this.emit({ state: 'closed' });
    this.listeners.clear();
  }

  private closed(): boolean {
    return this.snapshot.state === 'closed';
  }

  private emit(patch: Partial<PracticeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}

// ---------------------------------------------------------------------------------------------
// FakeTrainerController: in-memory library for screen tests

const SEG: SegPhrase[] = [0, 1, 2].map((i) => ({ start: i * 7, end: i * 7 + FAKE_PHRASE_SEC, voicedStart: i * 7 + LEAD_SEC, voicedEnd: i * 7 + FAKE_PHRASE_SEC - TAIL_SEC, fragment: false }));

/** A prepared clip as the import review screen receives it (tiny audio, the fake phrase analysis, three phrases). */
export function makeFakePreparedClip(over: Partial<PreparedClip> = {}): PreparedClip {
  return {
    file: { name: 'new-clip.m4a', size: 2_000_000 },
    samples: new Float32Array(16),
    sampleRate: 44100,
    durationSec: 21,
    analysis: makeFakePhraseAnalysis(),
    suggestedKind: 'solo',
    warnings: [],
    blockers: [],
    phrases: SEG.map((p) => ({ ...p })),
    fingerprint: '2000000:21000:fedcba9876543210',
    notices: [],
    ...over,
  };
}

export interface FakeControllerOptions {
  clips?: ClipRecord[];
  status?: TrainerController['status'];
  error?: string | null;
  singers?: SingerProfile[];
  attempts?: AttemptRecord[];
  engine?: FakeEngineOptions;
}

export interface FakeTrainerController extends TrainerController {
  /** Method names in call order, for assertions. */
  readonly calls: string[];
  /** Engines handed out by openPractice. */
  readonly engines: FakeTrainerEngine[];
}

/** Implements the whole TrainerController over arrays; mutating calls change `clips` and `queue` like the real provider would. */
export function makeFakeTrainerController(opts: FakeControllerOptions = {}): FakeTrainerController {
  const calls: string[] = [];
  const engines: FakeTrainerEngine[] = [];
  let attempts = opts.attempts ?? makeFakeAttempts();
  const singers = opts.singers ?? [
    makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes', color: '#b97a12' }),
    makeFakeProfile({ id: 'daniel-caesar', name: 'Daniel Caesar', color: '#3a7556' }),
    makeFakeProfile({ id: 'jalen-ngonda', name: 'Jalen Ngonda', color: '#b23c49' }),
  ];
  const refreshQueue = (clips: ClipRecord[]): TrainerController['queue'] =>
    practiceQueue(
      clips.flatMap((c) =>
        c.phrases
          .filter((p) => !p.hidden)
          .map((p) => ({ id: p.id, srs: p.srs, attempts: attempts.filter((a) => a.phraseId === p.id).sort((a, b) => a.at - b.at).map(liteOf) })),
      ),
      FAKE_NOW,
      5,
    );
  const ctl: FakeTrainerController = {
    calls,
    engines,
    status: opts.status ?? 'ready',
    error: opts.error ?? null,
    clips: opts.clips ?? [makeFakeClip()],
    storage: { supported: true, usage: 124_000_000, quota: 6_000_000_000, persisted: false },
    singers,
    queue: [],
    getClip: (id) => ctl.clips.find((c) => c.id === id),
    async updateClip(id, patch) {
      calls.push('updateClip');
      ctl.clips = ctl.clips.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: new Date(FAKE_NOW).toISOString() } : c));
    },
    async updatePhrases(clipId, phrases) {
      calls.push('updatePhrases');
      ctl.clips = ctl.clips.map((c) => (c.id === clipId ? { ...c, phrases } : c));
      ctl.queue = refreshQueue(ctl.clips);
    },
    async deleteClip(id) {
      calls.push('deleteClip');
      ctl.clips = ctl.clips.filter((c) => c.id !== id);
      attempts = attempts.filter((a) => a.clipId !== id);
      ctl.queue = refreshQueue(ctl.clips);
    },
    async setContributes(clipId, on) {
      calls.push('setContributes');
      ctl.clips = ctl.clips.map((c) => (c.id === clipId ? { ...c, contributesToSinger: on } : c));
    },
    async exportLibrary() {
      calls.push('exportLibrary');
      return new Blob([JSON.stringify({ format: 'mimic-library', version: 1, clips: ctl.clips })], { type: 'application/json' });
    },
    async importLibrary() {
      calls.push('importLibrary');
      return { added: 0, updated: 0, warnings: [] };
    },
    async prepareClip(file) {
      calls.push('prepareClip');
      return makeFakePreparedClip({ file: { name: file.name, size: file.size } });
    },
    async commitClip(prepared, edits: CommitEdits) {
      calls.push('commitClip');
      const clip = makeFakeClip({
        id: `clip-${ctl.clips.length + 1}`,
        title: edits.title,
        singerId: edits.singerId,
        singerLabel: edits.singerLabel,
        kind: edits.kind,
        sourceFileName: prepared.file.name,
        contributesToSinger: edits.contributeToSinger,
      });
      const fresh: ClipRecord = { ...clip, phrases: clip.phrases.slice(0, edits.phrases.length).map((p) => ({ ...p, srs: { rung: 0, dueAt: null, masteredAt: null }, stats: emptyStats(), keyHint: null })) };
      ctl.clips = [fresh, ...ctl.clips];
      ctl.queue = refreshQueue(ctl.clips);
      return fresh;
    },
    async relinkClip(clipId) {
      calls.push('relinkClip');
      const clip = ctl.clips.find((c) => c.id === clipId);
      if (!clip) throw new Error('That clip is no longer in the library.');
      const relinked = { ...clip, audioMissing: false };
      ctl.clips = ctl.clips.map((c) => (c.id === clipId ? relinked : c));
      return relinked;
    },
    async listAttempts(f) {
      calls.push('listAttempts');
      const list = attempts.filter((a) => (!f.phraseId || a.phraseId === f.phraseId) && (!f.clipId || a.clipId === f.clipId)).sort((a, b) => b.at - a.at);
      return f.limit ? list.slice(0, f.limit) : list;
    },
    async deleteAttempts(f) {
      calls.push('deleteAttempts');
      const before = attempts.length;
      attempts = attempts.filter((a) => !((!f.phraseId || a.phraseId === f.phraseId) && (!f.clipId || a.clipId === f.clipId)));
      return before - attempts.length;
    },
    async openPractice(clipId, pid) {
      calls.push('openPractice');
      const clip = ctl.clips.find((c) => c.id === clipId);
      const phrase = clip?.phrases.find((p) => p.id === pid);
      if (!clip || !phrase) throw new Error('That phrase is no longer in the library.');
      const engine = new FakeTrainerEngine({ ...opts.engine, clip, phrase });
      engines.push(engine);
      return engine;
    },
    async clearAll() {
      calls.push('clearAll');
      ctl.clips = [];
      attempts = [];
      ctl.queue = [];
    },
  };
  ctl.queue = refreshQueue(ctl.clips);
  if (ctl.status === 'loading') ctl.storage = { ...UNKNOWN_STORAGE };
  return ctl;
}
