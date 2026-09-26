import { describe, expect, it } from 'vitest';
import { makeFakeAnalysis, makeFakeProfile } from '../testing/fixtures';
import type { CoachingPlan, SingerProfile, StyleKey, StyleVector, TargetBand, VoiceAnalysis } from '../types';
import { FIXES, WHY, buildCoachingPlan } from './coach';
import { compareToProfile } from './compare';
import { EXERCISES, getExercise } from './exercises';
import { SINGERS, STYLE_KEYS } from './profiles';

const [shawn, daniel, jalen] = SINGERS;
const EXERCISE_IDS = new Set(EXERCISES.map((e) => e.id));

function planFor(analysis: VoiceAnalysis, profile: SingerProfile): CoachingPlan {
  return buildCoachingPlan(analysis, compareToProfile(analysis, profile), profile);
}

function idealStyle(p: SingerProfile): Partial<StyleVector> {
  const out: Partial<StyleVector> = {};
  for (const [k, b] of Object.entries(p.targets) as [StyleKey, TargetBand][]) out[k] = b.ideal;
  return out;
}

function allText(plan: CoachingPlan): string {
  return [
    plan.headline,
    ...plan.strengths,
    ...plan.items.flatMap((i) => [i.title, i.whatWeHeard, i.whyItMatters, ...i.howToFix]),
    ...plan.signatureFocus.map((f) => f.hint),
    ...plan.healthNotes,
    plan.nextTake,
  ].join('\n');
}

// A take far from every profile in many ways, so plans have plenty of items.
const ROUGH: Partial<StyleVector> = {
  breathiness: 0.1,
  brightness: 0.15,
  rasp: 0.5,
  vibratoPresence: 0.95,
  vibratoRateHz: 3.5,
  vibratoExtentCents: 110,
  chestInUpperRange: 0.85,
  mixInUpperRange: 0.1,
  headInUpperRange: 0.05,
  loudnessClimbDbPerSemitone: 1.8,
  agility: 0,
  dynamicRangeDb: 32,
  softOnsetRatio: 0.95,
  pitchAccuracyCents: 38,
  flipsPerMinute: 7,
};

describe('content matrix', () => {
  it('references only exercises that exist', () => {
    for (const key of STYLE_KEYS) {
      for (const dir of ['more', 'less'] as const) {
        const cell = FIXES[key][dir];
        const ids = [...cell.exercises, ...Object.values(cell.singerExercises ?? {}).flat()];
        expect(ids.length, `${key}/${dir}`).toBeGreaterThan(0);
        for (const id of ids) expect(EXERCISE_IDS.has(id), `${key}/${dir} -> ${id}`).toBe(true);
      }
    }
  });

  it('has a title, at least three cues and singer reasons for every dimension and direction', () => {
    for (const key of STYLE_KEYS) {
      for (const dir of ['more', 'less'] as const) {
        const cell = FIXES[key][dir];
        expect(cell.title.length).toBeGreaterThan(5);
        expect(cell.cues.length, `${key}/${dir}`).toBeGreaterThanOrEqual(3);
      }
      for (const flavour of ['shawn', 'daniel', 'jalen', 'generic'] as const) {
        expect(WHY[key][flavour].length, `${key}/${flavour}`).toBeGreaterThan(20);
      }
    }
  });

  it('points each dimension at exercises that list it in `helps`', () => {
    for (const key of STYLE_KEYS) {
      for (const dir of ['more', 'less'] as const) {
        const helping = FIXES[key][dir].exercises.filter((id) => getExercise(id)?.helps.includes(key));
        expect(helping.length, `${key}/${dir}`).toBeGreaterThan(0);
      }
    }
  });

  it('never tells the singer to push, belt harder or get louder', () => {
    const unsafe = /push (it |harder|through)|power through|sing louder|belt (it )?harder|more volume|as loud as you can/i;
    for (const key of STYLE_KEYS) {
      for (const dir of ['more', 'less'] as const) {
        const cell = FIXES[key][dir];
        for (const cue of [...cell.cues, ...Object.values(cell.singerCues ?? {}).flat()]) expect(cue).not.toMatch(unsafe);
      }
    }
    for (const p of SINGERS) expect(allText(planFor(makeFakeAnalysis(ROUGH), p))).not.toMatch(unsafe);
  });
});

describe('buildCoachingPlan', () => {
  it('produces a well-formed plan for every singer', () => {
    for (const p of SINGERS) {
      for (const style of [{}, ROUGH, idealStyle(p)]) {
        const a = makeFakeAnalysis(style);
        const plan = planFor(a, p);
        expect(plan.profileId).toBe(p.id);
        expect(plan.items.length).toBeLessThanOrEqual(5);
        const priorities = plan.items.map((i) => i.priority);
        expect(priorities).toEqual([...priorities].sort((x, y) => x - y));
        for (const item of plan.items) {
          expect([1, 2, 3]).toContain(item.priority);
          for (const id of item.exerciseIds) expect(EXERCISE_IDS.has(id), id).toBe(true);
          expect(item.whatWeHeard.length).toBeGreaterThan(10);
          expect(item.whyItMatters.length).toBeGreaterThan(10);
          if (item.dimension !== 'recording' && item.dimension !== 'range') {
            expect(item.howToFix.length).toBeGreaterThanOrEqual(3);
            expect(item.howToFix.length).toBeLessThanOrEqual(5);
            expect(item.exerciseIds.length).toBeGreaterThan(0);
          }
        }
        expect(new Set(plan.items.map((i) => i.id)).size).toBe(plan.items.length);
        expect(plan.healthNotes.length).toBeGreaterThan(0);
        expect(plan.headline).toContain(p.name);
        expect(plan.headline).toMatch(/\d+\/100/);
        expect(plan.headline.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(3);
        expect(plan.nextTake.length).toBeGreaterThan(20);
        expect(plan.signatureFocus).toHaveLength(2);
        const moveIds = p.signatureMoves.map((m) => m.id);
        for (const f of plan.signatureFocus) {
          expect(moveIds).toContain(f.moveId);
          expect(f.hint.length).toBeGreaterThan(20);
        }
        expect(plan.signatureFocus[0].moveId).not.toBe(plan.signatureFocus[1].moveId);
        expect(plan.strengths.length).toBeLessThanOrEqual(4);
      }
    }
  });

  it('turns the biggest weighted gaps (score < 78) into items, highest first', () => {
    const a = makeFakeAnalysis(ROUGH);
    const c = compareToProfile(a, daniel);
    const plan = buildCoachingPlan(a, c, daniel);
    const expected = c.dimensions
      .filter((d) => d.value !== null && d.score < 78)
      .sort((x, y) => y.target.weight * (100 - y.score) - x.target.weight * (100 - x.score))
      .slice(0, 4)
      .map((d) => d.key);
    const dims = plan.items.filter((i) => i.dimension !== 'range' && i.dimension !== 'recording').map((i) => i.dimension);
    expect(dims).toEqual(expected.slice(0, dims.length));
    expect(dims.length).toBeGreaterThanOrEqual(3);
    expect(plan.items[0].priority).toBe(1);
  });

  it('only makes items for dimensions scoring below 78', () => {
    for (const p of SINGERS) {
      const a = makeFakeAnalysis(idealStyle(p));
      const plan = planFor(a, p);
      // The fake take's tessitura sits near all three singers' ranges; only range advice may appear.
      expect(plan.items.filter((i) => i.dimension !== 'range')).toEqual([]);
      expect(plan.strengths.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses singer-specific cues that depend on the direction', () => {
    const airy = planFor(makeFakeAnalysis({ breathiness: 0.25 }), daniel).items.find((i) => i.dimension === 'breathiness')!;
    expect(airy.title).toMatch(/air/i);
    expect(airy.howToFix.join(' ')).toMatch(/Daniel/);
    expect(airy.howToFix.join(' ')).toMatch(/"h"|close mic|mic/);
    expect(airy.exerciseIds).toContain('aspirate-onsets');

    const clear = planFor(makeFakeAnalysis({ breathiness: 0.8 }), jalen).items.find((i) => i.dimension === 'breathiness')!;
    expect(clear.title).toMatch(/clear/i);
    expect(clear.howToFix.join(' ')).toMatch(/Jalen/);
    expect(clear.howToFix.join(' ')).toMatch(/"nay"|"ng"/);
    expect(clear.exerciseIds[0]).toBe('soul-falsetto-forward');

    const head = planFor(makeFakeAnalysis({ headInUpperRange: 0.1, chestInUpperRange: 0.5, mixInUpperRange: 0.4 }), jalen).items.find(
      (i) => i.dimension === 'headInUpperRange',
    )!;
    expect(head.whyItMatters).toMatch(/Smokey Robinson/);
    expect(head.howToFix[0]).toMatch(/Jalen/);
  });

  it('adds a priority-1 recording item first when the analysis has warnings', () => {
    const a: VoiceAnalysis = { ...makeFakeAnalysis(ROUGH), warnings: ['The recording clips in places.', 'Background noise is high.'] };
    const plan = planFor(a, shawn);
    expect(plan.items[0].dimension).toBe('recording');
    expect(plan.items[0].priority).toBe(1);
    expect(plan.items[0].whatWeHeard).toContain('clips');
    expect(plan.items[0].howToFix.join(' ')).toMatch(/clip/);
    expect(plan.items[0].howToFix.join(' ')).toMatch(/quiet/);
    expect(plan.items.length).toBeLessThanOrEqual(5);
    expect(plan.headline).toMatch(/recording/);
    expect(plan.nextTake).toMatch(/Re-record/);
  });

  it('adds a range item when the key is 3+ semitones off, and keeps the plan at 5 items', () => {
    const base = makeFakeAnalysis(ROUGH);
    const low: VoiceAnalysis = {
      ...base,
      warnings: ['Too short.'],
      pitch: { ...base.pitch, tessituraLowMidi: 45, tessituraHighMidi: 50 },
    };
    const plan = planFor(low, jalen);
    const range = plan.items.find((i) => i.dimension === 'range')!;
    expect(range).toBeDefined();
    expect(range.title).toMatch(/lower/);
    expect(range.howToFix.join(' ')).toMatch(/octave/);
    expect(plan.items).toHaveLength(5);
    expect(plan.items.filter((i) => i.dimension !== 'range' && i.dimension !== 'recording')).toHaveLength(3);

    const near = planFor(makeFakeAnalysis(ROUGH), daniel); // transpose +1
    expect(near.items.find((i) => i.dimension === 'range')).toBeUndefined();
  });

  it('adds specific health notes for pushing, heavy chest, rasp and extreme dynamics', () => {
    const calm = planFor(makeFakeAnalysis({ ...idealStyle(daniel) }), daniel);
    expect(calm.healthNotes).toHaveLength(1);

    const notes = planFor(makeFakeAnalysis(ROUGH), shawn).healthNotes.join('\n');
    expect(notes).toMatch(/1\.8 dB per semitone/);
    expect(notes).toMatch(/85% of your singing above the passaggio read as chest/);
    expect(notes).toMatch(/rasp/);
    expect(notes).toMatch(/ENT/);
    expect(notes).toMatch(/São Paulo/);
    expect(notes).toMatch(/32 dB/);
    expect(notes).not.toMatch(/push (it |harder)|sing louder/i);
    // The Shawn anecdote belongs only in Shawn plans.
    expect(planFor(makeFakeAnalysis(ROUGH), daniel).healthNotes.join('\n')).not.toMatch(/São Paulo/);
  });

  it('names the two closest areas honestly when nothing is on-style yet', () => {
    const p = makeFakeProfile();
    const plan = planFor(makeFakeAnalysis({ breathiness: 0.95, brightness: 0.05, mixInUpperRange: 0, pitchAccuracyCents: 60 }), p);
    expect(plan.strengths).toHaveLength(2);
    for (const s of plan.strengths) expect(s).toMatch(/^Closest to Test so far/);
  });

  it('copes with a take where nothing could be measured', () => {
    const nulls = Object.fromEntries(STYLE_KEYS.map((k) => [k, null])) as Partial<StyleVector>;
    const a = makeFakeAnalysis(nulls);
    const plan = planFor(a, daniel);
    expect(plan.headline).toMatch(/couldn't measure/);
    expect(plan.items.filter((i) => i.dimension !== 'range')).toEqual([]);
    expect(plan.strengths).toEqual([]);
    expect(plan.healthNotes.length).toBeGreaterThan(0);
    expect(plan.signatureFocus).toHaveLength(2);
  });

  it('treats a reference profile built on a builtin as that singer, but names it "the reference"', () => {
    const ref: SingerProfile = { ...daniel, id: 'reference', name: 'best-part-vocals.wav', source: 'reference' };
    const plan = planFor(makeFakeAnalysis({ breathiness: 0.25 }), ref);
    expect(plan.profileId).toBe('reference');
    expect(plan.headline).toContain('the reference clip');
    const item = plan.items.find((i) => i.dimension === 'breathiness')!;
    expect(item.whatWeHeard).toContain('The reference target');
    expect(item.howToFix.join(' ')).toMatch(/Daniel/);
  });

  it('works for profiles without signature moves or builtin base', () => {
    const bare = makeFakeProfile({ signatureMoves: [], id: 'reference', source: 'reference', name: 'clip' });
    const plan = planFor(makeFakeAnalysis(ROUGH), bare);
    expect(plan.signatureFocus).toEqual([]);
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.nextTake.length).toBeGreaterThan(10);
  });

  it('personalises signature-move hints with the take\'s numbers', () => {
    const plan = planFor(makeFakeAnalysis({ headInUpperRange: 0.05, chestInUpperRange: 0.6, mixInUpperRange: 0.35 }), daniel);
    const hook = plan.signatureFocus.find((f) => f.moveId === 'daniel-falsetto-hook');
    expect(hook).toBeDefined();
    expect(hook!.hint).toMatch(/5%/);
    expect(hook!.hint).toMatch(/50%/);
  });
});
