// Proxy "song mixes" built entirely in code, for testing the full-song front end (dsp/melody) without any
// recording: a synthetic sung line (testing/synth.ts) over a synthetic band (bass, chord pad, plucked arpeggio,
// kick / snare / hat noise bursts). Ground truth is known per 10 ms frame, and the vocal-to-band level
// is set exactly, so tests can sweep it.
//
// The band is tuned to the key of the vocal on purpose (partials collide with the voice's harmonics, as in
// real songs) and the pad and arpeggio are decorrelated between the channels. It is a proxy, not a song:
// stationary chords are the easy case for the extractor, so accuracy here says "the algorithm works",
// not "real mixes will score the same" (see the evaluation notes in the PR / README).

import { makeRng, synthMelody, synthVoice, type MelodyNote } from './synth';

/** Length of the base block, seconds. Longer mixes tile it. */
export const BASE_BLOCK_SEC = 16;
const HOP_SEC = 0.01;

/**
 * Band types. 'builtin' (default): chords, bass plucks, arpeggio, drums. 'walking-bass': a moving bass line only (the case
 * that keeps the extractor's confidence high while it follows the bass). 'harmony': two backing voices a major third above
 * and a fifth below the lead, singing the lead's rhythm (the extractor must pick the lead out of three voices). 'band-harmony':
 * the built-in band plus those backing voices.
 */
export type SongBandType = 'builtin' | 'walking-bass' | 'harmony' | 'band-harmony';

export interface SongStemsOptions {
  sampleRate?: number;
  /** Semitones added to the vocal line (the band stays in the same key, so partial collisions change). */
  transpose?: number;
  /** Vibrato extent of the voice, cents (semi-extent). Default 20. */
  vibratoCents?: number;
  seed?: number;
  /** Which band to put under the voice (default 'builtin'). */
  band?: SongBandType;
}

export interface SongStems {
  sampleRate: number;
  /** One base block (BASE_BLOCK_SEC) of each stem. */
  vocal: Float32Array;
  bandL: Float32Array;
  bandR: Float32Array;
  /** Ground-truth f0 (Hz) per 10 ms frame of the base block; NaN in rests, glides and note releases. */
  truthHz: Float64Array;
  /** 1 on frames at least 150 ms away from any singing (the band plays alone), 0 elsewhere. For voicing false alarms. */
  rest: Uint8Array;
}

export interface SongMix {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  /** (L + R) / 2: what the app's decoder hands to analyzeTake today. */
  mono: Float32Array;
  /** The clean vocal at the same length. */
  vocal: Float32Array;
  truthHz: Float64Array;
  /** Tiled SongStems.rest. */
  rest: Uint8Array;
  /** Vocal RMS over the sung frames relative to the band RMS over the same frames, dB (equals the request). */
  vocalToBandDb: number;
}

/**
 * Additive oscillator with a 1/h^1.3 roll-off, added into `out` over samples [from, to) with an optional exponential decay.
 * Each partial is a rotating phasor (one multiply-add per sample instead of a sin call), exact enough for the 2 s at most it runs.
 */
function addTone(out: Float32Array, sr: number, f0: number, amp: number, phase: number, from: number, to: number, decaySec: number, harmonics: number): void {
  const end = Math.min(out.length, to);
  const k = decaySec > 0 ? Math.exp(-1 / (decaySec * sr)) : 1;
  for (let h = 1; h <= harmonics && h * f0 < 0.45 * sr; h++) {
    const a = amp / Math.pow(h, 1.3);
    const w = (2 * Math.PI * h * f0) / sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    let re = Math.cos(phase * h);
    let im = Math.sin(phase * h);
    let env = a;
    for (let i = from; i < end; i++) {
      out[i] += env * im;
      const next = re * c - im * s;
      im = re * s + im * c;
      re = next;
      env *= k;
    }
  }
}

/** A short noise burst with an exponential decay, high-passed by a first difference when `bright`. */
function addNoiseBurst(out: Float32Array, sr: number, at: number, durSec: number, amp: number, bright: boolean, rng: () => number): void {
  const n = Math.round(durSec * sr);
  let prev = 0;
  for (let i = 0; i < n && at + i < out.length; i++) {
    const w = rng() * 2 - 1;
    const v = bright ? w - prev : w;
    prev = w;
    out[at + i] += amp * v * Math.exp((-5 * i) / n);
  }
}

// A minor, 2 s per chord: Am F C G Am F C G (16 s).
const CHORDS: { root: number; tones: number[] }[] = [
  { root: 45, tones: [57, 60, 64] },
  { root: 41, tones: [57, 60, 65] },
  { root: 48, tones: [55, 60, 64] },
  { root: 43, tones: [55, 59, 62] },
];

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

function buildBand(sr: number, seed: number): { L: Float32Array; R: Float32Array } {
  const n = Math.round(BASE_BLOCK_SEC * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const rng = makeRng(seed + 101);
  const chordLen = Math.round(2 * sr);
  const beat = Math.round(0.5 * sr); // 120 bpm
  for (let c = 0; c < 8; c++) {
    const chord = CHORDS[c % 4];
    const from = c * chordLen;
    // Pad: each tone slightly detuned per channel, with different phases, so L and R are partly decorrelated.
    chord.tones.forEach((m, k) => {
      for (const [ch, out] of [L, R].entries()) {
        const detune = 1 + 0.0007 * (k + 3 * ch);
        addTone(out, sr, hz(m) * detune, 0.05, 1.7 * (k + 1) * (ch + 1), from, from + chordLen, 0, 10);
      }
    });
    // Bass: centred, two plucks per chord.
    for (const half of [0, 1]) {
      const a = from + half * (chordLen >> 1);
      addTone(L, sr, hz(chord.root), 0.22, 0.3, a, a + chordLen / 2, 0.6, 10);
      addTone(R, sr, hz(chord.root), 0.22, 0.3, a, a + chordLen / 2, 0.6, 10);
    }
    // Arpeggio: eighth-note plucks cycling the chord tones an octave up, panned left / right alternately.
    for (let e = 0; e < 8; e++) {
      const a = from + Math.round((e * beat) / 2);
      const m = chord.tones[e % 3] + (e % 4 === 3 ? 12 : 0);
      const [loud, soft] = e % 2 === 0 ? [L, R] : [R, L];
      addTone(loud, sr, hz(m), 0.1, 0.5 * e, a, a + beat, 0.25, 8);
      addTone(soft, sr, hz(m), 0.03, 0.5 * e, a, a + beat, 0.25, 8);
    }
  }
  // Drums: kick on every beat (centred), snare on 2 and 4 (centred), hats on the eighths (decorrelated).
  const beats = Math.round((BASE_BLOCK_SEC * sr) / beat);
  for (let b = 0; b < beats; b++) {
    const at = b * beat;
    const kick = new Float32Array(Math.round(0.25 * sr));
    for (let i = 0; i < kick.length; i++) {
      const t = i / sr;
      const f = 50 + 70 * Math.exp(-t * 25);
      kick[i] = 0.35 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 14);
    }
    for (let i = 0; i < kick.length && at + i < n; i++) {
      L[at + i] += kick[i];
      R[at + i] += kick[i];
    }
    if (b % 2 === 1) {
      const snare = new Float32Array(L.length);
      addNoiseBurst(snare, sr, at, 0.18, 0.2, false, rng);
      addTone(snare, sr, 190, 0.12, 0, at, at + Math.round(0.12 * sr), 0.05, 2);
      for (let i = at; i < Math.min(n, at + Math.round(0.2 * sr)); i++) {
        L[i] += snare[i];
        R[i] += snare[i];
      }
    }
    for (const h of [0, 1]) {
      const a = at + h * (beat >> 1);
      addNoiseBurst(L, sr, a, 0.04, 0.05, true, rng);
      addNoiseBurst(R, sr, a, 0.04, 0.05, true, rng);
    }
  }
  return { L, R };
}

const LINES: { start: number; notes: MelodyNote[] }[] = [
  {
    start: 0.5,
    notes: [
      [57, 0.9],
      [60, 0.5],
      [64, 0.6],
      [62, 0.9],
      [60, 0.6],
      [57, 0.7],
      [55, 0.8],
      [57, 1.5],
    ].map(([midi, durSec]) => ({ midi, durSec })),
  },
  {
    start: 9,
    notes: [
      [59, 0.8],
      [62, 0.6],
      [64, 0.9],
      [67, 0.7],
      [64, 0.6],
      [62, 0.8],
      [60, 0.6],
      [57, 1.6],
    ].map(([midi, durSec]) => ({ midi, durSec })),
  },
];

const GLIDE_SEC = 0.04;

const REST_MARGIN_SEC = 0.15;

function buildVocal(sr: number, opts: Required<SongStemsOptions>): { vocal: Float32Array; truthHz: Float64Array; rest: Uint8Array } {
  const n = Math.round(BASE_BLOCK_SEC * sr);
  const vocal = new Float32Array(n);
  const nFrames = Math.floor((n - 1) / (HOP_SEC * sr)) + 1;
  const truthHz = new Float64Array(nFrames).fill(NaN);
  const rest = new Uint8Array(nFrames).fill(1);
  LINES.forEach((line, li) => {
    const end = line.start + line.notes.reduce((t, nt) => t + nt.durSec, 0);
    for (let i = Math.max(0, Math.floor((line.start - REST_MARGIN_SEC) / HOP_SEC)); i <= Math.min(nFrames - 1, Math.ceil((end + REST_MARGIN_SEC) / HOP_SEC)); i++) rest[i] = 0;
    const notes = line.notes.map((nt) => ({ ...nt, midi: nt.midi + opts.transpose }));
    const sung = synthMelody(notes, {
      sampleRate: sr,
      seed: opts.seed + li,
      amplitude: 0.35,
      vibrato: { rateHz: 5.5, extentCents: opts.vibratoCents, delaySec: 0.2 },
      jitter: 0.002,
      glideSec: GLIDE_SEC,
      vowel: 'a',
    });
    vocal.set(sung.subarray(0, Math.min(sung.length, n - Math.round(line.start * sr))), Math.round(line.start * sr));
    let t0 = line.start;
    for (const nt of notes) {
      // Skip the glide in and the release: only the stable part of each note is ground truth.
      for (let i = Math.ceil((t0 + 0.08) / HOP_SEC); i * HOP_SEC < t0 + nt.durSec - 0.05; i++) {
        if (i < nFrames) truthHz[i] = hz(nt.midi);
      }
      t0 += nt.durSec;
    }
  });
  return { vocal, truthHz, rest };
}

const stemCache = new Map<string, SongStems>();
const bandCache = new Map<string, { L: Float32Array; R: Float32Array }>();

/** Moving bass line, one centred note every half second (A minor-ish, E2-G3), no chords or drums. */
function buildWalkingBass(sr: number): { L: Float32Array; R: Float32Array } {
  const n = Math.round(BASE_BLOCK_SEC * sr);
  const out = new Float32Array(n);
  const seq = [45, 48, 52, 50, 47, 45, 43, 40, 43, 47, 50, 52, 55, 52, 50, 47];
  const step = Math.round(0.5 * sr);
  for (let b = 0; b * 0.5 < BASE_BLOCK_SEC; b++) {
    const s = synthVoice({ sampleRate: sr, f0: hz(seq[b % seq.length]), durationSec: 0.5, vowel: 'none', tiltDbPerOct: -9, amplitude: 0.4, seed: 5 + b, attackSec: 0.01, releaseSec: 0.08 });
    out.set(s.subarray(0, Math.min(s.length, n - b * step)), b * step);
  }
  return { L: out, R: out };
}

/** Backing voices at `shifts` semitones from the lead (transposed with it), on the lead's own notes. */
function buildHarmony(sr: number, opts: Required<SongStemsOptions>, shifts: number[]): { L: Float32Array; R: Float32Array } {
  const n = Math.round(BASE_BLOCK_SEC * sr);
  const out = new Float32Array(n);
  shifts.forEach((sh, k) => {
    for (const line of LINES) {
      const notes = line.notes.map((nt) => ({ midi: nt.midi + opts.transpose + sh, durSec: nt.durSec }));
      const s = synthMelody(notes, {
        sampleRate: sr,
        seed: 20 + k,
        amplitude: 0.35,
        vibrato: { rateHz: 5.1 + 0.3 * k, extentCents: 18, delaySec: 0.25 },
        jitter: 0.002,
        vowel: 'o',
      });
      const at = Math.round(line.start * sr);
      out.set(s.subarray(0, Math.min(s.length, n - at)), at);
    }
  });
  return { L: out, R: out };
}

function bandFor(sr: number, opts: Required<SongStemsOptions>): { L: Float32Array; R: Float32Array } {
  if (opts.band === 'walking-bass') return buildWalkingBass(sr);
  if (opts.band === 'harmony') return buildHarmony(sr, opts, [4, -5]);
  const base = buildBand(sr, opts.seed);
  if (opts.band !== 'band-harmony') return base;
  // Harmony voices at half the power of the band, on top of it.
  const h = buildHarmony(sr, opts, [4, -5]).L;
  const bandMid = Float32Array.from(base.L, (v, i) => 0.5 * (v + base.R[i]));
  let pb = 0;
  let ph = 0;
  for (let i = 0; i < h.length; i++) {
    pb += bandMid[i] * bandMid[i];
    ph += h[i] * h[i];
  }
  const g = 0.5 * Math.sqrt(pb / (ph || 1));
  return { L: Float32Array.from(base.L, (v, i) => v + g * h[i]), R: Float32Array.from(base.R, (v, i) => v + g * h[i]) };
}

/** The base block of each stem. Cached per option set (the voice synthesiser takes about a second); the band is shared by all transpositions. */
export function makeSongStems(opts: SongStemsOptions = {}): SongStems {
  const full: Required<SongStemsOptions> = { sampleRate: 22050, transpose: 0, vibratoCents: 20, seed: 3, band: 'builtin', ...opts };
  const key = JSON.stringify(full);
  const hit = stemCache.get(key);
  if (hit) return hit;
  const { vocal, truthHz, rest } = buildVocal(full.sampleRate, full);
  // The harmony bands follow the lead's transposition; the others do not depend on it.
  const followsLead = full.band === 'harmony' || full.band === 'band-harmony';
  const bandKey = `${full.sampleRate}:${full.seed}:${full.band}${followsLead ? `:${full.transpose}` : ''}`;
  let band = bandCache.get(bandKey);
  if (!band) {
    band = bandFor(full.sampleRate, full);
    bandCache.set(bandKey, band);
  }
  const stems: SongStems = { sampleRate: full.sampleRate, vocal, bandL: band.L, bandR: band.R, truthHz, rest };
  stemCache.set(key, stems);
  return stems;
}

function tile(block: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let at = 0; at < length; at += block.length) out.set(block.subarray(0, Math.min(block.length, length - at)), at);
  return out;
}

/** Power of x over the samples around the truth-voiced frames of the base block. */
function sungPower(x: Float32Array, truthHz: Float64Array, sr: number): number {
  let sum = 0;
  let count = 0;
  const half = Math.round(0.5 * HOP_SEC * sr);
  for (let i = 0; i < truthHz.length; i++) {
    if (!Number.isFinite(truthHz[i])) continue;
    const c = Math.round(i * HOP_SEC * sr);
    for (let k = Math.max(0, c - half); k < Math.min(x.length, c + half); k++) {
      sum += x[k] * x[k];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Mixes the stems at an exact vocal-to-band ratio (RMS of the mono downmix over the sung frames) and tiles the base
 * block to `seconds`. `stereo: false` returns dual mono (L === R, the band folded to the centre).
 */
export function mixSong(stems: SongStems, vocalToBandDb: number, opts: { seconds?: number; stereo?: boolean } = {}): SongMix {
  const sr = stems.sampleRate;
  const seconds = opts.seconds ?? BASE_BLOCK_SEC;
  const stereo = opts.stereo ?? true;
  const bandMid = Float32Array.from(stems.bandL, (v, i) => 0.5 * (v + stems.bandR[i]));
  const pVocal = sungPower(stems.vocal, stems.truthHz, sr);
  const pBand = sungPower(bandMid, stems.truthHz, sr);
  const gain = Math.sqrt(pVocal / (pBand || 1)) / Math.pow(10, vocalToBandDb / 20);
  const length = Math.round(seconds * sr);
  const vocal = tile(stems.vocal, length);
  const bl = tile(stereo ? stems.bandL : bandMid, length);
  const br = stereo ? tile(stems.bandR, length) : bl;
  const left = new Float32Array(length);
  const right = stereo ? new Float32Array(length) : left;
  for (let i = 0; i < length; i++) {
    left[i] = vocal[i] + gain * bl[i];
    if (stereo) right[i] = vocal[i] + gain * br[i];
  }
  const mono = stereo ? Float32Array.from(left, (v, i) => 0.5 * (v + right[i])) : left;
  const nFrames = Math.floor((length - 1) / (HOP_SEC * sr)) + 1;
  const truthHz = new Float64Array(nFrames).fill(NaN);
  const baseFrames = stems.truthHz.length - 1; // the last frame of a block coincides with the first of the next
  const rest = new Uint8Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    truthHz[i] = stems.truthHz[i % baseFrames];
    rest[i] = stems.rest[i % baseFrames];
  }
  return { sampleRate: sr, left, right, mono, vocal, truthHz, rest, vocalToBandDb };
}

/**
 * Raw pitch accuracy (mir_eval): the share of ground-truth voiced frames whose estimate is within `tolCents`.
 * `est` holds Hz with NaN or 0 for unvoiced. Frames beyond the shorter array are ignored.
 */
export function rawPitchAccuracy(est: ArrayLike<number>, truthHz: Float64Array, tolCents = 50): number {
  let ok = 0;
  let n = 0;
  for (let i = 0; i < truthHz.length && i < est.length; i++) {
    if (!Number.isFinite(truthHz[i])) continue;
    n++;
    if (est[i] > 0 && Math.abs(1200 * Math.log2(est[i] / truthHz[i])) < tolCents) ok++;
  }
  return n > 0 ? ok / n : 0;
}

/**
 * Voicing false-alarm rate: the share of rest frames (SongStems.rest, the band playing alone) that `f0` (Hz, NaN or 0 =
 * unvoiced) reports as voiced. Frames beyond the shorter array are ignored; 0 when there are no rest frames.
 */
export function voicingFalseAlarm(f0: ArrayLike<number>, rest: Uint8Array): number {
  let n = 0;
  let wrong = 0;
  for (let i = 0; i < rest.length && i < f0.length; i++) {
    if (!rest[i]) continue;
    n++;
    if (f0[i] > 0) wrong++;
  }
  return n > 0 ? wrong / n : 0;
}
