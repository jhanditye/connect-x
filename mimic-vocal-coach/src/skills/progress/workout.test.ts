import { describe, expect, it } from 'vitest';
import { comfortableRange, fitSequence } from '../theory/range';
import { mulberry32 } from '../theory/rng';
import { parseSequence } from '../theory/sequence';
import type { AppSettings, VoiceType } from '../../types';
import type { Degree, SkillsStore } from '../types';
import { emptySkillsStore, recordSkillsSession, updateSkillsPrefs } from './store';
import { buildWorkout, currentEarSet, workoutEarSet, workoutFindings, workoutSeconds, workoutSequenceTexts } from './workout';
import { breathSession, earSession, matchSession, sequenceSession, singSession, workoutSession } from './testKit';

const settings = (voiceType: VoiceType = 'baritone'): AppSettings => ({ voiceType, a4Hz: 440, anthropicApiKey: null, aiModel: 'x' });

describe('buildWorkout', () => {
  it('has the six steps of the brief, in order, about 7 to 12 minutes in all', () => {
    const steps = buildWorkout(emptySkillsStore(), settings(), mulberry32(1));
    expect(steps.map((s) => s.kind)).toEqual(['breath', 'match', 'ear', 'sing-intervals', 'sequence', 'breath']);
    expect(steps[0].plan).toEqual({ parts: ['paced'], pacedRounds: 2 });
    expect(steps[1].plan).toEqual({ count: 6 });
    expect(steps[2].plan).toMatchObject({ mode: 'interval', questions: 10 });
    expect(steps[3].plan).toEqual({ count: 4, mode: 'read' });
    expect(steps[4].plan).toMatchObject({ mode: 'read' });
    expect(steps[5].plan).toEqual({ parts: ['hiss'] });
    const sec = workoutSeconds(steps);
    expect(sec).toBeGreaterThanOrEqual(7 * 60);
    expect(sec).toBeLessThanOrEqual(12 * 60);
    for (const s of steps) expect(s.label.length).toBeGreaterThan(3);
  });

  it('is the same for the same seed', () => {
    const a = buildWorkout(emptySkillsStore(), settings(), mulberry32(42));
    const b = buildWorkout(emptySkillsStore(), settings(), mulberry32(42));
    expect(a).toEqual(b);
  });

  it('uses the whole Starter set, and 4 weakest + 2 easy from a bigger set', () => {
    const fresh = emptySkillsStore();
    expect(workoutEarSet(fresh, mulberry32(1))).toEqual(currentEarSet(fresh.prefs));
    expect(currentEarSet(fresh.prefs)).toEqual([4, 5, 7, 12]);
    let s: SkillsStore = updateSkillsPrefs(fresh, { earLevel: 4 }); // 4 5 7 12 3 2 9 8 10 11
    // Make 8, 9, 10 and 11 clearly weak (both directions), the rest strong.
    const answers = [2, 3, 4, 5, 7, 12, 8, 9, 10, 11].flatMap((semi) =>
      (['up', 'down'] as const).flatMap((direction) => Array.from({ length: 4 }, () => ({ semitones: semi, direction, correct: semi < 8 || semi === 12 }))),
    );
    s = recordSkillsSession(s, earSession(answers, 0, 'e'));
    for (let seed = 0; seed < 30; seed++) {
      const set = workoutEarSet(s, mulberry32(seed));
      expect(set).toHaveLength(6);
      expect(set).toEqual([...set].sort((a, b) => a - b));
      for (const w of [8, 9, 10, 11]) expect(set).toContain(w);
    }
  });

  it('writes sequence lines that parse back to themselves and fit every voice type', () => {
    for (const v of ['bass', 'baritone', 'tenor', 'alto', 'mezzo', 'soprano'] as VoiceType[]) {
      for (const mode of ['major', 'natural-minor', 'harmonic-minor'] as const) {
        const store = updateSkillsPrefs(emptySkillsStore(), { scaleMode: mode });
        for (let seed = 0; seed < 15; seed++) {
          const texts = workoutSequenceTexts(store, { voiceType: v }, mulberry32(seed));
          expect(texts).toHaveLength(2);
          expect(texts[0]).not.toBe(texts[1]);
          for (const t of texts) {
            const p = parseSequence(t, mode);
            expect(p.ok).toBe(true);
            if (!p.ok) continue;
            expect(p.notes.length).toBeGreaterThanOrEqual(4);
            expect(p.notes.length).toBeLessThanOrEqual(7);
            expect(fitSequence(p.notes, mode, comfortableRange(v))).not.toBeNull();
          }
        }
      }
    }
  });

  it('puts weak degrees into the lines more often', () => {
    let s = emptySkillsStore();
    // 7 sung 45 cents off many times, every other degree near perfect.
    s = recordSkillsSession(s, sequenceSession([1, 2, 3, 4, 5, 6, 7].map((d) => ({ degree: d as Degree, cents: d === 7 ? -45 : 2 })), 0.8, 0, 'q'));
    const count = (store: SkillsStore): number => {
      let n = 0;
      for (let seed = 0; seed < 300; seed++) {
        for (const t of workoutSequenceTexts(store, { voiceType: 'baritone' }, mulberry32(seed))) n += (t.match(/7/g) ?? []).length;
      }
      return n;
    };
    expect(count(s)).toBeGreaterThan(1.5 * count(emptySkillsStore()));
  });
});

describe('workoutFindings', () => {
  it('says what improved against the previous session of the same kind, then what to work on', () => {
    let s = emptySkillsStore();
    // Earlier, outside any workout.
    s = recordSkillsSession(s, matchSession([{ register: 'mid', heldCents: 30 }, { register: 'mid', heldCents: -26 }], 0, 'm0'));
    // Make the minor 6th down a clear weak spot (an older session), and the 7 a flat habit.
    s = recordSkillsSession(s, earSession(Array.from({ length: 6 }, () => ({ semitones: 8, direction: 'down' as const, correct: false })), 0, 'e1'));
    s = recordSkillsSession(s, earSession(Array.from({ length: 10 }, (_, i) => ({ semitones: 7, correct: i < 5 })), 1, 'e0'));
    s = recordSkillsSession(s, breathSession({ hissSec: 20 }, 2, 'b0'));
    s = updateSkillsPrefs(s, { earLevel: 3 });
    s = recordSkillsSession(s, sequenceSession(Array.from({ length: 6 }, () => ({ degree: 7 as const, cents: -22 })), 0.5, 4, 'q0'));
    // Today's workout.
    const parts = [
      { ...matchSession([{ register: 'mid', heldCents: 8 }, { register: 'mid', heldCents: -10 }], 100, 'm1'), workoutId: 'w' },
      { ...earSession(Array.from({ length: 10 }, (_, i) => ({ semitones: 7, correct: i < 5 })), 101, 'e2'), workoutId: 'w' },
      { ...breathSession({ hissSec: 21 }, 102, 'b1'), workoutId: 'w' },
      { ...singSession([{ semitones: 9, intervalCents: 12 }], 103, 's1'), workoutId: 'w' },
    ];
    for (const p of parts) s = recordSkillsSession(s, p);
    const w = workoutSession(parts.map((p) => p.id), 104, 'w');
    s = recordSkillsSession(s, w);
    const f = workoutFindings(s, w);
    const text = f.map((x) => `${x.tone}: ${x.text}`).join('\n');
    expect(f.length).toBeLessThanOrEqual(5);
    expect(text).toContain('good: Matching notes improved: 9 cents off on average, down from 28 cents last time.');
    expect(text).toContain('info: Naming intervals held steady: 50% right (50% last time).');
    expect(text).toContain('work: Next to work on: hearing a minor 6th down (still a tricky one).');
    expect(text).toContain('work: Your 7 tends to sit 22 cents flat');
    expect(text).not.toMatch(/fail/i);
    // The good news comes first.
    expect(f[0].tone).toBe('good');
  });

  it('marks first measures and never comes back empty', () => {
    const s0 = emptySkillsStore();
    const w0 = workoutSession([], 0, 'w0');
    expect(workoutFindings(s0, w0)).toEqual([{ tone: 'good', text: expect.stringContaining('Workout done') }]);
    let s = recordSkillsSession(s0, { ...breathSession({ hissSec: 15 }, 1, 'b'), workoutId: 'w1' });
    const w1 = workoutSession(['b'], 2, 'w1');
    s = recordSkillsSession(s, w1);
    expect(workoutFindings(s, w1)[0]).toEqual({ tone: 'info', text: 'Hiss test: 15 s. That is your first measure to beat.' });
  });
});
