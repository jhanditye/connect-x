import { describe, expect, it } from 'vitest';
import { concat, silence, synthMelody, type SynthOptions, type Vowel } from '../testing/synth';
import { analyzeTake } from './analyze';
import { breathinessIndex, brightnessFromSlope, raspIndex } from './style';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };
/** G3-D4, the range the calibration anchors were set on. */
const MELODY = [55, 57, 59, 60, 62, 60].map((midi) => ({ midi, durSec: 0.5 }));

function styleOf(voice: Partial<SynthOptions>, vowel: Vowel = 'a') {
  const x = concat(silence(0.3, SR), synthMelody(MELODY, { sampleRate: SR, vowel, ...voice }), silence(0.3, SR));
  return analyzeTake(x, SR, OPTS).style;
}

describe('per-frame index functions', () => {
  it('breathiness rises with H1-H2 and aspiration and stays in 0..1', () => {
    expect(breathinessIndex(4, 0)).toBeLessThan(breathinessIndex(10, 0));
    expect(breathinessIndex(10, 0)).toBeLessThan(breathinessIndex(10, 0.5));
    expect(breathinessIndex(14, 0)).toBeLessThan(breathinessIndex(20, 0));
    expect(breathinessIndex(-20, 0)).toBeCloseTo(breathinessIndex(-10, 0), 9);
    expect(breathinessIndex(-20, 0)).toBeGreaterThan(0.1);
    expect(breathinessIndex(60, 1)).toBe(1);
    expect(breathinessIndex(NaN, 0)).toBeNaN();
  });

  it('breathiness is anchored on real voices: clean modal singing reads "clear, balanced"', () => {
    // Real a cappella singing measured normalised H1-H2 of about -2.5 to +6 dB with no aspiration.
    for (const h of [-1, 0, 3, 6]) {
      expect(breathinessIndex(h, 0), `H ${h}`).toBeGreaterThanOrEqual(0.28);
      expect(breathinessIndex(h, 0), `H ${h}`).toBeLessThanOrEqual(0.42);
    }
    // A breathy real voice: higher H1-H2 and aspiration noise.
    expect(breathinessIndex(12, 0.4)).toBeGreaterThanOrEqual(0.6);
    expect(breathinessIndex(12, 0.4)).toBeLessThanOrEqual(0.8);
  });

  it('brightness is monotonic in the harmonic slope', () => {
    const vals = [-30, -16, -10, -4.8, -2.6, 0, 5].map(brightnessFromSlope);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
    expect(brightnessFromSlope(-4.8)).toBeCloseTo(0.5, 5);
    expect(vals[0]).toBeGreaterThan(0);
    expect(vals[vals.length - 1]).toBeLessThan(1);
  });

  it('rasp needs subharmonics and is discounted by breath', () => {
    expect(raspIndex(-60, 0.5, 20, 0)).toBe(0);
    expect(raspIndex(-15, 0.4, 10, 0)).toBeGreaterThan(0.9);
    expect(raspIndex(-15, 0.99, 1, 0)).toBeLessThan(0.35);
    expect(raspIndex(-25, 0.6, 3, 0.8)).toBeLessThan(raspIndex(-25, 0.6, 3, 0));
  });
});

describe('calibration anchors on the synthesiser (vowel /a/, G3-D4)', () => {
  it('breathiness keeps the synthesiser order: pressed ~0.44 < modal ~0.52 < breathy ~0.8 < whisper > 0.88', () => {
    // The absolute level is anchored on real voices (see breathinessIndex); the synthesiser's
    // source has a stronger H1 than a real voice, so its settings read higher than their names.
    const pressed = styleOf({ tiltDbPerOct: -6 }).breathiness ?? NaN;
    const modal = styleOf({ tiltDbPerOct: -12 }).breathiness ?? NaN;
    const breathy = styleOf({ tiltDbPerOct: -16, h1BoostDb: 6, breathNoise: 0.6 }).breathiness ?? NaN;
    const whisper = styleOf({ tiltDbPerOct: -16, breathNoise: 1.5 }).breathiness ?? NaN;
    expect(pressed).toBeGreaterThanOrEqual(0.38);
    expect(pressed).toBeLessThanOrEqual(0.5);
    expect(modal).toBeGreaterThanOrEqual(0.46);
    expect(modal).toBeLessThanOrEqual(0.58);
    expect(modal).toBeGreaterThan(pressed + 0.04);
    expect(breathy).toBeGreaterThanOrEqual(0.72);
    expect(breathy).toBeLessThanOrEqual(0.88);
    expect(breathy).toBeGreaterThan(modal + 0.2);
    expect(whisper).toBeGreaterThan(0.88);
    expect(whisper).toBeGreaterThan(breathy);
  });

  it('brightness: tilt -6 ~0.75-0.85, -12 ~0.45-0.55, -20 ~0.15-0.25', () => {
    const b6 = styleOf({ tiltDbPerOct: -6 }).brightness ?? NaN;
    const b12 = styleOf({ tiltDbPerOct: -12 }).brightness ?? NaN;
    const b20 = styleOf({ tiltDbPerOct: -20 }).brightness ?? NaN;
    expect(b6).toBeGreaterThanOrEqual(0.75);
    expect(b6).toBeLessThanOrEqual(0.85);
    expect(b12).toBeGreaterThanOrEqual(0.45);
    expect(b12).toBeLessThanOrEqual(0.55);
    expect(b20).toBeGreaterThanOrEqual(0.15);
    expect(b20).toBeLessThanOrEqual(0.25);
  });

  it('brightness is judged on the harmonics, so breath noise does not brighten a dark tone', () => {
    const clean = styleOf({ tiltDbPerOct: -18, h1BoostDb: 8 }).brightness ?? NaN;
    const airy = styleOf({ tiltDbPerOct: -18, h1BoostDb: 8, breathNoise: 0.6 }).brightness ?? NaN;
    expect(airy).toBeLessThan(clean + 0.1);
    expect(airy).toBeLessThan(0.4);
  });

  it('rasp: clean < 0.1, subharmonic 0.4 + jitter > 0.5, breathy-but-clean < 0.3', () => {
    expect(styleOf({ tiltDbPerOct: -12 }).rasp ?? NaN).toBeLessThan(0.1);
    expect(styleOf({ tiltDbPerOct: -12, jitter: 0.005 }).rasp ?? NaN).toBeLessThan(0.1);
    expect(styleOf({ tiltDbPerOct: -9, subharmonic: 0.4, jitter: 0.02, shimmer: 0.08 }).rasp ?? NaN).toBeGreaterThan(0.5);
    expect(styleOf({ tiltDbPerOct: -16, h1BoostDb: 6, breathNoise: 0.6 }).rasp ?? NaN).toBeLessThan(0.3);
    expect(styleOf({ tiltDbPerOct: -20, h1BoostDb: 10, breathNoise: 0.35 }).rasp ?? NaN).toBeLessThan(0.3);
    const mild = styleOf({ tiltDbPerOct: -9, subharmonic: 0.2, jitter: 0.01, shimmer: 0.04 }).rasp ?? NaN;
    expect(mild).toBeGreaterThan(0.15);
    expect(mild).toBeLessThan(0.5);
  });

  it('a rounder vowel reads darker', () => {
    const a = styleOf({ tiltDbPerOct: -10 }, 'a').brightness ?? NaN;
    const o = styleOf({ tiltDbPerOct: -10 }, 'o').brightness ?? NaN;
    expect(o).toBeLessThan(a);
  });
});

describe('pitch accuracy', () => {
  it('is judged on held notes (0.4 s or longer), not on syllables and passing notes', () => {
    const tune = (durSec: number) =>
      [55, 57, 59, 60, 62, 60, 59, 57, 55, 57, 59, 60].map((midi, i) => ({ midi: midi + (i % 2 ? 0.2 : -0.15), durSec }));
    const take = (durSec: number) =>
      analyzeTake(concat(silence(0.3, SR), synthMelody(tune(durSec), { sampleRate: SR }), silence(0.3, SR)), SR, OPTS);
    expect(take(0.3).style.pitchAccuracyCents).toBeNull();
    const held = take(0.55).style.pitchAccuracyCents ?? NaN;
    expect(held).toBeGreaterThan(8);
    expect(held).toBeLessThan(25);
  });
});
