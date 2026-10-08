import { describe, expect, it } from 'vitest';
import { getExercise } from '../coach/exercises';
import { makeFakePhraseComparison, COMPARISON_SCENARIOS } from '../testing/trainerFixtures';
import type { PhraseComparison, ToneFinding } from '../types';
import { buildFixes, categoryOf, fixToCoachingItem, inOriginalTerms, loopLabel, safeCue, toneWords, trainerFixId } from './feedback';

const UNSAFE = /\b(louder|sing louder|more volume|push harder|power through|more rasp|more grit|add (some )?(rasp|grit)|squeeze)\b/i;

describe('buildFixes on the canned scenarios', () => {
  it('a perfect attempt has nothing to fix', () => {
    expect(buildFixes(makeFakePhraseComparison('perfect'))).toEqual([]);
  });

  it('the fixes are the scorer\'s own, in the order of the points they gain', () => {
    for (const s of COMPARISON_SCENARIOS) {
      const c = makeFakePhraseComparison(s);
      const fixes = buildFixes(c);
      expect(fixes.length).toBeLessThanOrEqual(3);
      const order = c.score.fixes.map((f) => f.id);
      let last = -1;
      for (const f of fixes) {
        const at = order.indexOf(f.scorerId);
        expect(at, `${s}: ${f.id} is one of the scorer's fixes`).toBeGreaterThan(last);
        last = at;
        expect(f.loss).toBe(c.score.fixes[at].gainPoints);
      }
    }
    const flat = buildFixes(makeFakePhraseComparison('flat'));
    expect(flat.map((f) => f.scorerId)).toEqual(['pitch.flat', 'expr.vibrato']);
    expect(flat.map((f) => f.id)).toEqual(['pitch-flat', 'expr-vibrato']);
    expect(flat[0].loss).toBeGreaterThan(flat[1].loss);
  });

  it('a flat take gets a drill (drone tuning) and a slow loop of the weak notes', () => {
    const [f] = buildFixes(makeFakePhraseComparison('flat'));
    expect(f.title).toBe('Lift the flat notes');
    expect(f.exerciseId).toBe('drone-tuning');
    expect(f.loop).toBeDefined();
    expect(f.loop?.rate).toBe(0.75);
    const c = makeFakePhraseComparison('flat');
    expect(f.loop?.from).toBeLessThanOrEqual(c.notes[2].refStart);
    expect(f.loop?.to).toBeGreaterThanOrEqual(c.notes[3].refEnd);
    expect(loopLabel(f.loop as NonNullable<typeof f.loop>)).toMatch(/^Loop \d+\.\d–\d+\.\d s at 75%$/);
  });

  it('a fix the scorer attached no text to is worded from the tone finding, not from the timing numbers', () => {
    const vib = buildFixes(makeFakePhraseComparison('flat')).find((f) => f.scorerId === 'expr.vibrato');
    expect(vib?.evidence).toBe('The original lets the long notes wobble into vibrato; yours stayed straight.');
    expect(vib?.title).toBe('Add the vibrato');
    expect(vib?.exerciseIds).toEqual(['vibrato-pulses', 'straight-then-vibrato']);
    expect(vib?.loop).toBeUndefined();
  });

  it('a wrong note names the note, a late take says "come in on time", a half-sung take says "finish the phrase"', () => {
    expect(buildFixes(makeFakePhraseComparison('wrong-note'))[0].title).toBe('Check the note on D4');
    expect(buildFixes(makeFakePhraseComparison('late'))[0].title).toBe('Come in on time');
    const partial = buildFixes(makeFakePhraseComparison('partial'));
    expect(partial[0].category).toBe('coverage');
    expect(partial[0].title).toBe('Finish the phrase');
  });

  it('gives nothing for a take the score does not believe', () => {
    expect(buildFixes(makeFakePhraseComparison('no-match'))).toEqual([]);
    const bleed: PhraseComparison = makeFakePhraseComparison('flat');
    expect(buildFixes({ ...bleed, score: { ...bleed.score, trust: { level: 'invalid', reasons: ['x'] } } })).toEqual([]);
  });

  it('every suggested exercise exists, and no cue asks for more rasp, grit or volume', () => {
    for (const s of COMPARISON_SCENARIOS) {
      for (const flavour of ['generic', 'daniel', 'jalen', 'shawn'] as const) {
        for (const f of buildFixes(makeFakePhraseComparison(s), flavour)) {
          expect(f.exerciseIds.length).toBeLessThanOrEqual(2);
          for (const id of f.exerciseIds) expect(getExercise(id), `${s} ${f.id} -> ${id}`).toBeDefined();
          expect(f.exerciseId).toBe(f.exerciseIds[0]);
          expect(f.cue).not.toMatch(UNSAFE);
          expect(f.title.split(/\s+/).length).toBeLessThanOrEqual(6);
          expect(f.evidence.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('at most two fixes of one category, whatever the scorer ranked', () => {
    const c = makeFakePhraseComparison('flat');
    const many = {
      ...c,
      score: {
        ...c.score,
        fixes: ['pitch.flat', 'pitch.sharp', 'pitch.drift', 'timing.late'].map((id, i) => ({ id, skill: id.startsWith('pitch') ? ('pitch' as const) : ('timing' as const), title: id, advice: 'x', gainPoints: 5 - i, notes: [2] })),
      },
    };
    expect(buildFixes(many, 'generic', 3).map((f) => f.scorerId)).toEqual(['pitch.flat', 'pitch.sharp', 'timing.late']);
    expect(buildFixes(many, 'generic', 1)).toHaveLength(1);
  });
});

describe('words and the adapter', () => {
  it('the app says "the original", not "the reference"', () => {
    expect(inOriginalTerms('The reference lets 2 notes shimmer; the reference\'s vibrato is wider.')).toBe("The original lets 2 notes shimmer; the original's vibrato is wider.");
  });

  it('an unsafe cue is replaced, a safe one is kept', () => {
    expect(safeCue('Sing louder on the high notes.')).not.toMatch(UNSAFE);
    expect(safeCue('Add some grit to the start of the note.')).not.toMatch(/grit/);
    expect(safeCue('Lighten the weight and narrow the vowel.')).toBe('Lighten the weight and narrow the vowel.');
  });

  it('tone findings come out in plain words relative to the original, with no raw measurements', () => {
    const cases: [ToneFinding, RegExp][] = [
      [{ key: 'breathiness', diff: 0.14, strength: 1.4 }, /Airier than the original/],
      [{ key: 'breathiness', diff: -0.2, strength: 1.4 }, /Clearer and firmer than the original/],
      [{ key: 'brightness', diff: 0.2, strength: 1.4 }, /Brighter and more forward/],
      [{ key: 'brightness', diff: -0.2, strength: 1.4 }, /Darker and more covered/],
      [{ key: 'rasp', diff: 0.12, strength: 1.5 }, /Grittier than the original/],
      [{ key: 'rasp', diff: -0.12, strength: 1.5 }, /don't force it/],
      [{ key: 'vibratoPresence', diff: -1, strength: 2 }, /yours stayed straight/],
      [{ key: 'vibratoPresence', diff: 1, strength: 2 }, /You added vibrato/],
      [{ key: 'vibratoStart', diff: 0.95, strength: 3.8 }, /about 0\.9 s later|about 1\.0 s later|about 0\.95 s later/],
      [{ key: 'vibratoRateHz', diff: -1.2, strength: 1.2 }, /slower than the original by 1\.2 Hz/],
      [{ key: 'vibratoExtentCents', diff: 25, strength: 1.3 }, /wider than the original by about 25 cents/],
      [{ key: 'level', diff: 5, strength: 1, detail: 'E4,F4' }, /Louder than the original on E4,F4/],
      [{ key: 'level', diff: -5, strength: 1, detail: 'E4,F4' }, /no need to push/],
    ];
    for (const [f, re] of cases) {
      const w = toneWords(f);
      expect(w.text).toMatch(re);
      expect(w.text).not.toMatch(/\bdB\b|\bHz\b.*\bH1\b|alpha|CPP|cepstral/i);
    }
    // more grit is never asked for, softer is never "fixed" by pushing, and both are detail only
    expect(toneWords({ key: 'rasp', diff: -0.1, strength: 1 }).detailOnly).toBe(true);
    expect(toneWords({ key: 'level', diff: -5, strength: 1 }).detailOnly).toBe(true);
    expect(toneWords({ key: 'onset', diff: 0, strength: 1, detail: 'breathy>glottal' }).detailOnly).toBe(true);
    expect(toneWords({ key: 'breathiness', diff: 0.14, strength: 1.4 }).size).toBe('a little');
    expect(toneWords({ key: 'breathiness', diff: 0.4, strength: 3.4 }).size).toBe('much');
  });

  it('the adapter makes a CoachingItem the existing card can show', () => {
    const [f] = buildFixes(makeFakePhraseComparison('flat'));
    const item = fixToCoachingItem(f, 0);
    expect(item.priority).toBe(1);
    expect(item.title).toBe(f.title);
    expect(item.whatWeHeard).toBe(f.evidence);
    expect(item.howToFix).toEqual([f.cue]);
    expect(item.exerciseIds).toEqual(f.exerciseIds);
    expect(item.whyItMatters).toMatch(/worth about 4(\.1)? points?/);
    expect(fixToCoachingItem(f, 1).priority).toBe(2);
    expect(fixToCoachingItem(f, 7).priority).toBe(3);
    expect(item.dimension).toBe('pitchAccuracyCents');
  });

  it('ids are the stable dashed form of the scorer ids', () => {
    expect(trainerFixId('pitch.wrong-notes')).toBe('wrong-notes');
    expect(trainerFixId('timing.tempo')).toBe('tempo');
    expect(trainerFixId('timing.short-notes')).toBe('duration-short');
    expect(trainerFixId('timing.late')).toBe('timing-late');
    expect(trainerFixId('pitch.flat')).toBe('pitch-flat');
    expect(trainerFixId('tone.breathiness')).toBe('tone-breathiness');
    expect(trainerFixId('expr.vibrato')).toBe('expr-vibrato');
    expect(trainerFixId('coverage')).toBe('coverage');
  });

  it('categories', () => {
    expect(categoryOf('coverage')).toBe('coverage');
    expect(categoryOf('timing.tempo')).toBe('tempo');
    expect(categoryOf('timing.short-notes')).toBe('duration');
    expect(categoryOf('timing.late')).toBe('timing');
    expect(categoryOf('pitch.wrong-notes')).toBe('pitch');
    expect(categoryOf('expr.vibrato')).toBe('tone');
    expect(categoryOf('tone.brightness')).toBe('tone');
  });
});
