import { describe, expect, it } from 'vitest';
import { FAKE_STYLE } from '../testing/fixtures';
import type { SingerProfile, StyleKey } from '../types';
import {
  MOVE_FOCUS,
  SINGERS,
  STYLE_KEYS,
  STYLE_LABELS,
  builtinBaseOf,
  formatStyleValue,
  getProfile,
  whoOf,
  whoseOf,
} from './profiles';

const ALL_KEYS = Object.keys(FAKE_STYLE) as StyleKey[];
const UNIT_INTERVAL_KEYS: StyleKey[] = [
  'breathiness',
  'brightness',
  'rasp',
  'vibratoPresence',
  'chestInUpperRange',
  'mixInUpperRange',
  'headInUpperRange',
  'softOnsetRatio',
];

function ideal(p: SingerProfile, key: StyleKey): number {
  const band = p.targets[key];
  if (!band) throw new Error(`${p.id} has no ${key} target`);
  return band.ideal;
}

const [shawn, daniel, jalen] = SINGERS;

describe('SINGERS', () => {
  it('lists the three builtin singers in order with their colours', () => {
    expect(SINGERS.map((s) => s.id)).toEqual(['shawn-mendes', 'daniel-caesar', 'jalen-ngonda']);
    expect(SINGERS.map((s) => s.color)).toEqual(['#b97a12', '#3a7556', '#b23c49']);
    for (const s of SINGERS) {
      expect(s.source).toBe('builtin');
      expect(s.sourceNote).toMatch(/not measurements/);
      expect(s.sourceNote).toMatch(/reference clip/);
      expect(s.tagline.length).toBeGreaterThan(10);
      expect(s.description.length).toBeGreaterThan(100);
      expect(s.traits.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('targets at least 11 dimensions each with well-formed bands', () => {
    for (const s of SINGERS) {
      const keys = Object.keys(s.targets) as StyleKey[];
      expect(keys.length, s.id).toBeGreaterThanOrEqual(11);
      for (const key of keys) {
        expect(ALL_KEYS).toContain(key);
        const b = s.targets[key]!;
        expect(b.low, `${s.id}.${key}`).toBeLessThanOrEqual(b.ideal);
        expect(b.ideal, `${s.id}.${key}`).toBeLessThanOrEqual(b.high);
        expect(b.high).toBeGreaterThan(b.low);
        expect(b.tolerance).toBeGreaterThan(0);
        expect(b.weight).toBeGreaterThan(0);
        expect(b.weight).toBeLessThanOrEqual(1);
        if (UNIT_INTERVAL_KEYS.includes(key)) {
          expect(b.low).toBeGreaterThanOrEqual(0);
          expect(b.high).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('always targets clean tuning and never asks for rasp', () => {
    for (const s of SINGERS) {
      expect(s.targets.pitchAccuracyCents).toMatchObject({ ideal: 5, low: 0, high: 15 });
      // A clean tone is always on-style, so no builtin profile can produce "add rasp" coaching.
      expect(s.targets.rasp?.low).toBe(0);
    }
  });

  it('has register ideals that sum to one', () => {
    for (const s of SINGERS) {
      const sum = ideal(s, 'chestInUpperRange') + ideal(s, 'mixInUpperRange') + ideal(s, 'headInUpperRange');
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('lists 4-6 study songs and 3-4 signature moves per singer', () => {
    for (const s of SINGERS) {
      expect(s.studySongs.length).toBeGreaterThanOrEqual(4);
      expect(s.studySongs.length).toBeLessThanOrEqual(6);
      for (const song of s.studySongs) {
        expect(song.title.length).toBeGreaterThan(0);
        expect(song.listenFor.length).toBeGreaterThan(40);
      }
      expect(s.signatureMoves.length).toBeGreaterThanOrEqual(3);
      expect(s.signatureMoves.length).toBeLessThanOrEqual(4);
      for (const m of s.signatureMoves) {
        expect(m.howTo.length).toBeGreaterThanOrEqual(3);
        expect(MOVE_FOCUS[m.id], m.id).toBeDefined();
      }
    }
    const moveIds = SINGERS.flatMap((s) => s.signatureMoves.map((m) => m.id));
    expect(new Set(moveIds).size).toBe(moveIds.length);
    expect(Object.keys(MOVE_FOCUS).sort()).toEqual([...moveIds].sort());
  });

  it('gives plausible, ordered ranges', () => {
    for (const s of SINGERS) {
      const r = s.typicalRange;
      expect(r.lowMidi).toBeLessThan(r.tessituraLowMidi);
      expect(r.tessituraLowMidi).toBeLessThan(r.tessituraHighMidi);
      expect(r.tessituraHighMidi).toBeLessThan(r.highMidi);
      expect(r.lowMidi).toBeGreaterThanOrEqual(40);
      expect(r.highMidi).toBeLessThanOrEqual(84);
    }
  });

  it('makes the three profiles meaningfully different', () => {
    // Air in the tone: Daniel's hushed delivery > Jalen's falsetto-led but clear tone > Shawn's clear chorus mix.
    expect(ideal(daniel, 'breathiness')).toBeGreaterThan(ideal(jalen, 'breathiness'));
    expect(ideal(jalen, 'breathiness')).toBeGreaterThan(ideal(shawn, 'breathiness'));
    // Brightness: Shawn's forward choruses > Jalen's ringing falsetto > Daniel's warm midrange.
    expect(ideal(shawn, 'brightness')).toBeGreaterThan(ideal(jalen, 'brightness'));
    expect(ideal(jalen, 'brightness')).toBeGreaterThan(ideal(daniel, 'brightness'));
    // Grit: Shawn (belt peaks) > Jalen (climax growls) > Daniel (clean).
    expect(ideal(shawn, 'rasp')).toBeGreaterThan(ideal(jalen, 'rasp'));
    expect(ideal(jalen, 'rasp')).toBeGreaterThan(ideal(daniel, 'rasp'));
    // Falsetto above the passaggio: Jalen > Daniel > Shawn; chest and mix the other way round.
    expect(ideal(jalen, 'headInUpperRange')).toBeGreaterThan(ideal(daniel, 'headInUpperRange'));
    expect(ideal(daniel, 'headInUpperRange')).toBeGreaterThan(ideal(shawn, 'headInUpperRange'));
    expect(ideal(shawn, 'chestInUpperRange')).toBeGreaterThan(Math.max(ideal(daniel, 'chestInUpperRange'), ideal(jalen, 'chestInUpperRange')));
    expect(ideal(shawn, 'mixInUpperRange')).toBeGreaterThan(ideal(daniel, 'mixInUpperRange'));
    expect(ideal(daniel, 'mixInUpperRange')).toBeGreaterThan(ideal(jalen, 'mixInUpperRange'));
    // Vibrato: Jalen's trembling falsetto uses it most and fastest; Daniel least and slowest.
    expect(ideal(jalen, 'vibratoPresence')).toBeGreaterThan(ideal(shawn, 'vibratoPresence'));
    expect(ideal(shawn, 'vibratoPresence')).toBeGreaterThan(ideal(daniel, 'vibratoPresence'));
    expect(ideal(jalen, 'vibratoRateHz')).toBeGreaterThan(ideal(shawn, 'vibratoRateHz'));
    expect(ideal(shawn, 'vibratoRateHz')).toBeGreaterThan(ideal(daniel, 'vibratoRateHz'));
    // Onsets and dynamics: Daniel starts airy and stays narrow; Shawn builds the widest.
    expect(ideal(daniel, 'softOnsetRatio')).toBeGreaterThan(ideal(jalen, 'softOnsetRatio'));
    expect(ideal(jalen, 'softOnsetRatio')).toBeGreaterThan(ideal(shawn, 'softOnsetRatio'));
    expect(ideal(shawn, 'dynamicRangeDb')).toBeGreaterThan(ideal(jalen, 'dynamicRangeDb'));
    expect(ideal(jalen, 'dynamicRangeDb')).toBeGreaterThan(ideal(daniel, 'dynamicRangeDb'));
    // Flips: Daniel's hooks flip most; the most defining dimension differs per singer.
    expect(ideal(daniel, 'flipsPerMinute')).toBeGreaterThan(Math.max(ideal(shawn, 'flipsPerMinute'), ideal(jalen, 'flipsPerMinute')));
    expect(shawn.targets.mixInUpperRange?.weight).toBe(1);
    expect(daniel.targets.breathiness?.weight).toBe(1);
    expect(jalen.targets.headInUpperRange?.weight).toBe(1);
    // Only Daniel targets run speed (gospel turns); the others are not runs singers.
    expect(daniel.targets.agility).toBeDefined();
    expect(shawn.targets.agility).toBeUndefined();
    expect(jalen.targets.agility).toBeUndefined();
  });
});

describe('getProfile / builtinBaseOf / names', () => {
  it('finds profiles by id', () => {
    expect(getProfile('daniel-caesar')).toBe(daniel);
    expect(getProfile('nobody')).toBeUndefined();
  });

  it('recognises a reference profile built on a builtin by its copied moves', () => {
    const ref: SingerProfile = { ...jalen, id: 'reference', name: 'clip.wav', source: 'reference' };
    expect(builtinBaseOf(ref)).toBe(jalen);
    expect(builtinBaseOf({ ...ref, signatureMoves: [] })).toBeUndefined();
  });

  it('names singers by first name and reference profiles generically', () => {
    expect(whoOf(shawn)).toBe('Shawn');
    expect(whoseOf(jalen)).toBe("Jalen's");
    expect(whoOf({ ...shawn, name: 'my clip.wav', source: 'reference' })).toBe('the reference');
  });
});

describe('STYLE_LABELS', () => {
  it('covers every StyleKey, and STYLE_KEYS lists each once', () => {
    expect([...STYLE_KEYS].sort()).toEqual([...ALL_KEYS].sort());
    expect(Object.keys(STYLE_LABELS).sort()).toEqual([...ALL_KEYS].sort());
    for (const key of ALL_KEYS) {
      const l = STYLE_LABELS[key];
      expect(l.label.length).toBeGreaterThan(0);
      expect(typeof l.unit).toBe('string');
      expect(l.lowWord.length).toBeGreaterThan(0);
      expect(l.highWord.length).toBeGreaterThan(0);
      for (const v of [0, 0.25, 0.5, 0.75, 1, 5.5, 30]) expect(l.describe(v).length).toBeGreaterThan(0);
    }
  });

  it('uses the documented units', () => {
    expect(STYLE_LABELS.breathiness.unit).toBe('');
    expect(STYLE_LABELS.mixInUpperRange.unit).toBe('%');
    expect(STYLE_LABELS.vibratoRateHz.unit).toBe('Hz');
    expect(STYLE_LABELS.vibratoExtentCents.unit).toBe('cents');
    expect(STYLE_LABELS.loudnessClimbDbPerSemitone.unit).toBe('dB/semitone');
    expect(STYLE_LABELS.dynamicRangeDb.unit).toBe('dB');
    expect(STYLE_LABELS.agility.unit).toBe('notes/s');
    expect(STYLE_LABELS.flipsPerMinute.unit).toBe('per min');
  });

  it('describes values in plain words that follow the StyleVector anchors', () => {
    expect(STYLE_LABELS.breathiness.describe(0.1)).toMatch(/pressed/);
    expect(STYLE_LABELS.breathiness.describe(0.4)).toBe('clear and balanced');
    expect(STYLE_LABELS.breathiness.describe(0.7)).toBe('quite airy');
    expect(STYLE_LABELS.breathiness.describe(0.95)).toMatch(/whisper/);
    expect(STYLE_LABELS.brightness.describe(0.2)).toMatch(/warm|dark/);
    expect(STYLE_LABELS.brightness.describe(0.8)).toMatch(/bright/);
    expect(STYLE_LABELS.rasp.describe(0.05)).toBe('clean');
    expect(STYLE_LABELS.rasp.describe(0.55)).toMatch(/rasp/);
    expect(STYLE_LABELS.vibratoRateHz.describe(5.5)).toBe('about 5.5 Hz');
    expect(STYLE_LABELS.vibratoExtentCents.describe(35)).toBe('about ±35 cents');
    expect(STYLE_LABELS.mixInUpperRange.describe(0.3)).toBe('30% mix');
    expect(STYLE_LABELS.agility.describe(0)).toBe('no runs');
    expect(STYLE_LABELS.loudnessClimbDbPerSemitone.describe(1.4)).toMatch(/^\+1\.4 dB per semitone, much louder/);
    expect(STYLE_LABELS.pitchAccuracyCents.describe(12.4)).toBe('about 12 cents off on average');
  });
});

describe('formatStyleValue', () => {
  it('formats each unit for humans', () => {
    expect(formatStyleValue('breathiness', 0.4)).toBe('0.40');
    expect(formatStyleValue('headInUpperRange', 0.664)).toBe('66%');
    expect(formatStyleValue('vibratoRateHz', 6)).toBe('6.0 Hz');
    expect(formatStyleValue('vibratoExtentCents', 28)).toBe('±28 cents');
    expect(formatStyleValue('loudnessClimbDbPerSemitone', 0.5)).toBe('+0.5 dB/semitone');
    expect(formatStyleValue('loudnessClimbDbPerSemitone', -0.02)).toBe('0.0 dB/semitone');
    expect(formatStyleValue('dynamicRangeDb', 13.6)).toBe('14 dB');
    expect(formatStyleValue('pitchAccuracyCents', 5)).toBe('5 cents');
    expect(formatStyleValue('flipsPerMinute', 2.5)).toBe('2.5 per min');
  });
});
