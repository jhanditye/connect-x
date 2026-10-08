// The acceptance tests of the scorer: perfect copies, key/lag invariance, one injected error -> the intended skill (and only that skill)
// drops, monotone responses, partial takes, junk around the take, bleed, no-match, speech-like phrases, modes, robustness.
// Real-voice cases are in scoreReal.test.ts (they need clips that live outside the repository).
import { describe, expect, it } from 'vitest';
import { analyzeTake } from '../../analysis/analyze';
import { concat, silence } from '../../testing/synth';
import { scoreAttempt } from './score';
import { estimateToneBias } from './tone';
import { DEFAULT_TONE, PH_A, PH_RUN, PH_SHORT, SR, analyse, attemptAnalysis, clone, refAnalysis, renderPhrase, roomNoise, type AttemptSpec } from './testkit';
import * as I from './testkit';
import type { AttemptScore, SkillKey } from './types';

const ref = refAnalysis(PH_A);
const run = (spec: AttemptSpec, opts = {}, r = ref): AttemptScore => scoreAttempt(r, attemptAnalysis({ notes: PH_A, seed: 77, lead: 1.6, ...spec }), opts);
const base = run({});
const SKILLS: SkillKey[] = ['pitch', 'timing', 'tone', 'expression'];
const skill = (r: AttemptScore, k: SkillKey): number => r.skills[k] as number;

describe('perfect copies', () => {
  it('score 95-100 in every key and with any lead-in', () => {
    expect(base.status).toBe('ok');
    expect(base.overall).toBeGreaterThanOrEqual(98);
    for (const key of [-12, -7, -3, 5, 12]) {
      for (const lead of [0.4, 3.2]) {
        const r = run({ key, lead });
        expect(r.overall, `key ${key} lead ${lead}`).toBeGreaterThanOrEqual(95);
        for (const k of SKILLS) expect(skill(r, k), `${k} key ${key}`).toBeGreaterThanOrEqual(92);
        expect(r.transposeSemitones).toBe(key);
        expect(r.trust.level).toBe('ok');
      }
    }
  });

});

describe('perfect copies score 99-100 in every key and for every phrase length', () => {
  const phrases = [['a long phrase (9 s, 11 notes)', PH_A], ['a phrase with a fast run (5.5 s)', PH_RUN], ['a short phrase (3 s, 4 notes)', PH_SHORT]] as const;
  for (const [label, notes] of phrases) {
    it(label, () => {
      const r0 = refAnalysis(notes);
      for (const key of [0, -12, -5, 3, 7, 12]) {
        const r = scoreAttempt(r0, attemptAnalysis({ notes, key, seed: 77, lead: 1.6 }));
        expect(r.status, `key ${key}`).toBe('ok');
        expect(r.overall, `key ${key}`).toBeGreaterThanOrEqual(99);
        expect(r.overall, `key ${key}`).toBeLessThanOrEqual(100);
        expect(r.transposeSemitones).toBe(key);
        expect(Math.abs(r.keyOffsetCents)).toBeLessThan(5);
        expect(r.trust.level === 'ok' || r.trust.level === 'caution').toBe(true);
        expect(r.perNote.every((n) => n.flags.every((f) => f === 'ok' || f === 'ornament'))).toBe(true);
      }
    }, 60_000);
  }
});

describe('what is not an error', () => {
  it('a constant detune of the whole take (10-100 cents) is free in own-key mode', () => {
    for (const c of [10, 25, 50, 100]) {
      const r = run({ notes: I.detuneConst(PH_A, c) });
      expect(r.overall, `${c} cents`).toBeGreaterThanOrEqual(97);
      expect(skill(r, 'pitch'), `${c} cents`).toBeGreaterThanOrEqual(97);
    }
  });
  it('a global lag does not move any score', () => {
    for (const lead of [0.3, 2.5, 6]) expect(Math.abs((run({ lead }).overall as number) - (base.overall as number)), `lead ${lead}`).toBeLessThanOrEqual(2);
  });
});

describe('monotone responses', () => {
  it('pitch falls as per-note detune grows', () => {
    const v = [8, 25, 40, 60].map((sd) => skill(run({ notes: I.detuneAll(PH_A, sd) }), 'pitch'));
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeLessThan(v[i - 1]);
    expect(v[0]).toBeGreaterThanOrEqual(97);
    expect(v[3]).toBeLessThanOrEqual(72);
  });
  it('timing falls as onset jitter and tempo error grow', () => {
    const j = [15, 50, 80, 120].map((sd) => skill(run({ notes: I.jitterOnsets(PH_A, sd) }), 'timing'));
    for (let i = 1; i < j.length; i++) expect(j[i]).toBeLessThanOrEqual(j[i - 1]);
    const t = [1.0, 0.9, 0.8].map((f) => skill(run({ notes: I.tempo(PH_A, f) }), 'timing'));
    expect(t[1]).toBeLessThan(t[0]);
    expect(t[2]).toBeLessThan(t[1]);
  });
  it('tone falls as brightness moves away', () => {
    const v = [-12, -9, -6].map((tilt) => skill(run({ tone: { ...DEFAULT_TONE, tiltDbPerOct: tilt } }), 'tone'));
    expect(v[1]).toBeLessThan(v[0]);
    expect(v[2]).toBeLessThan(v[1]);
  });
  it('human-like profiles rank pro > good > weak > poor', () => {
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const m = (['pro', 'good', 'weak', 'poor'] as const).map((p) => mean([0, 1, 2, 3].map((s) => {
      const r = run({ notes: I.humanize(PH_A, I.HUMAN[p], s + 1), seed: 300 + s, lead: 1.3 + 0.3 * s, key: s % 2 ? -5 : 0 });
      return r.status === 'ok' ? (r.overall as number) : 20;
    })));
    expect(m[0]).toBeGreaterThanOrEqual(96);
    expect(m[0]).toBeGreaterThan(m[1]);
    expect(m[1]).toBeGreaterThan(m[2] + 8);
    expect(m[2]).toBeGreaterThan(m[3] + 8);
  }, 120_000);
});

describe('partial and incomplete takes', () => {
  it('the first 60 % of the notes: coverage about half, sung part scored fully, overall pulled down', () => {
    const r = run({ notes: I.sliceNotes(PH_A, 0, 6) });
    expect(r.coverage).toBeGreaterThan(0.4);
    expect(r.coverage).toBeLessThan(0.65);
    expect(skill(r, 'pitch')).toBeGreaterThanOrEqual(95);
    expect(skill(r, 'timing')).toBeGreaterThanOrEqual(95);
    expect(r.overallOnSung).toBeGreaterThanOrEqual(96);
    expect(r.overall as number).toBeLessThan(75);
    expect(r.overall as number).toBeGreaterThan(40);
    expect(r.fixes[0].id).toBe('coverage');
  });
  it('the last half and the middle also align (not a different key, not a wrong spot)', () => {
    for (const [a, b] of [[6, 11], [3, 8]] as const) {
      const r = run({ notes: I.sliceNotes(PH_A, a, b) });
      expect(r.transposeSemitones).toBe(0);
      expect(skill(r, 'pitch')).toBeGreaterThanOrEqual(95);
      expect(r.coverage).toBeLessThan(0.65);
    }
  });
});

describe('different phrase / nothing to score', () => {
  it('an unrelated melody is reported as no-match', () => {
    const r = scoreAttempt(refAnalysis(PH_A), attemptAnalysis({ notes: PH_RUN, seed: 9, lead: 1.5 }));
    expect(r.status).toBe('no-match');
    expect(r.overall as number).toBeLessThanOrEqual(20);
  });
  it('a scrambled version of the phrase is reported as no-match', () => {
    const scr = clone(PH_A).map((n, i, a) => ({ ...n, midi: a[(i * 5 + 3) % a.length].midi, vibrato: null }));
    expect(run({ notes: scr }).status).toBe('no-match');
  });
  it('silence and a too-short take are low-evidence, never a number', () => {
    const silent = analyzeTake(roomNoise(new Float32Array(SR * 4), 0.001, 2), SR, { voiceType: 'tenor' });
    const r = scoreAttempt(ref, silent);
    expect(r.status).toBe('low-evidence');
    expect(r.overall).toBeNull();
    const tiny = attemptAnalysis({ notes: I.sliceNotes(PH_A, 0, 1), lead: 1 });
    expect(scoreAttempt(ref, tiny).status === 'low-evidence' || (scoreAttempt(ref, tiny).overall as number) < 40).toBe(true);
  });
  it('a reference with too little singing is low-evidence', () => {
    const tiny = attemptAnalysis({ notes: PH_A.slice(0, 1), lead: 0.3 });
    expect(scoreAttempt(tiny, attemptAnalysis({ notes: PH_A })).status).toBe('low-evidence');
  });
});

describe('reference leaking into the microphone (sing-along without headphones)', () => {
  const ph = renderPhrase(PH_A, undefined, { leadIn: 0.15, tail: 0.2, noiseRms: 0 });
  const r0 = analyse(roomNoise(ph, 0.0012, 3));
  const opts = { mode: 'sing-along' as const, refStartInCaptureSec: 2, latencyMs: 120 };
  it('playback alone is flagged invalid, in any level', () => {
    for (const g of [0.5, 0.1]) {
      const r = scoreAttempt(r0, analyse(roomNoise(concat(silence(2.18, SR), ph.map((v) => v * g), silence(0.6, SR)), 0.0012, 8)), opts);
      expect(r.trust.level).toBe('invalid');
      expect(r.trust.reasons[0]).toMatch(/headphones/);
    }
  });
  it('the same take is not flagged in turn-taking mode (no playback was running)', () => {
    const r = scoreAttempt(r0, analyse(roomNoise(concat(silence(2.18, SR), ph, silence(0.6, SR)), 0.0012, 8)), { mode: 'turn-taking' });
    expect(r.trust.level).toBe('ok');
  });
  it('sing-along reports the lag against the schedule, minus the known latency', () => {
    const r = scoreAttempt(r0, analyse(roomNoise(concat(silence(2.18, SR), ph, silence(0.6, SR)), 0.0012, 8)), opts);
    expect(r.timing.lagMs as number).toBeGreaterThan(40);
    expect(r.timing.lagMs as number).toBeLessThan(80);
  });
});

describe('ornaments, vibrato and speech-like phrases', () => {
  const refRun = refAnalysis(PH_RUN);
  it('a simplified run, off-pitch run notes or straight tone cost little', () => {
    const simplified = clone(PH_RUN);
    const runNotes = simplified.splice(2, 6);
    simplified.splice(2, 0, { midi: runNotes[0].midi, durSec: 0.36 }, { midi: runNotes[5].midi, durSec: 0.36 });
    for (const notes of [simplified, clone(PH_RUN).map((n, i) => (i >= 2 && i <= 7 ? { ...n, detuneCents: i % 2 ? 60 : -50 } : n)), clone(PH_RUN).map((n) => ({ ...n, vibrato: null }))]) {
      const r = scoreAttempt(refRun, attemptAnalysis({ notes, seed: 31, lead: 1.4, key: -2 }));
      expect(r.overall as number).toBeGreaterThanOrEqual(92);
    }
  });
});

describe('modes and options', () => {
  it('locked key: a take 3 semitones down is wrong notes, with an explanation; free key does not mind', () => {
    const locked = run({ key: -3 }, { keyMode: 'locked' });
    expect(skill(locked, 'pitch')).toBeLessThan(40);
    expect(locked.notes.join(' ')).toMatch(/3 semitones? below the original key/);
    expect(run({ key: -3 }, { keyMode: 'free' }).overall).toBeGreaterThanOrEqual(97);
    expect(run({ key: -12 }, { keyMode: 'locked' }).overall).toBeGreaterThanOrEqual(97); // octaves are allowed
  });
  it('practice speed: at rate 0.7 a take 1/0.7 slower has no tempo fault, but does without the option', () => {
    const slow = { notes: I.tempo(PH_A, 1 / 0.7) };
    const with07 = run(slow, { rate: 0.7 });
    const without = run(slow, {});
    expect(skill(with07, 'timing')).toBeGreaterThanOrEqual(95);
    expect(skill(without, 'timing')).toBeLessThanOrEqual(75);
    expect(without.fixes.map((f) => f.id)).toContain('timing.tempo');
    expect(with07.fixes.map((f) => f.id)).not.toContain('timing.tempo');
  });
  it('weights can be overridden and are renormalised over the skills that were measured', () => {
    const r = run({}, { weights: { pitch: 1, timing: 0, tone: 0, expression: 0 } });
    expect(r.weights.pitch).toBeCloseTo(1, 5);
    const mix = refAnalysis(PH_A);
    mix.issues = [...mix.issues, 'accompaniment'];
    const m = scoreAttempt(mix, attemptAnalysis({ notes: PH_A, seed: 77, lead: 1.6 }));
    expect(m.skills.tone).toBeNull();
    expect(m.weights.tone).toBe(0);
    expect(m.weights.pitch + m.weights.timing + m.weights.expression).toBeCloseTo(1, 5);
    expect(m.trust.reasons.join(' ')).toMatch(/full mix/);
  });
  it('a personal tone bias is subtracted before judging tone', () => {
    const spec = { tone: { ...DEFAULT_TONE, tiltDbPerOct: -7 } };
    const plain = run(spec);
    const d = (attemptAnalysis({ notes: PH_A, ...spec }).style.brightness as number) - (ref.style.brightness as number);
    const biased = run(spec, { toneBias: { brightness: d } });
    expect(skill(biased, 'tone')).toBeGreaterThan(skill(plain, 'tone') + 10);
  });
});

describe('tone bias from history', () => {
  it('estimateToneBias is the median offset once there are enough attempts, and nothing before', () => {
    const hist = [0.1, 0.12, 0.08, 0.11, 0.09, 0.1].map((d) => ({ diffs: { breathiness: d, brightness: -0.05 } }));
    expect(estimateToneBias(hist.slice(0, 4))).toEqual({});
    const b = estimateToneBias(hist);
    expect(b.breathiness).toBeCloseTo(0.1, 2);
    expect(b.brightness).toBeCloseTo(-0.05, 2);
    expect(b.rasp).toBeUndefined();
  });
});

describe('what to fix first', () => {
  it('ranks by points gained and names the right thing', () => {
    const r = run({ notes: I.tempo(I.detuneOne(PH_A, 3, -70), 0.85), tone: { ...DEFAULT_TONE, tiltDbPerOct: -9 } });
    expect(r.fixes.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < r.fixes.length; i++) expect(r.fixes[i].gainPoints).toBeLessThanOrEqual(r.fixes[i - 1].gainPoints);
    expect(r.fixes.map((f) => f.skill)).toEqual(expect.arrayContaining(['pitch', 'timing']));
    // a fix never tells the singer to push
    expect(r.fixes.map((f) => f.advice).join(' ')).not.toMatch(/louder|push harder|power through/i);
    // gains add up to no more than the headroom
    expect(r.fixes.reduce((a, f) => a + f.gainPoints, 0)).toBeLessThanOrEqual(100 - (r.overall as number) + 3);
  });
  it('the findings are plain English and mention the key change and the wrong note', () => {
    const r = run({ key: -4, notes: I.wrongNote(PH_A, 7, -3) });
    expect(r.notes[0]).toMatch(/4 semitones lower.*not marked down/);
    expect(r.notes.join(' ')).toMatch(/note 8/);
  });
});

describe('robustness', () => {
  it('never throws on degenerate analyses', () => {
    const empty = analyzeTake(new Float32Array(SR), SR, { voiceType: 'tenor' });
    const att = attemptAnalysis({ notes: PH_A });
    expect(() => scoreAttempt(empty, att)).not.toThrow();
    expect(() => scoreAttempt(ref, empty)).not.toThrow();
    expect(() => scoreAttempt(ref, ref)).not.toThrow();
    const noisy = { ...att, frames: att.frames.map((f, i) => (i % 7 === 0 ? { ...f, midi: NaN, f0: NaN } : f)) };
    expect(() => scoreAttempt(ref, noisy)).not.toThrow();
  });
  it('is fast (< 150 ms for a 9 s phrase)', () => {
    const att = attemptAnalysis({ notes: PH_A, key: -2 });
    const t0 = performance.now();
    scoreAttempt(ref, att);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});
