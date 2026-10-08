// Each injected error (known size, one at a time) lowers the sub-score it should, and leaves the others alone.
// Run with MIMIC_PRINT_TABLE=1 to print the measured table (injected error against overall / pitch / timing / tone / expression).
import { describe, expect, it } from 'vitest';
import { scoreAttempt } from './score';
import { DEFAULT_TONE, PH_A, attemptAnalysis, refAnalysis, type AttemptSpec } from './testkit';
import * as I from './testkit';
import type { AttemptScore, ScoreOptions, SkillKey } from './types';

const SKILLS: SkillKey[] = ['pitch', 'timing', 'tone', 'expression'];
const ref = refAnalysis(PH_A);

interface Case {
  group: string;
  name: string;
  spec: AttemptSpec;
  opts?: ScoreOptions;
  /** The sub-score the error should lower; null = a change that must not be an error at all. */
  moves: SkillKey | null;
  /** The intended sub-score must be at most this (or, for null, every sub-score at least `othersAtLeast`). */
  atMost?: number;
  othersAtLeast: number;
  /** A fix id that must be in the ranked list. */
  fix?: string;
  /** The error is real but worth under a point and a half: the sub-score moves, and no fix is listed for it (see FIX_SHOWN_POINTS). */
  small?: true;
  /** Overall must be at least / at most this. */
  overallAtLeast?: number;
  overallAtMost?: number;
}

const CASES: Case[] = [
  // ---- not errors
  { group: 'free', name: 'exact copy', spec: {}, moves: null, othersAtLeast: 98, overallAtLeast: 99 },
  { group: 'free', name: 'whole phrase -12 st (an octave down)', spec: { key: -12 }, moves: null, othersAtLeast: 97, overallAtLeast: 98 },
  { group: 'free', name: 'whole phrase +5 st', spec: { key: 5 }, moves: null, othersAtLeast: 97, overallAtLeast: 98 },
  { group: 'free', name: 'whole phrase -5 st and +35 cents', spec: { key: -5, notes: I.detuneConst(PH_A, 35) }, moves: null, othersAtLeast: 97, overallAtLeast: 98 },
  { group: 'free', name: 'constant detune +50 cents', spec: { notes: I.detuneConst(PH_A, 50) }, moves: null, othersAtLeast: 97, overallAtLeast: 98 },
  { group: 'free', name: 'a global delay: 5 s of lead-in', spec: { lead: 5 }, moves: null, othersAtLeast: 97, overallAtLeast: 98 },
  // ---- pitch
  { group: 'pitch', name: 'per-note detune sd 25 cents', spec: { notes: I.detuneAll(PH_A, 25) }, moves: 'pitch', atMost: 95, othersAtLeast: 96 },
  { group: 'pitch', name: 'per-note detune sd 40 cents', spec: { notes: I.detuneAll(PH_A, 40) }, moves: 'pitch', atMost: 85, othersAtLeast: 92 },
  { group: 'pitch', name: 'one note 60 cents flat', spec: { notes: I.detuneOne(PH_A, 3, -60) }, moves: 'pitch', atMost: 92, othersAtLeast: 96, fix: 'pitch.flat' },
  { group: 'pitch', name: 'a wrong note (+2 semitones)', spec: { notes: I.wrongNote(PH_A, 2, 2) }, moves: 'pitch', atMost: 96, othersAtLeast: 90, fix: 'pitch.wrong-notes' },
  { group: 'pitch', name: 'sharp as the line climbs (+10 c per semitone)', spec: { notes: I.heightSlope(PH_A, 10) }, moves: 'pitch', atMost: 80, othersAtLeast: 88, fix: 'pitch.height' },
  { group: 'pitch', name: 'leaps undershot by 45 cents', spec: { notes: I.undershootLeaps(PH_A, 45) }, moves: 'pitch', atMost: 96, othersAtLeast: 96, fix: 'pitch.leaps' },
  // ---- timing
  { group: 'timing', name: 'tempo x0.8 (rushed)', spec: { notes: I.tempo(PH_A, 0.8) }, moves: 'timing', atMost: 80, othersAtLeast: 96, fix: 'timing.tempo' },
  { group: 'timing', name: 'tempo x1.25 (dragged)', spec: { notes: I.tempo(PH_A, 1.25) }, moves: 'timing', atMost: 80, othersAtLeast: 96, fix: 'timing.tempo' },
  { group: 'timing', name: 'onset jitter sd 120 ms', spec: { notes: I.jitterOnsets(PH_A, 120) }, moves: 'timing', atMost: 92, othersAtLeast: 95 },
  { group: 'timing', name: 'a long note cut 50 % short', spec: { notes: I.cutShort(PH_A, 3, 0.5) }, moves: 'timing', atMost: 97, othersAtLeast: 96, small: true },
  { group: 'timing', name: 'a note 200 ms late after a breath', spec: { notes: I.shiftOnset(PH_A, 6, 200) }, moves: 'timing', atMost: 98, othersAtLeast: 96 },
  // ---- tone
  { group: 'tone', name: 'brighter (tilt -12 -> -6 dB/oct)', spec: { tone: { ...DEFAULT_TONE, tiltDbPerOct: -6 } }, moves: 'tone', atMost: 78, othersAtLeast: 96, fix: 'tone.brightness' },
  { group: 'tone', name: 'darker (tilt -12 -> -20 dB/oct)', spec: { tone: { ...DEFAULT_TONE, tiltDbPerOct: -20 } }, moves: 'tone', atMost: 85, othersAtLeast: 96, fix: 'tone.brightness' },
  { group: 'tone', name: 'breathier (noise 0.4 and H1 +6 dB)', spec: { tone: { ...DEFAULT_TONE, breathNoise: 0.4, h1BoostDb: 6 } }, moves: 'tone', atMost: 92, othersAtLeast: 96 },
  { group: 'tone', name: 'rasp (subharmonic 0.4)', spec: { tone: { ...DEFAULT_TONE, subharmonic: 0.4 } }, moves: 'tone', atMost: 80, othersAtLeast: 90 },
  // ---- expression
  { group: 'expression', name: 'vibrato removed (straight tone)', spec: { notes: I.noVibrato(PH_A) }, moves: 'expression', atMost: 88, othersAtLeast: 97, fix: 'expr.vibrato' },
  { group: 'expression', name: 'vibrato starts much later', spec: { notes: I.scaleVibrato(PH_A, { delay: 3 }) }, moves: 'expression', atMost: 88, othersAtLeast: 97 },
  { group: 'expression', name: 'no scoop or fall-off shaping', spec: { notes: I.noScoop(PH_A) }, moves: 'expression', atMost: 95, othersAtLeast: 96, small: true },
  // ---- completeness
  { group: 'coverage', name: 'first 6 of 11 notes only', spec: { notes: I.sliceNotes(PH_A, 0, 6) }, moves: null, othersAtLeast: 94, overallAtMost: 75, fix: 'coverage' },
];

const results = new Map<Case, AttemptScore>();
function measure(c: Case): AttemptScore {
  let r = results.get(c);
  if (!r) {
    r = scoreAttempt(ref, attemptAnalysis({ notes: PH_A, seed: 77, lead: 1.6, ...c.spec }), c.opts);
    results.set(c, r);
  }
  return r;
}

const skill = (r: AttemptScore, k: SkillKey): number => r.skills[k] as number;

describe('each injected error lowers the intended sub-score and (almost) only that one', () => {
  for (const c of CASES) {
    it(`${c.group}: ${c.name}`, () => {
      const r = measure(c);
      expect(r.status).toBe('ok');
      if (c.moves !== null) expect(skill(r, c.moves), c.moves).toBeLessThanOrEqual(c.atMost as number);
      for (const k of SKILLS) if (k !== c.moves) expect(skill(r, k), `${k} should stay`).toBeGreaterThanOrEqual(c.othersAtLeast);
      if (c.fix) expect(r.fixes.map((f) => f.id), 'fix list').toContain(c.fix);
      if (c.small) expect(r.fixes, 'a fix worth under 1.5 points is not listed').toEqual([]);
      if (c.overallAtLeast !== undefined) expect(r.overall as number).toBeGreaterThanOrEqual(c.overallAtLeast);
      if (c.overallAtMost !== undefined) expect(r.overall as number).toBeLessThanOrEqual(c.overallAtMost);
      // The intended sub-score is the one that moved the most (the coverage case moves only the overall).
      if (c.moves !== null) {
        const others = SKILLS.filter((k) => k !== c.moves).map((k) => skill(r, k));
        expect(skill(r, c.moves)).toBeLessThanOrEqual(Math.min(...others) + 3);
      }
    });
  }

  it('prints the measured table when MIMIC_PRINT_TABLE is set', () => {
    if (!process.env.MIMIC_PRINT_TABLE) return;
    const rows = CASES.map((c) => {
      const r = measure(c);
      const f = (x: number | null): string => (x === null ? '-' : String(x));
      return `| ${c.group} | ${c.name} | ${f(r.overall)} | ${f(r.skills.pitch)} | ${f(r.skills.timing)} | ${f(r.skills.tone)} | ${f(r.skills.expression)} | ${r.fixes.slice(0, 2).map((x) => `${x.id} ${x.gainPoints}`).join(', ') || '-'} |`;
    });
    console.log(['| group | injected error | overall | pitch | timing | tone | expression | top fixes (points) |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n'));
  });
});
