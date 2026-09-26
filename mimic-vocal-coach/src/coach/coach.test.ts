import { describe, expect, it } from 'vitest';
import { makeFakeAnalysis, makeFakeProfile } from '../testing/fixtures';
import { makeRng } from '../testing/synth';
import type { CoachingPlan, SingerProfile, StyleKey, StyleVector, TargetBand, VoiceAnalysis } from '../types';
import { FIXES, WHY, buildCoachingPlan } from './coach';
import { compareToProfile } from './compare';
import { EXERCISES, getExercise } from './exercises';
import { MOVE_FOCUS, SINGERS, STYLE_KEYS } from './profiles';
import { profileFromReference } from './reference';

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

function withZone(a: VoiceAnalysis, lowMidi: number): VoiceAnalysis {
  return { ...a, passaggio: { lowMidi, highMidi: lowMidi + 5 } };
}

const lowerFirst = (s: string): string => s[0].toLowerCase() + s.slice(1);

/** A plausible random StyleVector, seeded so failures reproduce. */
function randomStyle(rng: () => number): Partial<StyleVector> {
  const u = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const chest = u(0, 1);
  const head = u(0, 1 - chest);
  return {
    breathiness: u(0, 1),
    brightness: u(0, 1),
    rasp: u(0, 0.7),
    vibratoPresence: u(0, 1),
    vibratoRateHz: u(3.5, 7.5),
    vibratoExtentCents: u(5, 110),
    chestInUpperRange: chest,
    mixInUpperRange: 1 - chest - head,
    headInUpperRange: head,
    loudnessClimbDbPerSemitone: u(-1.5, 2.5),
    agility: rng() < 0.5 ? 0 : u(2, 11),
    dynamicRangeDb: u(4, 34),
    softOnsetRatio: u(0, 1),
    pitchAccuracyCents: u(2, 45),
    flipsPerMinute: u(0, 9),
  };
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
    const a: VoiceAnalysis = {
      ...makeFakeAnalysis(ROUGH),
      warnings: ['The recording clips in places.', 'Background noise is high.'],
      issues: ['clipping', 'noisy'],
    };
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

  it('adds a range item from the voice type when the key is 3+ semitones off, and keeps the plan at 5 items', () => {
    const bass: VoiceAnalysis = { ...withZone(makeFakeAnalysis(ROUGH), 59), warnings: ['Too short.'], issues: ['too-quiet'] };
    const plan = planFor(bass, jalen);
    const range = plan.items.find((i) => i.dimension === 'range')!;
    expect(range).toBeDefined();
    expect(range.title).toBe("Try Jalen's songs about 5 semitones lower");
    expect(range.whatWeHeard).toMatch(/Based on your voice type/);
    expect(range.whyItMatters).toMatch(/voice type puts your passaggio about 5 semitones below Jalen's/);
    expect(range.howToFix.join(' ')).toMatch(/voice type in Settings/);
    expect(range.howToFix.join(' ')).toMatch(/around B3–E4/);
    expect(range.howToFix.join(' ')).not.toMatch(/octave/);
    expect(plan.items).toHaveLength(5);
    expect(plan.items.filter((i) => i.dimension !== 'range' && i.dimension !== 'recording')).toHaveLength(3);

    const mezzo = planFor(withZone(makeFakeAnalysis(idealStyle(shawn)), 69), shawn);
    expect(mezzo.items.find((i) => i.dimension === 'range')?.title).toBe("Try Shawn's songs about 5 semitones higher");
    expect(mezzo.headline).toMatch(/Based on your voice type, also try Shawn's songs about 5 semitones higher\./);

    // Baritone (2 semitones below the singers) and tenor: the note explains it, no item.
    expect(planFor(makeFakeAnalysis(ROUGH), daniel).items.find((i) => i.dimension === 'range')).toBeUndefined();
    expect(planFor(withZone(makeFakeAnalysis(ROUGH), 64), daniel).items.find((i) => i.dimension === 'range')).toBeUndefined();
  });

  it('never tells a baritone to raise the key because the take climbed through the passaggio', () => {
    // Regression: the demo take (tessitura D4-G#4) used to produce "Try the songs about 6 semitones higher".
    const base = makeFakeAnalysis(idealStyle(shawn));
    const climbing: VoiceAnalysis = { ...base, pitch: { ...base.pitch, tessituraLowMidi: 62, tessituraHighMidi: 68, medianMidi: 65 } };
    for (const p of SINGERS) {
      const plan = planFor(climbing, p);
      expect(plan.items.find((i) => i.dimension === 'range'), p.id).toBeUndefined();
      expect(allText(plan)).not.toMatch(/semitones higher/);
    }
  });

  it('adds specific health notes for pushing, heavy chest, rasp and extreme dynamics', () => {
    const calm = planFor(makeFakeAnalysis({ ...idealStyle(daniel) }), daniel);
    // Two general notes on every plan: warm-up and rest, and what to do about a sudden loss of voice.
    expect(calm.healthNotes).toHaveLength(2);
    expect(calm.healthNotes[1]).toMatch(/suddenly cuts out, loses its top notes/);
    expect(calm.healthNotes[1]).toMatch(/laryngologist/);
    expect(calm.healthNotes[1]).toMatch(/within a few days/);

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
    expect(plan.headline).toMatch(/couldn't measure enough of this take to compare it with Daniel Caesar \(0 of 15 style measures\)/);
    expect(plan.headline).not.toMatch(/\d+\/100/);
    expect(plan.items.map((i) => i.dimension)).toEqual(['recording']);
    expect(plan.items[0].title).toBe('Record a take we can measure');
    expect(plan.items[0].howToFix.length).toBeGreaterThanOrEqual(3);
    expect(plan.strengths).toEqual([]);
    expect(plan.signatureFocus).toEqual([]);
    expect(plan.healthNotes).toHaveLength(2);
    expect(plan.nextTake).toMatch(/20 to 30 seconds/);
  });

  it('turns an unscoreable take into a re-record plan that says why', () => {
    const rough = makeFakeAnalysis(ROUGH);
    const band: VoiceAnalysis = { ...rough, warnings: ['This sounds like singing over instruments.'], issues: ['accompaniment', 'noisy'] };
    const plan = planFor(band, shawn);
    expect(plan.headline).toMatch(/singing over instruments, so we can't score it against Shawn Mendes/);
    expect(plan.headline).toMatch(/a cappella/);
    expect(plan.items.map((i) => i.dimension)).toEqual(['recording']);
    expect(plan.items[0].title).toBe('Record your voice on its own');
    expect(plan.items[0].howToFix[0]).toMatch(/a cappella|headphones/);
    // With a band in the take, "background noise" is the band: no "quiet room" advice.
    expect(plan.items[0].howToFix.join(' ')).not.toMatch(/soft-furnished room/);
    expect(plan.items[0].whatWeHeard).not.toMatch(/style measures/);
    expect(plan.strengths).toEqual([]);
    expect(plan.signatureFocus).toEqual([]);
    // Only the general notes: the take's numbers describe the band, not the singer.
    expect(plan.healthNotes).toHaveLength(2);
    expect(plan.nextTake).toMatch(/voice alone/);

    const short: VoiceAnalysis = { ...rough, voicedSec: 1.4, warnings: ['Only 1.4 s of singing was detected.'], issues: ['too-little-singing'] };
    const shortPlan = planFor(short, jalen);
    expect(shortPlan.headline).toMatch(/couldn't hear enough singing in this take to compare it with Jalen Ngonda \(about 1\.4 s of singing\)/);
    expect(shortPlan.items.map((i) => i.id)).toEqual(['recording']);
    expect(shortPlan.items[0].howToFix[0]).toMatch(/20 to 30 seconds/);
  });

  it('blames the reference clip, not the take, when the clip gave almost no targets', () => {
    const nulls = Object.fromEntries(STYLE_KEYS.map((k) => [k, null])) as Partial<StyleVector>;
    const noise = { ...makeFakeAnalysis(nulls), voicedSec: 0 };
    const ref = profileFromReference(noise, 'noise.wav', shawn);
    const plan = planFor(makeFakeAnalysis(), ref);
    expect(plan.headline).toMatch(/reference clip gave too little measurable singing/);
    expect(plan.headline).not.toMatch(/\d+\/100|very close/);
    expect(plan.items.map((i) => i.title)).toEqual(['Use a clearer reference clip']);
    expect(plan.items[0].whatWeHeard).toBe('No style measures could be taken from the reference clip.');
  });

  it('scores a speech-like take but leads with the recording and a caveat', () => {
    const a: VoiceAnalysis = { ...makeFakeAnalysis(ROUGH), warnings: ['We heard only short, speech-like sounds.'], issues: ['speech-like'] };
    const plan = planFor(a, shawn);
    expect(plan.headline).toMatch(/\d+\/100/);
    expect(plan.headline).toMatch(/speech-like syllables, so treat these numbers with caution/);
    expect(plan.items[0].dimension).toBe('recording');
    expect(plan.items[0].howToFix[0]).toMatch(/held notes/);
    expect(plan.items[0].whyItMatters).toMatch(/held notes/);
    expect(plan.nextTake).toMatch(/held notes/);
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

  it('never coaches a level-volume singer toward getting louder for Shawn', () => {
    // Regression: 0 dB/semitone used to be Shawn's priority-1 "Let the high notes bloom".
    const plan = planFor(makeFakeAnalysis({ ...idealStyle(shawn), loudnessClimbDbPerSemitone: 0 }), shawn);
    expect(plan.items).toEqual([]);
    expect(plan.headline).toMatch(/Every measured dimension is close/);
    for (const v of [-0.2, 0, 0.1, 0.3, 0.6]) {
      const items = planFor(makeFakeAnalysis({ ...idealStyle(shawn), loudnessClimbDbPerSemitone: v }), shawn).items;
      expect(items.find((i) => i.dimension === 'loudnessClimbDbPerSemitone'), `${v}`).toBeUndefined();
    }
  });

  it('never coaches toward rasp, heavy chest or a pushing climb, even for a belted reference clip', () => {
    // A full mix reads as raspy, chest-heavy and climbing; a healthy user is below all three.
    const clip = makeFakeAnalysis({ rasp: 0.5, loudnessClimbDbPerSemitone: 1.6, chestInUpperRange: 0.85, mixInUpperRange: 0.1, headInUpperRange: 0.05 });
    const ref = profileFromReference(clip, 'Stitches (my clip)', shawn);
    for (const user of [
      makeFakeAnalysis({ rasp: 0.03, loudnessClimbDbPerSemitone: 1.05, chestInUpperRange: 0.62, mixInUpperRange: 0.3, headInUpperRange: 0.08 }),
      makeFakeAnalysis({ rasp: 0.02, loudnessClimbDbPerSemitone: 0.3, chestInUpperRange: 0.3, mixInUpperRange: 0.5, headInUpperRange: 0.2 }),
    ]) {
      const plan = planFor(user, ref);
      const ids = plan.items.map((i) => i.id);
      expect(ids).not.toContain('rasp-more');
      expect(ids).not.toContain('loudnessClimbDbPerSemitone-more');
      expect(allText(plan)).not.toMatch(/Add texture|Let the high notes bloom/);
      // "Less mix" would mean "release into falsetto", which contradicts a chest-more item.
      if (ids.includes('chestInUpperRange-more')) expect(ids).not.toContain('mixInUpperRange-less');
    }

    // Backstop for any profile: a target asking for grit is never coached, and the headline says so.
    const gritty: SingerProfile = {
      ...shawn,
      id: 'reference',
      source: 'reference',
      name: 'raw.wav',
      targets: { ...shawn.targets, rasp: { ideal: 0.5, low: 0.4, high: 0.6, tolerance: 0.25, weight: 0.5 } },
    };
    const plan = planFor(makeFakeAnalysis({ ...idealStyle(shawn), rasp: 0.02 }), gritty);
    expect(plan.items.find((i) => i.dimension === 'rasp')).toBeUndefined();
    expect(plan.headline).toMatch(/we won't coach you toward more rasp/);
  });

  it('never contradicts its own health notes (random takes against builtin and reference profiles)', () => {
    const rng = makeRng(11);
    for (let n = 0; n < 150; n++) {
      const base = SINGERS[n % 3];
      const profiles = [base, profileFromReference(makeFakeAnalysis(randomStyle(rng)), 'clip', base)];
      const a = makeFakeAnalysis(randomStyle(rng));
      for (const p of profiles) {
        const plan = planFor(a, p);
        const ids = plan.items.map((i) => i.id);
        const notes = plan.healthNotes.join(' ');
        expect(ids).not.toContain('rasp-more');
        if (/dB per semitone above the passaggio/.test(notes)) expect(ids).not.toContain('loudnessClimbDbPerSemitone-more');
        if (/read as chest\. Carrying heavy chest/.test(notes)) expect(ids).not.toContain('chestInUpperRange-more');
        const chestMore = plan.items.find((i) => i.id === 'chestInUpperRange-more');
        if (chestMore) expect(compareToProfile(a, p).dimensions.find((d) => d.key === 'chestInUpperRange')!.target.ideal).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it('recommends signature moves only for the direction they train', () => {
    const rng = makeRng(5);
    let hints = 0;
    for (let n = 0; n < 200; n++) {
      const p = SINGERS[n % 3];
      const plan = planFor(makeFakeAnalysis(randomStyle(rng)), p);
      for (const f of plan.signatureFocus) {
        for (const [key, dir] of Object.entries(MOVE_FOCUS[f.moveId]) as [StyleKey, 'more' | 'less'][]) {
          const opposite = dir === 'more' ? 'less' : 'more';
          expect(f.hint, `${f.moveId}`).not.toContain(`Use this move to ${lowerFirst(FIXES[key][opposite].title)}`);
          if (f.hint.includes(`Use this move to ${lowerFirst(FIXES[key][dir].title)}`)) hints++;
        }
      }
    }
    expect(hints).toBeGreaterThan(50);

    // The verifier's cases: each used to recommend a move for the opposite of what it trains.
    const cases: [SingerProfile, Partial<StyleVector>, string][] = [
      [shawn, { brightness: 0.9 }, 'shawn-bright-chest-mix'],
      [daniel, { headInUpperRange: 0.86, mixInUpperRange: 0.1, chestInUpperRange: 0.04 }, 'daniel-falsetto-hook'],
      [shawn, { headInUpperRange: 0.6, mixInUpperRange: 0.2, chestInUpperRange: 0.2 }, 'shawn-falsetto-contrast'],
      [daniel, { breathiness: 0.95 }, 'daniel-hushed-close-mic'],
    ];
    for (const [p, over, moveId] of cases) {
      const plan = planFor(makeFakeAnalysis({ ...idealStyle(p), ...over }), p);
      const hint = plan.signatureFocus.find((f) => f.moveId === moveId)?.hint;
      if (hint) expect(hint, moveId).toMatch(/save it for later|leave this move/);
    }
    // Jalen's chest wail is held back for a take that already carries too much chest.
    const heavy = planFor(makeFakeAnalysis({ ...idealStyle(jalen), chestInUpperRange: 0.5, mixInUpperRange: 0.3, headInUpperRange: 0.2 }), jalen);
    const wail = heavy.signatureFocus.find((f) => f.moveId === 'jalen-chest-wail');
    if (wail) expect(wail.hint).not.toMatch(/Use this move to lighten/);
  });

  it('never prescribes drills that pull against what the take needs', () => {
    const rng = makeRng(23);
    for (let n = 0; n < 200; n++) {
      const p = SINGERS[n % 3];
      const a = { ...makeFakeAnalysis(randomStyle(rng)), voicedSec: 90 };
      const c = compareToProfile(a, p);
      const plan = buildCoachingPlan(a, c, p);
      const dir = (k: StyleKey) => c.dimensions.find((d) => d.key === k)?.direction;
      const ids = plan.items.flatMap((i) => i.exerciseIds);
      if (dir('flipsPerMinute') === 'less') expect(ids).not.toContain('falsetto-flip-leap');
      if (dir('flipsPerMinute') === 'more') expect(ids).not.toContain('blended-leap');
      if (dir('breathiness') === 'less') expect(ids).not.toContain('airy-falsetto-float');
      if (dir('softOnsetRatio') === 'less') expect(ids).not.toContain('aspirate-onsets');
      for (const item of plan.items) if (item.dimension !== 'recording' && item.dimension !== 'range') expect(item.exerciseIds.length).toBeGreaterThan(0);
    }
  });

  it('does not flag one deliberate flip on a short take as register breaks', () => {
    // Regression: the demo (one flip in ~12 s of singing = 5 per minute) got "Smooth out register breaks".
    for (const p of SINGERS) {
      const a = { ...makeFakeAnalysis({ ...idealStyle(p), flipsPerMinute: 5.07 }), voicedSec: 11.8 };
      expect(planFor(a, p).items.find((i) => i.dimension === 'flipsPerMinute'), p.id).toBeUndefined();
    }
  });

  it('calls the light upper register head voice in generic copy for higher voice types', () => {
    const style = { ...idealStyle(daniel), flipsPerMinute: 0, headInUpperRange: 0.1, mixInUpperRange: 0.35, chestInUpperRange: 0.55 };
    const mezzo = planFor({ ...withZone(makeFakeAnalysis(style), 69), voicedSec: 90 }, daniel);
    const head = mezzo.items.find((i) => i.dimension === 'headInUpperRange')!;
    expect(head.title).toBe('Let high notes float into head voice');
    expect(head.whatWeHeard).toMatch(/read as head voice\./);
    // Generic cues follow the voice type; the singer's own cue (about Daniel) keeps "falsetto".
    expect(head.howToFix.slice(1).join(' ')).not.toMatch(/falsetto/);
    const flips = mezzo.items.find((i) => i.dimension === 'flipsPerMinute');
    if (flips) expect(flips.title).toBe('Use an intentional flip into head voice');
    const baritone = planFor({ ...makeFakeAnalysis(style), voicedSec: 90 }, daniel);
    expect(baritone.items.find((i) => i.dimension === 'headInUpperRange')!.title).toBe('Let high notes float into falsetto');
  });

  it('writes singer cues as actions rather than repeating why it matters', () => {
    const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
    const shared = (a: string, b: string, n = 5): string | null => {
      const A = words(a);
      const grams = new Set<string>();
      for (let i = 0; i + n <= A.length; i++) grams.add(A.slice(i, i + n).join(' '));
      const B = words(b);
      for (let j = 0; j + n <= B.length; j++) if (grams.has(B.slice(j, j + n).join(' '))) return B.slice(j, j + n).join(' ');
      return null;
    };
    for (const key of STYLE_KEYS) {
      for (const dir of ['more', 'less'] as const) {
        for (const [flavour, cues] of Object.entries(FIXES[key][dir].singerCues ?? {}) as [keyof (typeof WHY)[StyleKey], string[]][]) {
          for (const cue of cues) expect(shared(cue, WHY[key][flavour]), `${key}/${dir}/${flavour}: ${cue}`).toBeNull();
        }
      }
    }
  });

  it('keeps the mic distance steady in coaching copy', () => {
    const cues = STYLE_KEYS.flatMap((k) => (['more', 'less'] as const).flatMap((d) => [...FIXES[k][d].cues, ...Object.values(FIXES[k][d].singerCues ?? {}).flat()]));
    const steps = EXERCISES.flatMap((e) => e.steps);
    for (const t of [...cues, ...steps]) expect(t).not.toMatch(/hand's width|closer to the mic|close mic|mic or phone close/);
    const quiet = planFor({ ...makeFakeAnalysis(), warnings: ['The level is very low.'], issues: ['too-quiet'] }, shawn);
    expect(quiet.items[0].howToFix.join(' ')).toMatch(/20 to 30 cm .*same distance for every take/);
  });

  it('personalises signature-move hints with the take\'s numbers', () => {
    const plan = planFor(makeFakeAnalysis({ headInUpperRange: 0.05, chestInUpperRange: 0.6, mixInUpperRange: 0.35 }), daniel);
    const hook = plan.signatureFocus.find((f) => f.moveId === 'daniel-falsetto-hook');
    expect(hook).toBeDefined();
    expect(hook!.hint).toMatch(/5%/);
    expect(hook!.hint).toMatch(/50%/);
  });
});
