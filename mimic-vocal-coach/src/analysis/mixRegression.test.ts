// Regression suite for the full-song front end on proxy mixes generated in code (testing/songMix.ts: a synthetic sung
// line over a synthetic band of chords, bass, plucked arpeggio and drum-like noise bursts, at an exact vocal-to-band
// level). These guard the algorithm against accidental regressions; they are not a claim about real songs. The real-mix
// sanity check at the end runs only when the research clips are on disk, and no audio is ever committed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { isMainThread } from 'node:worker_threads';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeWav } from '../audio/wav';
import { extractVocalMelody } from '../dsp/melody/vocalMelody';
import { trackPitch } from '../dsp/pitch';
import { resample } from '../dsp/resample';
import { makeSongStems, mixSong, rawPitchAccuracy, voicingFalseAlarm, type SongMix } from '../testing/songMix';
import { whiteNoise } from '../testing/synth';
import { analyzeTake } from './analyze';
import { analyzeAuto } from './client';
import { leadExtractionOf, MIX_NOTE } from './mixMode';

const SR = 22050;
const OPTS = { voiceType: 'tenor' as const };
const REGISTERS = [0, -5, 7]; // vocal line transposed by these semitones (A3-E4 up to C#5-G#5)
const LEVELS = [3, 0, -6]; // vocal over band, dB (RMS of the mono downmix over the sung frames)

/**
 * Raw pitch accuracy of the plain tracker (YIN on the mono mix, what analyzeTake used before mix mode) and of the extractor,
 * the extractor's clip confidence, and its voicing false-alarm rate (share of band-only frames it calls voiced).
 */
function accuracies(m: SongMix): { plain: number; extractor: number; confidence: number; falseAlarm: number } {
  const plain = rawPitchAccuracy(trackPitch(m.mono, SR).f0, m.truthHz);
  const res = extractVocalMelody(m.mono, null, SR);
  return { plain, extractor: rawPitchAccuracy(res.track.f0, m.truthHz), confidence: res.confidence, falseAlarm: voicingFalseAlarm(res.track.f0, m.rest) };
}

describe('proxy mixes: pitch accuracy against the plain tracker', () => {
  const results = new Map<string, ReturnType<typeof accuracies>>();
  beforeAll(() => {
    for (const transpose of REGISTERS) {
      const stems = makeSongStems({ transpose });
      for (const db of LEVELS) results.set(`${transpose}/${db}`, accuracies(mixSong(stems, db)));
    }
  }, 60000);
  const at = (transpose: number, db: number) => results.get(`${transpose}/${db}`)!;
  const mean = (pick: (r: ReturnType<typeof accuracies>) => number) => [...results.values()].reduce((s, r) => s + pick(r), 0) / results.size;

  it('is far above the plain tracker in every condition (+3, 0 and -6 dB, three registers)', () => {
    for (const transpose of REGISTERS) {
      for (const db of LEVELS) {
        const r = at(transpose, db);
        expect(r.extractor - r.plain, `${transpose} st, ${db} dB: ${r.extractor.toFixed(2)} vs ${r.plain.toFixed(2)}`).toBeGreaterThan(0.3);
      }
    }
  });

  it('is accurate when the voice is at least as loud as the band, and still useful 6 dB under it', () => {
    for (const transpose of REGISTERS) {
      expect(at(transpose, 3).extractor).toBeGreaterThan(0.95);
      expect(at(transpose, 0).extractor).toBeGreaterThan(0.85);
      expect(at(transpose, -6).extractor).toBeGreaterThan(0.4);
    }
  });

  it('keeps the instrumental stretches mostly unvoiced when the voice is at least as loud as the band', () => {
    // 20-26% of the band-only frames are called voiced at +3 and 0 dB; with the voice 6 dB under the band the level cue
    // cannot tell them apart any more (about 84%), which is why mix mode offers a trim to the phrase the user wants.
    for (const transpose of REGISTERS) {
      expect(at(transpose, 3).falseAlarm).toBeLessThan(0.4);
      expect(at(transpose, 0).falseAlarm).toBeLessThan(0.4);
    }
  });

  it('averages about 0.8 over the grid where the plain tracker averages about 0.25', () => {
    expect(mean((r) => r.extractor)).toBeGreaterThan(0.75);
    expect(mean((r) => r.plain)).toBeLessThan(0.4);
  });

  it('reports a confidence that ranks the levels, stays in range and flags nothing as certain', () => {
    for (const transpose of REGISTERS) {
      expect(at(transpose, 3).confidence).toBeGreaterThan(at(transpose, 0).confidence - 0.01);
      expect(at(transpose, 0).confidence).toBeGreaterThan(at(transpose, -6).confidence - 0.01);
      for (const db of LEVELS) {
        expect(at(transpose, db).confidence).toBeGreaterThan(0.7);
        expect(at(transpose, db).confidence).toBeLessThan(0.99);
      }
    }
  });

  it('stereo input is as accurate as mono (the stereo cue only adds), and says how much side signal there was', () => {
    const stems = makeSongStems();
    for (const db of LEVELS) {
      const m = mixSong(stems, db);
      const mono = extractVocalMelody(m.mono, null, SR);
      const stereo = extractVocalMelody(m.left, m.right, SR);
      expect(rawPitchAccuracy(stereo.track.f0, m.truthHz)).toBeGreaterThan(rawPitchAccuracy(mono.track.f0, m.truthHz) - 0.05);
      expect(stereo.sideToMidDb).toBeLessThan(0);
      expect(Number.isFinite(stereo.sideToMidDb)).toBe(true);
      expect(mono.sideToMidDb).toBe(-Infinity);
    }
    // dual mono (L === R) is the mono result, not a stereo one
    const dual = mixSong(stems, 0, { stereo: false });
    expect(dual.left).toBe(dual.right);
    expect(extractVocalMelody(dual.left, dual.right, SR).sideToMidDb).toBe(-Infinity);
  });

  it('a 44.1 kHz mix gives the same accuracy as the 22.05 kHz one', () => {
    const stems = makeSongStems();
    const m = mixSong(stems, 0);
    const res = extractVocalMelody(resample(m.mono, SR, 44100), null, 44100);
    expect(rawPitchAccuracy(res.track.f0, m.truthHz)).toBeGreaterThan(0.85);
  });
});

describe('proxy mixes: mix mode through analyzeTake', () => {
  const stems = makeSongStems();

  it('finds the phrases and the vibrato of the lead vocal, with the band-led pitch of the solo analysis corrected', () => {
    const m = mixSong(stems, 0);
    const solo = analyzeTake(m.mono, SR, OPTS);
    const mix = analyzeTake(m.mono, SR, { ...OPTS, mode: 'mix' });
    expect(mix.mode).toBe('mix');
    // Two sung lines (0.5-7 s and 9-15.6 s). Short stray segments in the gaps and at the start are expected (the
    // extractor falsely voices about a tenth of the unsung frames), so look at the two longest phrases.
    const longest = [...mix.phrases].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 2).sort((a, b) => a.start - b.start);
    expect(longest).toHaveLength(2);
    expect(longest[0].start).toBeLessThan(1);
    expect(longest[0].end).toBeGreaterThan(6.5);
    expect(longest[1].start).toBeLessThan(9.5);
    expect(longest[1].end).toBeGreaterThan(15);
    expect(mix.voicedSec).toBeGreaterThan(11);
    // the sung line sits around A3-E4 (MIDI 55-67); the solo analysis follows the bass
    expect(mix.pitch.medianMidi).toBeGreaterThan(55);
    expect(mix.pitch.medianMidi).toBeLessThan(66);
    expect(solo.pitch.medianMidi ?? 99).toBeLessThan(52);
    expect(mix.style.vibratoRateHz).toBeGreaterThan(4.5);
    expect(mix.style.vibratoRateHz).toBeLessThan(6.5);
    expect(mix.warnings).toContain(MIX_NOTE);
    expect(leadExtractionOf(mix)!.confidence).toBeGreaterThan(0.8);
  });

  it('analyzeAuto routes a mix the solo analysis flags to mix mode, and a plain voice to solo', async () => {
    const song = mixSong(stems, -6); // the solo analysis raises the accompaniment issue at this level
    const seen: number[] = [];
    const r = await analyzeAuto(song.mono, SR, OPTS, (f) => seen.push(f));
    expect(r.solo?.issues).toContain('accompaniment');
    expect(r.route).toBe('mix-auto');
    expect(r.analysis.mode).toBe('mix');
    expect(r.analysis.phrases.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);

    const voice = await analyzeAuto(song.vocal, SR, OPTS);
    expect(voice.route).toBe('solo');
    expect(voice.analysis.mode).toBeUndefined();
  });
});

describe('no vocal to find', () => {
  it('a band with the voice 40 dB down is still a pitched sound (the extractor cannot tell) but is never certain', () => {
    const band = mixSong(makeSongStems(), -40);
    const res = extractVocalMelody(band.mono, null, SR);
    expect(res.confidence).toBeLessThan(0.9);
  });

  it('noise at any level, mono or stereo, gives no melody and confidence 0 through mix mode', () => {
    for (const rms of [0.002, 0.05, 0.4]) {
      const noise = whiteNoise(6, rms, SR, 21);
      const a = analyzeTake(noise, SR, { ...OPTS, mode: 'mix' });
      expect(a.voicedSec).toBe(0);
      expect(a.notes).toHaveLength(0);
      expect(leadExtractionOf(a)!.confidence).toBe(0);
      const stereo = extractVocalMelody(noise, whiteNoise(6, rms, SR, 22), SR);
      expect(stereo.voicedSec).toBe(0);
      expect(stereo.confidence).toBe(0);
    }
  });
});

describe('cost of a four-minute song', () => {
  const song = mixSong(makeSongStems(), 0, { seconds: 240 });
  // Typed-array memory is counted per process, so it is only measured where this file has the process to itself
  // (the forks pool, the default); in a worker thread other files' buffers would be counted too.
  const gc = (() => {
    if (!isMainThread) return null;
    try {
      v8.setFlagsFromString('--expose-gc');
      return vm.runInNewContext('gc') as () => void;
    } catch {
      return null;
    }
  })();

  /**
   * Wall time (ms) of `run` and, when the runtime lets us collect garbage, the peak growth of typed-array memory (MB) during
   * it, sampled at every progress callback from a collected baseline (the big arrays are allocated up front, so the samples see them).
   */
  function measure(run: (onProgress: () => void) => void): { ms: number; peakMb: number | null } {
    gc?.();
    gc?.();
    const base = process.memoryUsage().arrayBuffers;
    let top = base;
    const sample = () => {
      top = Math.max(top, process.memoryUsage().arrayBuffers);
    };
    const t0 = performance.now();
    run(sample);
    const ms = performance.now() - t0;
    sample();
    return { ms, peakMb: gc ? (top - base) / 1e6 : null };
  }

  it('the extractor takes well under the 15 s budget and about 65 MB on mono input', () => {
    let res: ReturnType<typeof extractVocalMelody> | undefined;
    const { ms, peakMb } = measure((onProgress) => {
      res = extractVocalMelody(song.mono, null, SR, { onProgress });
    });
    expect(res!.track.f0.length).toBe(24000);
    expect(rawPitchAccuracy(res!.track.f0, song.truthHz)).toBeGreaterThan(0.85);
    expect(ms).toBeLessThan(15000);
    if (peakMb !== null) expect(peakMb).toBeLessThan(100);
  }, 60000);

  it('the whole mix-mode analysis of 4 minutes at 44.1 kHz takes well under 15 s and about 130 MB', () => {
    const input = resample(song.mono, SR, 44100);
    let a: ReturnType<typeof analyzeTake> | undefined;
    const { ms, peakMb } = measure((onProgress) => {
      a = analyzeTake(input, 44100, { ...OPTS, mode: 'mix' }, onProgress);
    });
    expect(a!.mode).toBe('mix');
    expect(a!.durationSec).toBeCloseTo(240, 1);
    expect(a!.phrases.length).toBeGreaterThan(20);
    expect(ms).toBeLessThan(15000);
    if (peakMb !== null) expect(peakMb).toBeLessThan(200);
  }, 60000);
});

// ---------------------------------------------------------------------------------------------
// Real mixes (optional). The research clips are not in the repository; set MIMIC_REAL_MIX_DIR to a folder with
// spleeter.wav, karissa.wav, flamenco.wav and varnam.wav, or leave it to find the research folder of the design phase.
// Skipped when they are absent. Only the extracted contour is looked at, nothing is copied.

const REAL_DIR = process.env.MIMIC_REAL_MIX_DIR ?? '/tmp/claude-0/-home-user-connect-x/c7cf0764-cfef-502f-8c42-ff240fdbd2b3/scratchpad/review/real-voice/wav';
const REAL_MIXES = ['spleeter', 'karissa', 'flamenco', 'varnam'].filter((name) => existsSync(join(REAL_DIR, `${name}.wav`)));
const MAX_REAL_SEC = 45;

function loadReal(name: string): { samples: Float32Array; sampleRate: number } {
  const bytes = readFileSync(join(REAL_DIR, `${name}.wav`));
  const { channels, sampleRate } = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { mono: true, maxSeconds: MAX_REAL_SEC });
  return { samples: channels[0], sampleRate };
}

describe.skipIf(REAL_MIXES.length === 0)('real mixes on disk (optional sanity check)', () => {
  for (const name of REAL_MIXES) {
    it(`${name}: the extracted contour is a plausible singing voice`, () => {
      const { samples, sampleRate } = loadReal(name);
      const res = extractVocalMelody(samples, null, sampleRate);
      const seconds = samples.length / sampleRate;
      const share = res.voicedSec / seconds;
      expect(share).toBeGreaterThan(0.25);
      expect(share).toBeLessThan(0.97);
      const midi: number[] = [];
      for (let i = 0; i < res.track.f0.length; i++) if (res.track.voiced[i]) midi.push(12 * Math.log2(res.track.f0[i] / 440) + 69);
      midi.sort((a, b) => a - b);
      const q = (p: number) => midi[Math.floor(p * (midi.length - 1))];
      // human singing, E2 to C6, with the middle of it in the usual range
      expect(q(0.05)).toBeGreaterThan(40);
      expect(q(0.95)).toBeLessThan(84);
      expect(q(0.5)).toBeGreaterThan(48);
      expect(q(0.5)).toBeLessThan(72);
      expect(res.confidence).toBeGreaterThan(0.7);
      expect(res.harmonicShare).toBeGreaterThan(0.2);
    }, 30000);
  }

  it.skipIf(!REAL_MIXES.includes('spleeter'))('spleeter: the plain tracker follows the bass, the extractor the voice, and mix mode finds phrases', () => {
    const { samples, sampleRate } = loadReal('spleeter');
    const plain = trackPitch(resample(samples, sampleRate, SR), SR);
    const plainMidi = Array.from(plain.f0)
      .filter((f, i) => plain.voiced[i] && f > 0)
      .map((f) => 12 * Math.log2(f / 440) + 69)
      .sort((a, b) => a - b);
    const res = extractVocalMelody(samples, null, sampleRate);
    const midi = Array.from(res.track.f0)
      .filter((f) => f > 0)
      .map((f) => 12 * Math.log2(f / 440) + 69)
      .sort((a, b) => a - b);
    expect(midi[midi.length >> 1] - plainMidi[plainMidi.length >> 1]).toBeGreaterThan(6);
    const a = analyzeTake(samples, sampleRate, { voiceType: 'alto', mode: 'mix' });
    expect(a.mode).toBe('mix');
    expect(a.phrases.length).toBeGreaterThan(0);
    expect(a.style.breathiness).toBeNull();
    expect(a.issues).not.toContain('too-little-singing');
  }, 30000);
});
