import { describe, expect, it } from 'vitest';
import { makeFakeAnalysis, makeFakeProfile } from '../testing/fixtures';
import type { SingerProfile, StyleKey, StyleVector, TargetBand, VoiceAnalysis } from '../types';
import { compareToProfile, directionFor, isScoreable, referencePassaggioLow, scoreDimension, singerPassaggioLow } from './compare';
import { SINGERS } from './profiles';
import { profileFromReference } from './reference';

/** Passaggio low notes of the app's voice types (analysis/passaggio.ts). */
const PASSAGGIO_LOW = { bass: 59, baritone: 62, tenor: 64, alto: 67, mezzo: 69, soprano: 71 } as const;

function withVoiceType(a: VoiceAnalysis, lowMidi: number): VoiceAnalysis {
  return { ...a, passaggio: { lowMidi, highMidi: lowMidi + 5 } };
}

const BAND: TargetBand = { ideal: 0.5, low: 0.4, high: 0.7, tolerance: 0.3, weight: 1 };

function idealStyle(p: SingerProfile): Partial<StyleVector> {
  const out: Partial<StyleVector> = {};
  for (const [k, b] of Object.entries(p.targets) as [StyleKey, TargetBand][]) out[k] = b.ideal;
  return out;
}

/** Each targeted dimension pushed well past the band edge furthest from the ideal. */
function oppositeStyle(p: SingerProfile): Partial<StyleVector> {
  const out: Partial<StyleVector> = {};
  for (const [k, b] of Object.entries(p.targets) as [StyleKey, TargetBand][]) {
    const goUp = b.ideal - b.low < b.high - b.ideal || b.low <= 0;
    out[k] = goUp ? b.high + 1.2 * b.tolerance : b.low - 1.2 * b.tolerance;
  }
  return out;
}

function withPitch(a: VoiceAnalysis, pitch: Partial<VoiceAnalysis['pitch']>): VoiceAnalysis {
  return { ...a, pitch: { ...a.pitch, ...pitch } };
}

describe('scoreDimension', () => {
  it('returns NaN for unmeasured values so callers can skip them', () => {
    expect(scoreDimension(null, BAND)).toBeNaN();
    expect(scoreDimension(NaN, BAND)).toBeNaN();
    expect(scoreDimension(Infinity, BAND)).toBeNaN();
  });

  it('scores 100 at the ideal and 80 at each band edge, linearly in between', () => {
    expect(scoreDimension(0.5, BAND)).toBe(100);
    expect(scoreDimension(0.4, BAND)).toBeCloseTo(80, 10);
    expect(scoreDimension(0.7, BAND)).toBeCloseTo(80, 10);
    expect(scoreDimension(0.45, BAND)).toBeCloseTo(90, 10);
    expect(scoreDimension(0.6, BAND)).toBeCloseTo(90, 10);
  });

  it('falls from 80 to 0 across the tolerance outside the band', () => {
    expect(scoreDimension(0.25, BAND)).toBeCloseTo(40, 10);
    expect(scoreDimension(0.85, BAND)).toBeCloseTo(40, 10);
    expect(scoreDimension(0.1, BAND)).toBeCloseTo(0, 10);
    expect(scoreDimension(1.0, BAND)).toBeCloseTo(0, 10);
    expect(scoreDimension(-5, BAND)).toBe(0);
  });

  it('handles an ideal sitting on a band edge', () => {
    const edge: TargetBand = { ideal: 0, low: 0, high: 15, tolerance: 25, weight: 1 };
    expect(scoreDimension(0, edge)).toBe(100);
    expect(scoreDimension(7.5, edge)).toBeCloseTo(90, 10);
    expect(scoreDimension(15, edge)).toBeCloseTo(80, 10);
    expect(scoreDimension(-1, edge)).toBeCloseTo(80 * (1 - 1 / 25), 10);
    const top: TargetBand = { ideal: 1, low: 0.6, high: 1, tolerance: 0.3, weight: 1 };
    expect(scoreDimension(1, top)).toBe(100);
    expect(scoreDimension(0.6, top)).toBeCloseTo(80, 10);
  });

  it('clamps an ideal outside the band and survives zero tolerance', () => {
    const odd: TargetBand = { ideal: 2, low: 0, high: 1, tolerance: 0, weight: 1 };
    expect(scoreDimension(1, odd)).toBe(100);
    expect(scoreDimension(0, odd)).toBeCloseTo(80, 10);
    expect(scoreDimension(1.01, odd)).toBe(0);
  });

  it('is continuous and falls monotonically away from the ideal', () => {
    const at = (i: number) => i / 1000 - 0.5;
    let prev = scoreDimension(at(0), BAND);
    for (let i = 1; i <= 2000; i++) {
      const v = at(i);
      const s = scoreDimension(v, BAND);
      expect(Math.abs(s - prev)).toBeLessThan(1);
      if (v <= BAND.ideal) expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      else if (at(i - 1) >= BAND.ideal) expect(s).toBeLessThanOrEqual(prev + 1e-9);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
      prev = s;
    }
  });
});

describe('directionFor', () => {
  it('says more below, less above, ok inside, unknown for null', () => {
    expect(directionFor(0.3, BAND)).toBe('more');
    expect(directionFor(0.8, BAND)).toBe('less');
    expect(directionFor(0.4, BAND)).toBe('ok');
    expect(directionFor(null, BAND)).toBe('unknown');
  });
});

describe('compareToProfile', () => {
  it('scores a take at a profile\'s ideals above 90 for that profile and lower for the others', () => {
    for (const p of SINGERS) {
      const a = makeFakeAnalysis(idealStyle(p));
      const own = compareToProfile(a, p).overall;
      expect(own, p.id).toBeGreaterThan(90);
      for (const other of SINGERS.filter((o) => o !== p)) {
        const theirs = compareToProfile(a, other).overall;
        expect(theirs, `${p.id} ideals vs ${other.id}`).toBeLessThan(own);
        // The profiles are distinct enough that one singer's ideal is not "very close" to another.
        expect(theirs, `${p.id} ideals vs ${other.id}`).toBeLessThan(85);
      }
    }
  });

  it('scores opposite extremes below 50', () => {
    for (const p of SINGERS) {
      expect(compareToProfile(makeFakeAnalysis(oppositeStyle(p)), p).overall, p.id).toBeLessThan(50);
    }
    // A pressed, bright, raspy, chest-heavy, pushed take is far from Daniel and Jalen.
    const belter = makeFakeAnalysis({
      breathiness: 0.1,
      brightness: 0.9,
      rasp: 0.55,
      vibratoPresence: 0,
      chestInUpperRange: 0.9,
      mixInUpperRange: 0.1,
      headInUpperRange: 0,
      loudnessClimbDbPerSemitone: 2,
      softOnsetRatio: 0,
      flipsPerMinute: 0,
      dynamicRangeDb: 30,
    });
    expect(compareToProfile(belter, SINGERS[1]).overall).toBeLessThan(50);
    expect(compareToProfile(belter, SINGERS[2]).overall).toBeLessThan(50);
  });

  it('returns one result per targeted key with direction, label and summary', () => {
    const p = SINGERS[1];
    const c = compareToProfile(makeFakeAnalysis(), p);
    expect(c.profileId).toBe(p.id);
    expect(c.dimensions.map((d) => d.key).sort()).toEqual(Object.keys(p.targets).sort());
    for (const d of c.dimensions) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.summary.length).toBeGreaterThan(10);
      // The flips band is widened for this short take (see below); every other band is the profile's own.
      if (d.key !== 'flipsPerMinute') expect(d.target).toBe(p.targets[d.key]);
      expect(Number.isInteger(d.score)).toBe(true);
    }
    const breath = c.dimensions.find((d) => d.key === 'breathiness')!;
    expect(breath.direction).toBe('more'); // 0.42 is clearer than Daniel's 0.55-0.82 band
    expect(breath.summary).toContain("Daniel's");
    expect(breath.summary).toContain('0.42');
    expect(breath.summary).toContain('0.68');
    const chest = c.dimensions.find((d) => d.key === 'chestInUpperRange')!;
    expect(chest.direction).toBe('less');
    expect(chest.summary).toContain('55%');
    const rate = c.dimensions.find((d) => d.key === 'vibratoRateHz')!;
    expect(rate.direction).toBe('ok');
    expect(rate.summary).toMatch(/5\.4 Hz/);
  });

  it('marks null values unknown, scores them 0 and leaves them out of the overall', () => {
    const p = makeFakeProfile();
    const a = makeFakeAnalysis({ mixInUpperRange: null });
    const c = compareToProfile(a, p);
    const mix = c.dimensions.find((d) => d.key === 'mixInUpperRange')!;
    expect(mix.value).toBeNull();
    expect(mix.direction).toBe('unknown');
    expect(mix.score).toBe(0);
    expect(mix.summary).toMatch(/Not measured/);
    expect(mix.summary).toMatch(/passaggio \(from D4\)/);
    const withoutMix = makeFakeProfile({ targets: { ...p.targets, mixInUpperRange: undefined } });
    expect(c.overall).toBe(compareToProfile(a, withoutMix).overall);
  });

  it('computes the overall as the weighted mean of measured dimensions', () => {
    const p = makeFakeProfile();
    const a = makeFakeAnalysis({ breathiness: 0.5, brightness: 0.2, mixInUpperRange: 0.5, pitchAccuracyCents: 5 });
    // breathiness 100 (w .8), brightness 80*(1-0.3/0.3)=0 (w .6), mix 100 (w 1), pitch 100 (w .5)
    const expected = Math.round((0.8 * 100 + 0.6 * 0 + 1 * 100 + 0.5 * 100) / (0.8 + 0.6 + 1 + 0.5));
    expect(compareToProfile(a, p).overall).toBe(expected);
  });

  it('returns 0 overall when nothing was measured', () => {
    const nulls = Object.fromEntries(Object.keys(makeFakeAnalysis().style).map((k) => [k, null])) as Partial<StyleVector>;
    const c = compareToProfile(makeFakeAnalysis(nulls), SINGERS[0]);
    expect(c.overall).toBe(0);
    expect(c.dimensions.every((d) => d.direction === 'unknown')).toBe(true);
  });

  it('bases the key suggestion on the voice type, not on the take', () => {
    const [shawn, daniel, jalen] = SINGERS;
    for (const p of SINGERS) expect(singerPassaggioLow(p)).toBe(64);
    const a = makeFakeAnalysis(); // baritone zone (D4), tessitura B3-F4
    const c = compareToProfile(a, shawn);
    expect(c.suggestedTransposeSemitones).toBe(-2);
    expect(c.rangeNote).toMatch(/^Based on your voice type, Shawn's songs should sit best about 2 semitones \(a whole step\) lower/);
    expect(c.rangeNote).toContain('passaggio starts around D4');
    expect(c.rangeNote).toContain('around E4');
    // The take's range is reported, but only as information.
    expect(c.rangeNote).toContain('This take sat mostly between B3 and F4');
    expect(c.rangeNote).toMatch(/not your whole range/);

    // Regression: a take that climbs through the passaggio (as the Guide suggests) used to produce
    // "+6 semitones" for a baritone. The take's pitch no longer moves the suggestion.
    const climbing = withPitch(a, { tessituraLowMidi: 62, tessituraHighMidi: 68, medianMidi: 65 });
    for (const p of [shawn, daniel, jalen]) expect(compareToProfile(climbing, p).suggestedTransposeSemitones).toBe(-2);
    const low = withPitch(a, { tessituraLowMidi: 45, tessituraHighMidi: 52 });
    expect(compareToProfile(low, jalen).suggestedTransposeSemitones).toBe(-2);
  });

  it('suggests a key per voice type, within a fifth and without octave jumps', () => {
    const expected = { bass: -5, baritone: -2, tenor: 0, alto: 3, mezzo: 5, soprano: 7 };
    for (const [vt, low] of Object.entries(PASSAGGIO_LOW) as [keyof typeof PASSAGGIO_LOW, number][]) {
      const c = compareToProfile(withVoiceType(makeFakeAnalysis(), low), SINGERS[1]);
      expect(c.suggestedTransposeSemitones, vt).toBe(expected[vt]);
      expect(c.rangeNote, vt).not.toMatch(/octave/);
    }
    const tenor = compareToProfile(withVoiceType(makeFakeAnalysis(), 64), SINGERS[0]);
    expect(tenor.rangeNote).toMatch(/Shawn's original keys should suit you/);
    const mezzo = compareToProfile(withVoiceType(makeFakeAnalysis(), 69), SINGERS[0]);
    expect(mezzo.rangeNote).toMatch(/about 5 semitones \(a fourth\) higher/);
    // Extreme zones are capped at a fifth.
    expect(compareToProfile(withVoiceType(makeFakeAnalysis(), 80), SINGERS[0]).suggestedTransposeSemitones).toBe(7);
    expect(compareToProfile(withVoiceType(makeFakeAnalysis(), 50), SINGERS[0]).suggestedTransposeSemitones).toBe(-7);
  });

  it('still gives voice-type advice without pitch data, and just leaves the take out', () => {
    const none = withPitch(makeFakeAnalysis(), { tessituraLowMidi: null, tessituraHighMidi: null, medianMidi: null, lowMidi: null, highMidi: null });
    const c = compareToProfile(none, SINGERS[0]);
    expect(c.suggestedTransposeSemitones).toBe(-2);
    expect(c.rangeNote).not.toMatch(/This take sat/);
    const median = withPitch(makeFakeAnalysis(), { tessituraLowMidi: null, tessituraHighMidi: null, medianMidi: 55 });
    expect(compareToProfile(median, SINGERS[0]).rangeNote).toContain('This take sat around G3');
  });

  it('reports take against clip only as information when no singer voice is known', () => {
    // A profile with no builtin behind it: the only basis is this take against its range.
    const custom = makeFakeProfile({ id: 'reference', source: 'reference', name: 'clip.wav', signatureMoves: [] }); // tessitura A3-G4
    expect(singerPassaggioLow(custom)).toBeNull();
    const a = withPitch(makeFakeAnalysis(), { tessituraLowMidi: 45, tessituraHighMidi: 52 }); // centre 48.5, clip 62
    const c = compareToProfile(a, custom);
    expect(c.suggestedTransposeSemitones).toBe(-13);
    expect(c.rangeNote).toMatch(/lower than the reference clip \(A3–G4\)/);
    expect(c.rangeNote).toMatch(/If you sang the same song/);
    expect(c.rangeNote).not.toMatch(/try them|should suit you/);
    const none = withPitch(makeFakeAnalysis(), { tessituraLowMidi: null, tessituraHighMidi: null, medianMidi: null });
    const empty = compareToProfile(none, custom);
    expect(empty.suggestedTransposeSemitones).toBe(0);
    expect(empty.rangeNote).toMatch(/not enough pitched singing/);
  });

  it('widens the flips band on short takes so one flip, or none, is on-style', () => {
    const [shawn, daniel, jalen] = SINGERS;
    // 12 s of singing: each flip is 5 per minute.
    const short = (flips: number) => ({ ...makeFakeAnalysis({ flipsPerMinute: flips }), voicedSec: 12 });
    for (const p of [shawn, daniel, jalen]) {
      for (const rate of [0, 5]) {
        const d = compareToProfile(short(rate), p).dimensions.find((x) => x.key === 'flipsPerMinute')!;
        expect(d.direction, `${p.id} ${rate}/min`).toBe('ok');
        expect(d.score).toBeGreaterThanOrEqual(80);
        expect(d.target.low).toBeLessThanOrEqual(d.target.ideal);
        expect(d.target.high).toBeGreaterThanOrEqual(d.target.ideal);
        expect(d.summary).not.toMatch(/Not measured/);
      }
      // Three flips in 12 s is still flagged.
      expect(compareToProfile(short(15), p).dimensions.find((x) => x.key === 'flipsPerMinute')!.direction).toBe('less');
    }
    // A long take is scored against the authored band.
    const long = { ...makeFakeAnalysis({ flipsPerMinute: 0 }), voicedSec: 90 };
    expect(compareToProfile(long, daniel).dimensions.find((x) => x.key === 'flipsPerMinute')!.target).toBe(daniel.targets.flipsPerMinute);
    expect(compareToProfile(long, daniel).dimensions.find((x) => x.key === 'flipsPerMinute')!.direction).toBe('more');
    // Shawn and Jalen flip once or twice a song, so no flip at all is on-style even on a long take.
    expect(compareToProfile(long, shawn).dimensions.find((x) => x.key === 'flipsPerMinute')!.direction).toBe('ok');
    expect(compareToProfile(long, jalen).dimensions.find((x) => x.key === 'flipsPerMinute')!.direction).toBe('ok');
  });

  it('talks about "the reference" for reference-clip profiles', () => {
    const ref: SingerProfile = { ...SINGERS[1], id: 'reference', name: 'my-clip.wav', source: 'reference' };
    const c = compareToProfile(makeFakeAnalysis(), ref);
    const breath = c.dimensions.find((d) => d.key === 'breathiness')!;
    expect(breath.summary).toContain("the reference's");
    expect(c.profileId).toBe('reference');
    // Built on Daniel's profile: key advice from the voice types, the clip's range as information.
    expect(c.suggestedTransposeSemitones).toBe(-2);
    // Named as the reference, with the assumption about the singer's voice spelled out.
    expect(c.rangeNote).toMatch(/the reference song should sit best about 2 semitones \(a whole step\) lower/);
    expect(c.rangeNote).toMatch(/assuming a voice like Daniel's \(if the artist's voice type differs, set it under "Analyse the reference as"\)/);
    expect(c.rangeNote).not.toMatch(/Daniel's songs/);
    expect(c.rangeNote).toMatch(/about 1 semitone \(a half step\) above the reference clip \(G3–G4\)/);
    // A clip that gave no measurements has only a stand-in range, which is never described as the clip's.
    const empty: SingerProfile = { ...ref, targets: {} };
    const e = compareToProfile(makeFakeAnalysis(), empty);
    expect(e.suggestedTransposeSemitones).toBe(-2);
    expect(e.rangeNote).not.toMatch(/reference clip/);
    const bare = compareToProfile(makeFakeAnalysis(), makeFakeProfile({ id: 'reference', source: 'reference', signatureMoves: [], targets: {} }));
    expect(bare.rangeNote).toBe('There was not enough singing in the reference clip to compare ranges with it.');
  });
});

describe('summaries that could contradict the rest of the page', () => {
  const [shawn, daniel] = SINGERS;
  const dim = (a: VoiceAnalysis, p: SingerProfile, key: StyleKey) => compareToProfile(a, p).dimensions.find((d) => d.key === key)!;

  it('says why vibrato speed and width are missing when held notes had no vibrato', () => {
    const straight = makeFakeAnalysis({ vibratoPresence: 0, vibratoRateHz: null, vibratoExtentCents: null });
    for (const key of ['vibratoRateHz', 'vibratoExtentCents'] as const) {
      expect(dim(straight, shawn, key).summary).toBe('Not measured in this take: none of the held notes had vibrato.');
    }
    const noHeld = makeFakeAnalysis({ vibratoPresence: null, vibratoRateHz: null, vibratoExtentCents: null });
    expect(dim(noHeld, shawn, 'vibratoRateHz').summary).toMatch(/no notes were held long enough/);
  });

  it('never calls a falling loudness slope "flatter" than a rising one', () => {
    const falling = dim(makeFakeAnalysis({ loudnessClimbDbPerSemitone: -1.3 }), shawn, 'loudnessClimbDbPerSemitone');
    expect(falling.direction).toBe('more');
    expect(falling.summary).toBe('-1.3 dB per semitone, getting quieter as you climb, where Shawn\'s usual climb is about +0.3 dB/semitone.');
    const steep = dim(makeFakeAnalysis({ loudnessClimbDbPerSemitone: 1.4 }), shawn, 'loudnessClimbDbPerSemitone');
    expect(steep.summary).toMatch(/a steeper rise than Shawn's usual climb/);
    for (const p of SINGERS) {
      for (const v of [-1.5, -0.8, 0, 1.2, 2]) {
        expect(dim(makeFakeAnalysis({ loudnessClimbDbPerSemitone: v }), p, 'loudnessClimbDbPerSemitone').summary).not.toMatch(/flatter/);
      }
    }
  });

  it('says "no runs" and "no register flips" for a clip that has none, not "0.0"', () => {
    const clip = makeFakeAnalysis({ agility: 0, flipsPerMinute: 0 });
    const ref = profileFromReference(clip, 'clip.wav', daniel);
    const fast = dim({ ...makeFakeAnalysis({ agility: 7.5, flipsPerMinute: 9 }), voicedSec: 90 }, ref, 'agility');
    expect(fast.summary).toBe('About 7.5 notes per second in runs, where the reference has no runs.');
    expect(dim(clip, ref, 'agility').summary).toBe('No runs, like the reference.');
    expect(dim(clip, ref, 'flipsPerMinute').summary).toBe('No register flips, like the reference.');
    const many = dim({ ...makeFakeAnalysis({ flipsPerMinute: 9 }), voicedSec: 90 }, ref, 'flipsPerMinute');
    expect(many.summary).toBe('About 9.0 flips per minute, where the reference has none.');
    // On a short take the band widens: one flip is on-style, and the summary says why.
    const one = dim({ ...makeFakeAnalysis({ flipsPerMinute: 5.1 }), voicedSec: 11.8 }, ref, 'flipsPerMinute');
    expect(one.direction).toBe('ok');
    expect(one.summary).toMatch(/The reference has none, but on a take this short a single flip reaches that rate\./);
    const aboveDaniel = dim({ ...makeFakeAnalysis({ flipsPerMinute: 5.1 }), voicedSec: 11.8 }, daniel, 'flipsPerMinute');
    expect(aboveDaniel.summary).toMatch(/above Daniel's usual rate \(about 2\.5 per min\), but on a take this short that is only one flip more/);
  });

  it('bases reference key advice on the voice type chosen for the clip, and names it the reference', () => {
    // The clip analysed as a mezzo (passaggio A4).
    const clip = withVoiceType(makeFakeAnalysis(), PASSAGGIO_LOW.mezzo);
    const chosen = profileFromReference(clip, 'clip.wav', shawn, { artistVoiceType: 'mezzo' });
    const assumed = profileFromReference(clip, 'clip.wav', shawn);
    expect(referencePassaggioLow(chosen)).toBe(69);
    expect(singerPassaggioLow(chosen)).toBe(69);
    expect(referencePassaggioLow(assumed)).toBeNull();
    expect(singerPassaggioLow(assumed)).toBe(64);
    // A builtin never carries a clip's passaggio.
    expect(referencePassaggioLow(shawn)).toBeNull();

    const mezzo = compareToProfile(withVoiceType(makeFakeAnalysis(), PASSAGGIO_LOW.mezzo), chosen);
    expect(mezzo.suggestedTransposeSemitones).toBe(0);
    expect(mezzo.rangeNote).toMatch(/^Based on your voice type, the reference song's original key should suit you/);
    const baritone = compareToProfile(makeFakeAnalysis(), chosen);
    expect(baritone.suggestedTransposeSemitones).toBe(-7);
    expect(baritone.rangeNote).toMatch(/the reference singer's voice changes gear around A4 \(from the voice type you chose for the clip\)/);
    for (const c of [mezzo, baritone]) expect(c.rangeNote).not.toMatch(/Shawn/);
    // Without a choice, the base singer's voice is assumed, and the note says how to change it.
    const fallback = compareToProfile(withVoiceType(makeFakeAnalysis(), PASSAGGIO_LOW.mezzo), assumed);
    expect(fallback.suggestedTransposeSemitones).toBe(5);
    expect(fallback.rangeNote).toMatch(/assuming a voice like Shawn's/);
  });
});

describe('isScoreable', () => {
  it('rejects takes with too little singing or accompaniment', () => {
    const a = makeFakeAnalysis();
    expect(isScoreable(a)).toBe(true);
    expect(isScoreable({ ...a, issues: ['too-little-singing'] })).toBe(false);
    expect(isScoreable({ ...a, issues: ['accompaniment', 'noisy'] })).toBe(false);
    // Recording-quality issues and speech-like takes are scored, with caveats in the plan.
    expect(isScoreable({ ...a, issues: ['noisy', 'clipping', 'too-quiet', 'speech-like', 'trimmed'] })).toBe(true);
  });

  it('never scores a full-song reading against tone targets, even without the accompaniment issue', () => {
    const a = makeFakeAnalysis();
    expect(isScoreable({ ...a, mode: 'mix', issues: [] })).toBe(false);
    expect(isScoreable({ ...a, mode: 'solo' })).toBe(true);
  });

  it('needs at least four measured dimensions when given a comparison', () => {
    const p = makeFakeProfile(); // four targets
    expect(isScoreable(makeFakeAnalysis(), compareToProfile(makeFakeAnalysis(), p))).toBe(true);
    const three = makeFakeAnalysis({ mixInUpperRange: null });
    expect(isScoreable(three, compareToProfile(three, p))).toBe(false);
    const nulls = Object.fromEntries(Object.keys(makeFakeAnalysis().style).map((k) => [k, null])) as Partial<StyleVector>;
    const empty = makeFakeAnalysis(nulls);
    expect(isScoreable(empty, compareToProfile(empty, SINGERS[0]))).toBe(false);
    // A reference profile resting on a single target can't score anything.
    const thin = makeFakeProfile({ targets: { pitchAccuracyCents: p.targets.pitchAccuracyCents } });
    expect(isScoreable(makeFakeAnalysis(), compareToProfile(makeFakeAnalysis(), thin))).toBe(false);
  });
});
