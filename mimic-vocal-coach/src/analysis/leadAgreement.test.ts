// Vocal-forward songs: the solo analysis compares its own pitch track with the lead-vocal extractor's (quality.ts,
// LEAD_MAX_AGREE) and raises 'accompaniment' when they follow different melodies, so import routing reads the song as a song.
// The recall and false-alarm figures in the comments were measured when the rule was fitted (proxy mixes of songMix.ts, 4 real
// recordings of solo singing and speech, synthetic a cappella lines, and each of them with added noise, hum and reverb).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeWav } from '../audio/wav';
import { makeSongStems, mixSong } from '../testing/songMix';
import { synthMelody, silence, concat, whiteNoise, mix as mixSignals } from '../testing/synth';
import type { FrameFeatures } from '../types';
import { analyzeAuto } from './client';
import { analyzeTake } from './analyze';
import {
  LEAD_MAX_AGREE,
  LEAD_MAX_AGREE_OCTAVE,
  LEAD_MIN_BOTH_FRAMES,
  leadCheckWorthRunning,
  leadDisagrees,
  measureLeadAgreement,
  qualityReport,
} from './quality';

const SR = 22050;
const OPTS = { voiceType: 'tenor' as const };

function frame(f0: number | null): FrameFeatures {
  return { t: 0, f0: f0 ?? NaN, midi: NaN, voiced: f0 !== null, periodicity: 0.9, rmsDb: -30, h1h2Db: NaN, alphaRatioDb: NaN, centroidHz: NaN, tiltDbPerOct: NaN, cppDb: NaN, hnrDb: NaN, register: null };
}

describe('measureLeadAgreement', () => {
  const n = 100;
  const yin = Array.from({ length: n }, () => frame(220));

  it('is 1 when both trackers report the same pitch, within a semitone', () => {
    const f0 = new Float64Array(n).fill(220 * 2 ** (0.5 / 12));
    const c = measureLeadAgreement(yin, f0, new Uint8Array(n).fill(1));
    expect(c).toEqual({ bothFrames: n, agree: 1, agreeOctave: 1 });
  });

  it('counts an octave error as an octave-forgiving agreement only', () => {
    const c = measureLeadAgreement(yin, new Float64Array(n).fill(440), new Uint8Array(n).fill(1));
    expect(c.agree).toBe(0);
    expect(c.agreeOctave).toBe(1);
  });

  it('forgives an octave error that is also up to 150 cents out (a raspy or reverberant voice), not 200', () => {
    const near = measureLeadAgreement(yin, new Float64Array(n).fill(440 * 2 ** (1.3 / 12)), new Uint8Array(n).fill(1));
    expect(near.agree).toBe(0);
    expect(near.agreeOctave).toBe(1);
    const far = measureLeadAgreement(yin, new Float64Array(n).fill(440 * 2 ** (2 / 12)), new Uint8Array(n).fill(1));
    expect(far.agreeOctave).toBe(0);
  });

  it('counts a fifth apart as no agreement at all (a band note under the voice)', () => {
    const c = measureLeadAgreement(yin, new Float64Array(n).fill(220 * 1.5), new Uint8Array(n).fill(1));
    expect(c.agree).toBe(0);
    expect(c.agreeOctave).toBe(0);
  });

  it('looks only at frames where both report a pitch, and calls no frames in common agreement', () => {
    const f0 = new Float64Array(n).fill(330);
    const v = new Uint8Array(n);
    for (let i = 0; i < 40; i++) v[i] = 1;
    for (let i = 0; i < 20; i++) f0[i] = 220;
    const c = measureLeadAgreement(yin, f0, v);
    expect(c.bothFrames).toBe(40);
    expect(c.agree).toBeCloseTo(0.5, 6);
    expect(measureLeadAgreement(yin, f0, new Uint8Array(n))).toEqual({ bothFrames: 0, agree: 1, agreeOctave: 1 });
    expect(measureLeadAgreement([], new Float64Array(0), new Uint8Array(0)).bothFrames).toBe(0);
    expect(measureLeadAgreement([frame(null), frame(220)], [220, 220], [1, 1]).bothFrames).toBe(1);
  });
});

describe('leadDisagrees', () => {
  const ok = { bothFrames: 400, agree: 0.5, agreeOctave: 0.6 };
  it('needs both agreements low, and enough frames to mean something', () => {
    expect(leadDisagrees(ok)).toBe(true);
    expect(leadDisagrees({ ...ok, agree: LEAD_MAX_AGREE })).toBe(false);
    expect(leadDisagrees({ ...ok, agreeOctave: LEAD_MAX_AGREE_OCTAVE })).toBe(false);
    expect(leadDisagrees({ ...ok, agree: 0.1, agreeOctave: 0.95 })).toBe(false); // one tracker an octave off a clean voice
    expect(leadDisagrees({ ...ok, bothFrames: LEAD_MIN_BOTH_FRAMES - 1 })).toBe(false);
    expect(leadDisagrees({ ...ok, bothFrames: LEAD_MIN_BOTH_FRAMES })).toBe(true);
  });
});

describe('leadCheckWorthRunning', () => {
  it('skips what already looks like a clean solo take and clips with too little singing', () => {
    expect(leadCheckWorthRunning({ voicedSec: 10, medianPeriodicity: 0.99, snrDb: 40 })).toBe(false);
    expect(leadCheckWorthRunning({ voicedSec: 2, medianPeriodicity: 0.7, snrDb: 3 })).toBe(false);
  });

  it('runs on low periodicity, low or unknown SNR', () => {
    expect(leadCheckWorthRunning({ voicedSec: 10, medianPeriodicity: 0.9, snrDb: 40 })).toBe(true);
    expect(leadCheckWorthRunning({ voicedSec: 10, medianPeriodicity: 0.99, snrDb: 12 })).toBe(true);
    expect(leadCheckWorthRunning({ voicedSec: 10, medianPeriodicity: 0.99, snrDb: NaN })).toBe(true);
  });
});

describe('qualityReport with a lead agreement', () => {
  const base = { voicedSec: 12, quality: { clippingRatio: 0, noiseFloorDb: -30, snrDb: 8 }, medianVoicedDb: -20 };

  it('raises accompaniment, says so, and drops the noise warning the band would otherwise cause', () => {
    const r = qualityReport({ ...base, leadAgreement: { bothFrames: 800, agree: 0.45, agreeOctave: 0.7 } });
    expect(r.issues).toContain('accompaniment');
    expect(r.issues).not.toContain('noisy');
    expect(r.warnings.join(' ')).toMatch(/song with instruments behind the voice/);
    expect(r.warnings.join(' ')).toMatch(/55%/);
  });

  it('changes nothing when the trackers agree, or when the pause checks have already said it', () => {
    const quiet = qualityReport({ ...base });
    expect(qualityReport({ ...base, leadAgreement: { bothFrames: 800, agree: 0.95, agreeOctave: 0.97 } })).toEqual(quiet);
    expect(quiet.issues).toContain('noisy');
    const pauses = { pauseSec: 2, pauseLevelDb: -3, pausePeriodicity: 0.4, belowC3Share: 0.1 };
    const both = qualityReport({ ...base, accompaniment: pauses, leadAgreement: { bothFrames: 800, agree: 0.3, agreeOctave: 0.5 } });
    expect(both.warnings.filter((w) => /instruments/.test(w))).toHaveLength(1);
  });
});

describe('solo analysis of vocal-forward proxy mixes', () => {
  // Over the grid (builtin, walking-bass and band-harmony bands x 5 transpositions x voice +12..-6 dB over the band), flagged
  // before -> after: +3 dB 1 -> 14 of 15, 0 dB 3 -> 15, -3 dB 7 -> 15, -6 dB 10 -> 15, +6 dB 0 -> 8 of 15, +9 dB 0 -> 3 of 15,
  // +12 dB 0 -> 0 (a voice 12 dB over the band reads fine solo).
  const flagged = (band: 'builtin' | 'walking-bass' | 'band-harmony', db: number, transpose = 0) => {
    const a = analyzeTake(mixSong(makeSongStems({ band, transpose }), db).mono, SR, OPTS);
    return a.issues.includes('accompaniment');
  };

  it('flags the voice 3 dB over a chord, bass and drum band, which the pause checks alone miss', () => {
    expect(flagged('builtin', 3)).toBe(true);
    expect(flagged('builtin', 0)).toBe(true);
  }, 30000);

  it('flags the voice 3 dB over a moving bass line (the tracker follows the bass half of the time)', () => {
    expect(flagged('walking-bass', 3)).toBe(true);
    expect(flagged('walking-bass', 0, 7)).toBe(true);
  }, 30000);

  it('flags a band with backing voices on top at 0 dB', () => {
    expect(flagged('band-harmony', 0)).toBe(true);
  }, 30000);

  it('does not flag the voice 12 dB over the band: that reads as a clean take', () => {
    expect(flagged('builtin', 12)).toBe(false);
  }, 30000);

  it('routes a vocal-forward mix to the song reading in analyzeAuto', async () => {
    const m = mixSong(makeSongStems(), 3);
    const r = await analyzeAuto(m.mono, SR, OPTS);
    expect(r.solo?.issues).toContain('accompaniment');
    expect(r.route).toBe('mix-auto');
    expect(r.analysis.mode).toBe('mix');
  }, 30000);
});

describe('no false alarms on solo singing and speech', () => {
  // 207 clips when the rule was fitted: synthetic a cappella lines from a bass voice to a soprano, with and without vibrato; breathy,
  // raspy, falsetto, pressed, quiet and bass-fry lines; real solo singing and speech; each with 20 dB pink noise, 12 dB white noise,
  // 15 dB mains hum and a room reverb. The comparison raised no false alarm of its own; the two the pause checks raise on their own
  // (speech with 15 dB of mains hum, a steady tonal background) are there with or without it.
  const vowels = ['a', 'o', 'i', 'u', 'e'] as const;
  function acappella(seed: number, centre: number, vowel: (typeof vowels)[number], vibrato: number): Float32Array {
    const parts: Float32Array[] = [silence(0.5, SR)];
    for (let line = 0; line < 3; line++) {
      const notes = Array.from({ length: 7 }, (_, i) => ({ midi: centre + [0, 2, 4, 2, -3, 0, -5][(i + line * 3) % 7], durSec: 0.4 + 0.15 * ((i + line) % 4) }));
      parts.push(
        synthMelody(notes, { sampleRate: SR, seed: seed + line, amplitude: 0.35, vibrato: vibrato ? { rateHz: 5.5, extentCents: vibrato, delaySec: 0.2 } : undefined, jitter: 0.003, breathNoise: 0.08, vowel, tiltDbPerOct: -11 }),
        silence(0.7, SR),
      );
    }
    return concat(...parts);
  }

  it('leaves clean and noisy a cappella lines from bass to soprano alone', () => {
    let n = 0;
    for (const [k, centre] of [45, 52, 57, 62, 69, 76].entries()) {
      const x = acappella(50 + k, centre, vowels[k % 5], k % 2 ? 25 : 0);
      const noisy = mixSignals(x, whiteNoise(x.length / SR, 0.35 * 10 ** (-12 / 20) * 0.5, SR, 7));
      for (const clip of [x, noisy]) {
        const a = analyzeTake(clip, SR, { voiceType: centre < 55 ? 'baritone' : centre < 70 ? 'tenor' : 'soprano' });
        expect(a.issues, `centre ${centre}`).not.toContain('accompaniment');
        n++;
      }
    }
    expect(n).toBe(12);
  }, 60000);

  it('leaves a raspy (subharmonic) voice in a very reverberant room alone: the trackers disagree there by an octave and 100-150 cents', () => {
    const parts: Float32Array[] = [silence(0.5, SR)];
    for (let line = 0; line < 3; line++) {
      const notes = Array.from({ length: 7 }, (_, i) => ({ midi: 52 + [0, 2, 4, 2, -3, 0, -5][(i + line * 3) % 7], durSec: 0.4 + 0.15 * ((i + line) % 4) }));
      parts.push(synthMelody(notes, { sampleRate: SR, seed: 7 + line, amplitude: 0.35, jitter: 0.003, subharmonic: 0.5, vowel: 'a' }), silence(0.7, SR));
    }
    const dry = concat(...parts);
    // four feedback combs (a 1.2 s room) mixed 60/40 with the dry voice: the plain tracker and the extractor then agree on only 72%
    // of the frames (77% once octaves are forgiven to 100 cents, 99% to 150)
    const wet = new Float32Array(dry.length);
    for (const ms of [29.7, 37.1, 41.1, 43.7]) {
      const d = Math.round((ms * SR) / 1000);
      const g = Math.pow(10, (-3 * ms) / 1000 / 1.2);
      const buf = new Float32Array(d);
      for (let i = 0, p = 0; i < dry.length; i++, p = (p + 1) % d) {
        const y = dry[i] + g * buf[p];
        buf[p] = y;
        wet[i] += y / 4;
      }
    }
    const room = Float32Array.from(dry, (v, i) => 0.4 * v + 0.6 * wet[i] * 2);
    expect(analyzeTake(room, SR, { voiceType: 'baritone' }).issues).not.toContain('accompaniment');
  }, 30000);

  it('the demo-style sung phrase with vibrato stays a solo analysis', () => {
    const notes = [55, 57, 59, 62, 64, 62, 59, 57].map((midi) => ({ midi, durSec: 0.45 }));
    const x = synthMelody(notes, { sampleRate: SR, vibrato: { rateHz: 5.5, extentCents: 30, delaySec: 0.2 } });
    expect(analyzeTake(x, SR, { voiceType: 'baritone' }).issues).not.toContain('accompaniment');
  });

  // Real recordings are not in the repository (no commercial or personal audio is committed); the research folder of the design
  // phase has them, and the test is skipped where it does not.
  const REAL_DIR = process.env.MIMIC_REAL_MIX_DIR ?? '/tmp/claude-0/-home-user-connect-x/c7cf0764-cfef-502f-8c42-ff240fdbd2b3/scratchpad/review/real-voice/wav';
  const REAL_SOLO = ['crepetest', 'long_voice', 'vocadito10', 'vignesh', 'libri1', 'libri2', 'libri3'].filter((n) => existsSync(join(REAL_DIR, `${n}.wav`)));
  it.skipIf(REAL_SOLO.length === 0)('leaves real solo singing and speech recordings alone', () => {
    for (const name of REAL_SOLO) {
      const bytes = readFileSync(join(REAL_DIR, `${name}.wav`));
      const { channels, sampleRate } = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { mono: true, maxSeconds: 30 });
      expect(analyzeTake(channels[0], sampleRate, OPTS).issues, name).not.toContain('accompaniment');
    }
  }, 60000);
});
