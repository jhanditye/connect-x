// End-to-end: three contrasting synthetic takes must produce StyleVectors that order sensibly.
// The measured vectors are printed with --silent=false (they are reported to the coach engineer
// as a sanity check for singer targets).

import { beforeAll, describe, expect, it } from 'vitest';
import { concat, silence, synthMelody, whiteNoise, type MelodyNote, type SynthOptions } from '../testing/synth';
import type { StyleVector, VoiceAnalysis } from '../types';
import { analyzeTake } from './analyze';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };
type Voice = Omit<SynthOptions, 'f0' | 'durationSec'>;

const notes = (midis: number[], durSec: number): MelodyNote[] => midis.map((midi) => ({ midi, durSec }));
const gap = (sec = 0.45) => silence(sec, SR);

/** Scales a phrase by a level ramp (dB) from start to end: a singer getting louder as they climb. */
function ramp(x: Float32Array, fromDb: number, toDb: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * Math.pow(10, (fromDb + ((toDb - fromDb) * i) / x.length) / 20);
  return out;
}

/** Chest-heavy, bright, slightly raspy: firm onsets, gets louder as it climbs through the passaggio. */
function chestHeavyTake(): Float32Array {
  const v: Voice = { sampleRate: SR, tiltDbPerOct: -7, subharmonic: 0.2, jitter: 0.01, shimmer: 0.05, vowel: 'a', attackSec: 0.004, amplitude: 0.6 };
  return concat(
    gap(0.3),
    ramp(synthMelody([...notes([55, 57, 59, 62, 64, 65], 0.5), { midi: 67, durSec: 1 }], v), -9, 0),
    gap(),
    ramp(synthMelody(notes([60, 62, 64, 67, 64, 62], 0.5), v), -6, -2),
    gap(),
    ramp(synthMelody([...notes([62, 64, 65, 67], 0.5), { midi: 69, durSec: 1.2 }], { ...v, seed: 11 }), -8, 0),
    gap(0.3),
  );
}

/** Breathy, dark falsetto with fast runs and aspirated onsets. */
function breathyFalsettoTake(): Float32Array {
  const v: Voice = { sampleRate: SR, tiltDbPerOct: -20, h1BoostDb: 10, breathNoise: 0.5, vowel: 'o', amplitude: 0.35 };
  const air = (seed: number) => whiteNoise(0.07, 0.012, SR, seed);
  return concat(
    gap(0.3),
    air(1),
    synthMelody([...notes([64, 66, 67, 69, 71, 69, 67, 66], 0.12), { midi: 64, durSec: 0.9 }], v),
    gap(),
    air(2),
    synthMelody(notes([67, 69, 71], 0.8), { ...v, seed: 5 }),
    gap(),
    air(3),
    synthMelody([...notes([71, 69, 67, 66, 64, 62, 64], 0.13), { midi: 62, durSec: 0.9 }], { ...v, seed: 9 }),
    gap(),
    air(4),
    synthMelody([...notes([62, 64, 66, 67, 69, 67], 0.12), { midi: 66, durSec: 1 }], { ...v, seed: 13 }),
    gap(0.3),
  );
}

/** Bright, clean chest/mix with 6 Hz vibrato on held notes, flipping into falsetto on the top notes. */
function vibratoFlipsTake(): Float32Array {
  const chest: Voice = { sampleRate: SR, tiltDbPerOct: -8, breathNoise: 0.03, vowel: 'a', amplitude: 0.5, releaseSec: 0.01 };
  const vib = { rateHz: 6, extentCents: 50, delaySec: 0.2 };
  const falsetto: Voice = { sampleRate: SR, tiltDbPerOct: -20, h1BoostDb: 10, breathNoise: 0.3, vowel: 'a', amplitude: 0.28, attackSec: 0.01, vibrato: vib };
  const flipPhrase = (low: number[], top: number, seed: number) =>
    concat(
      synthMelody([...notes(low.slice(0, -1), 0.4), { midi: low[low.length - 1], durSec: 1.1 }], { ...chest, vibrato: { ...vib, delaySec: 0.4 * (low.length - 1) + 0.2 }, seed }),
      synthMelody([{ midi: top, durSec: 1.3 }], { ...falsetto, seed: seed + 1 }),
    );
  return concat(
    gap(0.3),
    flipPhrase([57, 59, 62, 64], 69, 3),
    gap(),
    flipPhrase([55, 59, 62], 67, 7),
    gap(),
    flipPhrase([60, 62, 65], 71, 17),
    gap(0.3),
  );
}

const fmt = (s: StyleVector) =>
  Object.entries(s)
    .map(([k, v]) => `${k}=${v === null ? 'null' : Number(v).toFixed(2)}`)
    .join(' ');

describe('end-to-end style ordering on contrasting takes', () => {
  let takes: Record<'chestHeavy' | 'breathyFalsetto' | 'vibratoFlips', VoiceAnalysis>;
  let A: StyleVector;
  let B: StyleVector;
  let C: StyleVector;

  beforeAll(() => {
    takes = {
      chestHeavy: analyzeTake(chestHeavyTake(), SR, OPTS),
      breathyFalsetto: analyzeTake(breathyFalsettoTake(), SR, OPTS),
      vibratoFlips: analyzeTake(vibratoFlipsTake(), SR, OPTS),
    };
    A = takes.chestHeavy.style;
    B = takes.breathyFalsetto.style;
    C = takes.vibratoFlips.style;
    for (const [name, a] of Object.entries(takes)) console.log(`${name}: ${fmt(a.style)} | runs ${a.runs.length} | onsets ${a.onsets.map((o) => o.type).join(',')}`);
  });

  it('every take is analysable without recording warnings', () => {
    for (const a of Object.values(takes)) {
      expect(a.warnings).toEqual([]);
      expect(a.issues).toEqual([]);
      expect(a.voicedSec).toBeGreaterThan(7);
    }
  });

  it('breathiness: breathy falsetto >> the others', () => {
    expect(B.breathiness ?? 0).toBeGreaterThan((A.breathiness ?? 1) + 0.25);
    expect(B.breathiness ?? 0).toBeGreaterThan((C.breathiness ?? 1) + 0.2);
    expect(B.breathiness ?? 0).toBeGreaterThan(0.6);
  });

  it('brightness: chest-heavy and bright-clean > dark falsetto', () => {
    expect(A.brightness ?? 0).toBeGreaterThan((B.brightness ?? 1) + 0.3);
    expect(C.brightness ?? 0).toBeGreaterThan((B.brightness ?? 1) + 0.2);
    expect(A.brightness ?? 0).toBeGreaterThan(0.55);
  });

  it('rasp: only the chest-heavy take has grit', () => {
    expect(A.rasp ?? 0).toBeGreaterThan(0.15);
    expect(A.rasp ?? 0).toBeGreaterThan((B.rasp ?? 1) + 0.1);
    expect(B.rasp ?? 1).toBeLessThan(0.15);
    expect(C.rasp ?? 1).toBeLessThan(0.1);
  });

  it('vibrato: present in the vibrato take, absent elsewhere', () => {
    expect(C.vibratoPresence ?? 0).toBeGreaterThan(0.6);
    expect(C.vibratoRateHz ?? 0).toBeCloseTo(6, 0);
    expect(A.vibratoPresence ?? 1).toBeLessThan(0.2);
    expect(B.vibratoPresence ?? 1).toBeLessThan(0.2);
  });

  it('agility: only the take with runs', () => {
    expect(B.agility ?? 0).toBeGreaterThan(6);
    expect(takes.breathyFalsetto.runs.length).toBeGreaterThanOrEqual(3);
    expect(A.agility).toBe(0);
    expect(C.agility).toBe(0);
  });

  it('registers: head in the falsetto take, chest in the chest-heavy take, flips in the flip take', () => {
    expect(B.headInUpperRange ?? 0).toBeGreaterThan(0.8);
    expect(A.chestInUpperRange ?? 0).toBeGreaterThan(0.7);
    expect(A.headInUpperRange ?? 1).toBeLessThan(0.05);
    expect(C.headInUpperRange ?? 0).toBeGreaterThan((A.headInUpperRange ?? 1) + 0.3);
    expect(C.flipsPerMinute ?? 0).toBeGreaterThan(5);
    expect(A.flipsPerMinute).toBe(0);
    expect(A.loudnessClimbDbPerSemitone ?? 0).toBeGreaterThan((C.loudnessClimbDbPerSemitone ?? 0) + 0.5);
  });

  it('onsets: aspirated in the breathy take, firm in the chest-heavy take', () => {
    expect(B.softOnsetRatio ?? 0).toBeGreaterThan(0.7);
    expect(A.softOnsetRatio ?? 1).toBe(0);
    expect(takes.chestHeavy.onsets.every((o) => o.type === 'glottal')).toBe(true);
  });
});
