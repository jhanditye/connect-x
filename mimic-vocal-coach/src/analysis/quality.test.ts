import { describe, expect, it } from 'vitest';
import { concat, mix, silence, synthMelody, synthVoice, whiteNoise } from '../testing/synth';
import { analyzeTake } from './analyze';
import { clippingRatio, qualityReport, qualityWarnings, type AccompanimentCues } from './quality';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };
const melody = (amplitude = 0.5, seconds = 5) =>
  synthMelody(
    Array.from({ length: Math.round(seconds / 0.5) }, (_, i) => ({ midi: 55 + (i % 5), durSec: 0.5 })),
    { sampleRate: SR, amplitude },
  );

describe('clippingRatio', () => {
  it('counts samples at or beyond +/-0.999', () => {
    expect(clippingRatio(Float32Array.from([0, 0.5, 0.999, -1, 1.2, -0.3]))).toBeCloseTo(3 / 6, 5);
    expect(clippingRatio(new Float32Array(0))).toBe(0);
  });
});

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

const scaled = (x: Float32Array, g: number) => x.map((v) => v * g);

describe('qualityWarnings', () => {
  it('is empty for a good recording', () => {
    expect(qualityWarnings({ voicedSec: 20, quality: { clippingRatio: 0, noiseFloorDb: -70, snrDb: 50 }, medianVoicedDb: -20 })).toEqual([]);
    expect(qualityReport({ voicedSec: 20, quality: { clippingRatio: 0, noiseFloorDb: -70, snrDb: 50 }, medianVoicedDb: -20 }).issues).toEqual([]);
  });

  it('does not warn about noise when the SNR could not be measured', () => {
    const r = qualityReport({ voicedSec: 12, quality: { clippingRatio: 0, noiseFloorDb: -18, snrDb: NaN }, medianVoicedDb: -16 });
    expect(r.warnings).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('uses the voice type to catch a pitch track that follows the bass', () => {
    const quiet: AccompanimentCues = { pauseSec: 2, pauseLevelDb: -40, pausePeriodicity: 0.1, belowC3Share: 0.5 };
    const base = { voicedSec: 20, quality: { clippingRatio: 0, noiseFloorDb: -70, snrDb: 50 }, medianVoicedDb: -20 };
    // Silent pauses: only a hint (maybe the voice type is wrong), not an accompaniment verdict.
    const hint = qualityReport({ ...base, accompaniment: quiet, voiceType: 'mezzo' });
    expect(hint.issues).toEqual([]);
    expect(hint.warnings.join(' ')).toMatch(/below C3.*mezzo-soprano.*voice type in Settings/);
    // A baritone really sings down there.
    expect(qualityReport({ ...base, accompaniment: quiet, voiceType: 'baritone' }).warnings).toEqual([]);
    // Fainter pitched pauses plus a low track: accompaniment.
    const faint: AccompanimentCues = { pauseSec: 2, pauseLevelDb: -16, pausePeriodicity: 0.35, belowC3Share: 0.5 };
    expect(qualityReport({ ...base, accompaniment: faint, voiceType: 'mezzo' }).issues).toEqual(['accompaniment']);
    expect(qualityReport({ ...base, accompaniment: faint, voiceType: 'baritone' }).issues).toEqual([]);
  });
});

describe('recording-quality warnings from analyzeTake', () => {
  it('a clean, well-levelled take has no warnings and a high SNR', () => {
    const a = analyzeTake(concat(silence(0.5, SR), melody(), silence(0.5, SR)), SR, OPTS);
    expect(a.warnings).toEqual([]);
    expect(a.quality.clippingRatio).toBe(0);
    expect(a.quality.snrDb).toBeGreaterThan(40);
  });

  it('warns about too little singing', () => {
    const a = analyzeTake(concat(silence(0.5, SR), melody(0.5, 1.5), silence(0.5, SR)), SR, OPTS);
    expect(a.warnings.some((w) => /Record at least 10 seconds/.test(w))).toBe(true);
    expect(a.issues).toEqual(['too-little-singing']);
  });

  it('a take sung without pauses has an unknown SNR and no background-noise warning', () => {
    // Tightly trimmed legato: no silence to measure the room, so the quietest singing must not be
    // mistaken for the noise floor.
    const gapless = analyzeTake(melody(0.5, 12), SR, OPTS);
    expect(gapless.quality.snrDb).toBeNaN();
    expect(gapless.warnings).toEqual([]);
    expect(gapless.issues).toEqual([]);
    // Short breaths (0.12 s) and quiet room noise: still too few pauses to measure the floor.
    const phrase = () => melody(0.5, 4);
    const breath = () => silence(0.12, SR);
    const take = concat(phrase(), breath(), phrase(), breath(), phrase());
    const breaths = analyzeTake(mix(take, whiteNoise(take.length / SR, 0.002, SR, 3)), SR, OPTS);
    expect(breaths.issues).not.toContain('noisy');
    expect(breaths.warnings.some((w) => /background noise/.test(w))).toBe(false);
  });

  it('warns about clipping', () => {
    const loud = melody(1.6);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.max(-1, Math.min(1, loud[i]));
    const a = analyzeTake(concat(silence(0.5, SR), loud, silence(0.5, SR)), SR, OPTS);
    expect(a.quality.clippingRatio).toBeGreaterThan(0.001);
    expect(a.warnings.some((w) => /clipping/.test(w) && /lower the input gain/.test(w))).toBe(true);
    expect(a.issues).toContain('clipping');
  });

  it('warns about background noise', () => {
    const take = concat(silence(1, SR), melody(0.3), silence(1, SR));
    const noisy = mix(take, whiteNoise(take.length / SR, 0.02, SR));
    const a = analyzeTake(noisy, SR, OPTS);
    expect(a.quality.snrDb).toBeLessThan(20);
    expect(a.warnings.some((w) => /background noise/.test(w) && /quieter room/.test(w))).toBe(true);
    expect(a.issues).toEqual(['noisy']);
  });

  it('warns about a very quiet recording', () => {
    const a = analyzeTake(concat(silence(0.5, SR), melody(0.01), silence(0.5, SR)), SR, OPTS);
    expect(a.warnings.some((w) => /very quiet/.test(w) && /closer to the microphone/.test(w))).toBe(true);
    expect(a.issues).toEqual(['too-quiet']);
  });

  it('says the input is too quiet (not only "no singing") when nothing reaches the voicing gate', () => {
    const faint = mix(concat(silence(0.5, SR), melody(0.0008), silence(0.5, SR)), whiteNoise(6, 0.00003, SR, 5));
    const a = analyzeTake(faint, SR, OPTS);
    expect(a.voicedSec).toBeLessThan(0.2);
    expect(a.warnings[0]).toMatch(/No clear singing/);
    expect(a.warnings[0]).toMatch(/very quiet .*raise its input gain/);
    expect(a.issues).toEqual(['too-little-singing', 'too-quiet']);
    const silent = analyzeTake(silence(3, SR), SR, OPTS);
    expect(silent.warnings[0]).toMatch(/silent: check that the right microphone is selected/);
    // Loud noise is not a quiet input.
    expect(analyzeTake(whiteNoise(3, 0.05, SR), SR, OPTS).issues).toEqual(['too-little-singing']);
  });

  it('flags speech-like input with no held notes', () => {
    // 0.1-0.28 s voiced syllables with falling pitch and short gaps: plenty of voicing, no held note.
    const syllables: Float32Array[] = [];
    for (let i = 0; i < 26; i++) {
      const dur = 0.1 + 0.18 * ((i * 7) % 11) / 10;
      const f0 = 110 + 50 * ((i * 5) % 7) / 6;
      syllables.push(synthVoice({ sampleRate: SR, durationSec: dur, f0: (t) => f0 * (1 - 0.6 * t), vowel: i % 2 ? 'e' : 'a', seed: i + 1 }));
      syllables.push(silence(0.08 + 0.1 * (i % 3), SR));
    }
    const a = analyzeTake(concat(silence(0.4, SR), ...syllables, silence(0.4, SR)), SR, OPTS);
    expect(a.voicedSec).toBeGreaterThan(3);
    expect(a.notes.every((n) => n.end - n.start < 0.45)).toBe(true);
    expect(a.issues).toContain('speech-like');
    expect(a.warnings.some((w) => /speech-like/.test(w) && /held notes/.test(w))).toBe(true);
  });
});

describe('accompaniment (singing over instruments)', () => {
  const phrase = (seed: number) =>
    synthMelody([55, 57, 59, 62, 60, 59, 57].map((midi) => ({ midi, durSec: 0.45 })), { sampleRate: SR, seed, amplitude: 0.4 });
  const voice = concat(silence(0.5, SR), phrase(1), silence(0.8, SR), phrase(2), silence(0.8, SR), phrase(3), silence(0.5, SR));
  const voiceRms = rms(phrase(1));

  /** A sustained four-note chord under the whole take, `dropDb` below the voice. */
  function withBand(dropDb: number): Float32Array {
    const dur = voice.length / SR;
    let band: Float32Array = new Float32Array(voice.length);
    [110, 138.59, 164.81, 220].forEach((hz, k) => {
      band = mix(band, synthVoice({ sampleRate: SR, durationSec: dur, f0: hz, vowel: 'none', tiltDbPerOct: -9, jitter: 0.002, seed: 10 + k, amplitude: 0.2 }));
    });
    return mix(voice, scaled(band, (voiceRms / rms(band)) * Math.pow(10, -dropDb / 20)));
  }

  it('flags a song mix and replaces the quieter-room advice with the isolated-vocal fix', () => {
    const a = analyzeTake(withBand(6), SR, OPTS);
    expect(a.issues).toContain('accompaniment');
    expect(a.issues).not.toContain('noisy');
    const w = a.warnings.find((x) => /instruments/.test(x)) ?? '';
    expect(w).toMatch(/isolated vocal or an a cappella section/);
    expect(a.warnings.some((x) => /quieter room/.test(x))).toBe(false);
  });

  it('does not flag a solo take, with or without room noise, or when it is very quiet', () => {
    expect(analyzeTake(voice, SR, OPTS).issues).toEqual([]);
    // Singing around -60 dBFS: frames that miss the voicing floor are loud, pitched "pauses".
    const faint = analyzeTake(mix(scaled(voice, 0.006), whiteNoise(voice.length / SR, 0.00002, SR, 6)), SR, OPTS);
    expect(faint.issues).toContain('too-quiet');
    expect(faint.issues).not.toContain('accompaniment');
    const noisy = analyzeTake(mix(voice, whiteNoise(voice.length / SR, voiceRms * 0.3, SR, 4)), SR, OPTS);
    expect(noisy.issues).toContain('noisy');
    expect(noisy.issues).not.toContain('accompaniment');
  });
});
