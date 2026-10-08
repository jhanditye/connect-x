// Per-frame features: the pitch track plus voice-quality measures for every voiced frame, and a
// few derived per-frame indices that the register, breathiness, brightness and rasp estimates
// share.

import { nextPow2, rfft } from '../dsp/fft';
import { hzToMidi } from '../dsp/music';
import type { PitchTrack } from '../dsp/pitch';
import { analyzeSpectralFrame, hnrFromPeriodicity } from '../dsp/spectral';
import { clamp } from '../dsp/stats';
import type { FrameFeatures } from '../types';

/** Frame features plus internal per-frame measures that have no slot in FrameFeatures. */
export interface FrameTrack {
  frames: FrameFeatures[];
  hopSec: number;
  /** Noise-compensated subharmonic level from the DSP (-60 = none), NaN when unvoiced. */
  subharmonicDb: Float64Array;
  /** Harmonic-only alpha ratio (see harmonicBalanceDb), NaN when unvoiced or unmeasurable. */
  harmonicBalanceDb: Float64Array;
  /** Pitch-normalised harmonic balance, dB per octave (see harmonicSlope). */
  harmonicSlope: Float64Array;
  /** 0..1 aspiration-noise index (see aspirationIndex), NaN when unvoiced. */
  aspiration: Float64Array;
  /** H1-H2 with the open-vowel pitch effect removed (see normalizedH1H2), NaN when unvoiced. */
  h1h2Norm: Float64Array;
}

/**
 * Aspiration-noise index, 0 = clean phonation, 1 = noise-dominated.
 *
 * Two independent noise measures must agree, so we take the smaller of the two:
 * - HNR from YIN periodicity. On the synthesiser: clean 40 dB, light mix ~20, falsetto 9,
 *   breathy (breath 0.6) 4.5. Rasp and jitter also lower it (the subharmonics count as aperiodic
 *   energy), so on its own it would call a raspy voice breathy.
 * - CPP. Clean synth tones read 28-35 dB, a real modal voice at 30-40 dB SNR ~21-23, light mix
 *   17-21, breathy/falsetto 13.5-17, but rasp stays high (21-27): the harmonic comb survives.
 * Recording noise lowers both (at 20 dB SNR a modal tone reads CPP 18.5 and HNR 20), and the
 * minimum keeps that from reading as a breathy voice.
 */
export function aspirationIndex(hnrDb: number, cppDb: number): number {
  if (Number.isNaN(hnrDb) || Number.isNaN(cppDb)) return NaN;
  const fromHnr = clamp((22 - hnrDb) / 28, 0, 1);
  const fromCpp = clamp((22 - cppDb) / 8, 0, 1);
  return Math.min(fromHnr, fromCpp);
}

/**
 * Pitch correction for H1-H2 (dB to add), piecewise linear in MIDI. Measured H1-H2 is not
 * formant-corrected: for open vowels (F1 ~ 500-750 Hz) it falls as f0 rises from C3 to D4 because
 * H2 climbs onto F1 (on the synthesiser, averaged over /a/ and /o/: -2.5 dB by G3, -12 dB by D4,
 * then roughly level). Adding this back makes each voice setting read about the same at every
 * pitch: pressed ~4 dB, chest-like ~6, modal ~10, light mix ~14, breathy ~20, falsetto ~28.
 */
const H1H2_PITCH_KNOTS: [number, number][] = [
  [48, 0],
  [55, 2.5],
  [62, 12],
];

/**
 * H1-H2 with the average pitch effect of open vowels removed (see H1H2_PITCH_KNOTS). Close
 * vowels (/i/, /u/) and mid vowels high in the range (where f0 approaches F1) still read 10-25 dB
 * higher, which is why register and breathiness are take-level estimates, not verdicts. Uses
 * concert pitch (A4 = 440 Hz) because the effect depends on absolute frequency.
 */
export function normalizedH1H2(h1h2Db: number, f0Hz: number): number {
  if (Number.isNaN(h1h2Db) || !(f0Hz > 0)) return NaN;
  const midi = hzToMidi(f0Hz);
  const k = H1H2_PITCH_KNOTS;
  let corr = k[k.length - 1][1];
  if (midi <= k[0][0]) corr = k[0][1];
  else {
    for (let i = 1; i < k.length; i++) {
      if (midi <= k[i][0]) {
        corr = k[i - 1][1] + ((midi - k[i - 1][0]) / (k[i][0] - k[i - 1][0])) * (k[i][1] - k[i - 1][1]);
        break;
      }
    }
  }
  return h1h2Db + corr;
}

// ---------------------------------------------------------------------------------------------
// Harmonic balance: an alpha ratio computed from the harmonics only.

const REF_RATE = 22050;
const BALANCE_WINDOW = 2048;
/**
 * Harmonics are shared between the bands with a linear crossover from 700 to 1300 Hz. A hard
 * 1 kHz split made the value jump by up to 15 dB whenever a strong harmonic near F2 of /a/
 * (~1.1 kHz) crossed the split as the pitch changed.
 */
const BALANCE_CROSS_LO_HZ = 700;
const BALANCE_CROSS_HI_HZ = 1300;
const BALANCE_LOW_HZ = 50;
const BALANCE_HIGH_HZ = 5000;
/** Reference frequency for harmonicSlope's pitch normalisation. */
const BALANCE_REF_HZ = 1300;
/**
 * Harmonic band +/- 0.2 f0 (wider than the Hann main lobe, +/- 21.5 Hz, for f0 >= ~110 Hz, and
 * wide enough to keep a vibrato-smeared upper harmonic). The noise floor is read at +/- 0.28 f0
 * (+/- 0.04 f0): outside the harmonic's main lobe but clear of the midpoint (k + 0.5) f0, where a
 * raspy voice's subharmonics sit and would otherwise be subtracted as "noise".
 */
const BALANCE_BAND_REL = 0.2;
const BALANCE_FLOOR_CENTRE_REL = 0.28;
const BALANCE_FLOOR_HALF_REL = 0.04;
const BALANCE_FLOOR_DB = -60;

interface BalanceContext {
  winLen: number;
  fftSize: number;
  binHz: number;
  window: Float64Array;
  frame: Float64Array;
  re: Float64Array;
  im: Float64Array;
  power: Float64Array;
}

const balanceContexts = new Map<number, BalanceContext>();

function balanceContext(sampleRate: number): BalanceContext {
  const cached = balanceContexts.get(sampleRate);
  if (cached) return cached;
  const winLen = 2 * Math.round((BALANCE_WINDOW * sampleRate) / REF_RATE / 2);
  const fftSize = nextPow2(winLen);
  const window = new Float64Array(winLen);
  for (let i = 0; i < winLen; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / winLen);
  const ctx: BalanceContext = {
    winLen,
    fftSize,
    binHz: sampleRate / fftSize,
    window,
    frame: new Float64Array(fftSize),
    re: new Float64Array(fftSize / 2 + 1),
    im: new Float64Array(fftSize / 2 + 1),
    power: new Float64Array(fftSize / 2 + 1),
  };
  balanceContexts.set(sampleRate, ctx);
  return ctx;
}

function bandSum(power: Float64Array, binHz: number, loHz: number, hiHz: number): { sum: number; bins: number } {
  const lo = Math.max(1, Math.round(loHz / binHz));
  const hi = Math.min(power.length - 1, Math.max(lo, Math.round(hiHz / binHz)));
  let sum = 0;
  for (let k = lo; k <= hi; k++) sum += power[k];
  return { sum, bins: hi - lo + 1 };
}

/**
 * Energy of the harmonics in ~1-5 kHz relative to the harmonics in 50 Hz-~1 kHz, dB, counting only
 * each harmonic's energy above the local inter-harmonic floor.
 *
 * The ordinary alpha ratio (FrameFeatures.alphaRatioDb) integrates every bin, so aspiration noise,
 * which is broadband, makes breathy and falsetto tones read as bright as a belt (on the
 * synthesiser: breathy -12 dB, falsetto -17, modal -16 to -21). Here aspiration noise is
 * subtracted as floor, so a breathy tone whose upper harmonics are buried in noise reads dark,
 * which matches how its tonal part sounds. Floored at -60 dB.
 */
export function harmonicBalanceDb(x: Float32Array, sampleRate: number, centre: number, f0: number): number {
  const nyquist = sampleRate / 2;
  if (!(f0 > 0) || f0 >= BALANCE_CROSS_HI_HZ || !(sampleRate > 0)) return NaN;
  const ctx = balanceContext(sampleRate);
  const { winLen, fftSize, binHz, window, frame, re, im, power } = ctx;
  const start = Math.round(centre) - winLen / 2;
  let energy = 0;
  for (let i = 0; i < winLen; i++) {
    const idx = start + i;
    const v = idx >= 0 && idx < x.length ? x[idx] * window[i] : 0;
    frame[i] = v;
    energy += v * v;
  }
  if (!(energy > 0)) return NaN;
  rfft(frame, fftSize, re, im);
  for (let k = 0; k < power.length; k++) power[k] = re[k] * re[k] + im[k] * im[k];

  // Harmonic and floor energy are summed per band before subtracting: clamping each harmonic's
  // excess at zero would turn the floor estimate's random error into a positive bias that, summed
  // over the many buried upper harmonics of a breathy tone, reads as brightness.
  let lowHarm = 0;
  let lowFloor = 0;
  let highHarm = 0;
  let highFloor = 0;
  const topHz = Math.min(BALANCE_HIGH_HZ, nyquist * 0.95);
  for (let h = 1; h * f0 <= topHz; h++) {
    const fh = h * f0;
    if (fh < BALANCE_LOW_HZ) continue;
    const band = bandSum(power, binHz, fh - BALANCE_BAND_REL * f0, fh + BALANCE_BAND_REL * f0);
    const fc = BALANCE_FLOOR_CENTRE_REL * f0;
    const fw = BALANCE_FLOOR_HALF_REL * f0;
    const below = bandSum(power, binHz, fh - fc - fw, fh - fc + fw);
    const above = bandSum(power, binHz, fh + fc - fw, fh + fc + fw);
    const floor = 0.5 * (below.sum / below.bins + above.sum / above.bins) * band.bins;
    const wHigh = clamp((fh - BALANCE_CROSS_LO_HZ) / (BALANCE_CROSS_HI_HZ - BALANCE_CROSS_LO_HZ), 0, 1);
    lowHarm += (1 - wHigh) * band.sum;
    lowFloor += (1 - wHigh) * floor;
    highHarm += wHigh * band.sum;
    highFloor += wHigh * floor;
  }
  const low = lowHarm - lowFloor;
  const high = Math.max(0, highHarm - highFloor);
  if (!(low > 0)) return NaN;
  return Math.max(BALANCE_FLOOR_DB, 10 * Math.log10(high / low + 1e-30));
}

/**
 * The harmonic balance divided by the distance in octaves from f0 to 1.3 kHz: a noise-robust
 * spectral-slope estimate in dB per octave.
 *
 * The balance compares the upper harmonics (~1-2 kHz carry most of that band for a falling
 * spectrum) with a low band that H1 dominates, so for a given source slope it grows roughly with
 * log2(1300 / f0): the same dark voice reads 27 dB brighter at G4 than at A2. Dividing by that
 * distance makes a voice setting read about the same across the range (synthesiser, vowel /a/,
 * A2-G4: output slope -6 dB/oct -> about -2.4, -12 -> -4.8, -20 -> -10). The distance is floored
 * at one octave so high soprano notes do not blow it up.
 */
export function harmonicSlope(balanceDb: number, f0: number): number {
  if (Number.isNaN(balanceDb) || !(f0 > 0)) return NaN;
  return balanceDb / Math.max(1, Math.log2(BALANCE_REF_HZ / f0));
}

/** A voiced frame this far (semitones) from both voiced neighbours is a tracking glitch. */
const SPIKE_SEMITONES = 5;

/**
 * Unvoices isolated pitch spikes: a voiced frame more than 5 semitones away from each adjacent
 * voiced frame (or from its only neighbour at the edge of a voiced stretch). The tracker can
 * report a spurious short lag on the frame where a tone's first cycles enter its window from
 * silence (e.g. 1470 Hz on the frame before a 220 Hz onset), which would otherwise become a
 * one-frame "note" three octaves up. Returns cleaned copies of f0 and voiced.
 */
export function despikePitch(f0: Float64Array, voiced: Uint8Array): { f0: Float64Array; voiced: Uint8Array } {
  const n = f0.length;
  const outF0 = Float64Array.from(f0);
  const outV = Uint8Array.from(voiced);
  const semis = (hz: number) => 12 * Math.log2(hz / 440);
  for (let pass = 0; pass < 2; pass++) {
    const spikes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!outV[i] || !(outF0[i] > 0)) continue;
      const hasPrev = i > 0 && outV[i - 1] === 1 && outF0[i - 1] > 0;
      const hasNext = i < n - 1 && outV[i + 1] === 1 && outF0[i + 1] > 0;
      if (!hasPrev && !hasNext) continue;
      const s = semis(outF0[i]);
      const farPrev = !hasPrev || Math.abs(s - semis(outF0[i - 1])) > SPIKE_SEMITONES;
      const farNext = !hasNext || Math.abs(s - semis(outF0[i + 1])) > SPIKE_SEMITONES;
      if (farPrev && farNext) spikes.push(i);
    }
    if (spikes.length === 0) break;
    for (const i of spikes) {
      outV[i] = 0;
      outF0[i] = NaN;
    }
  }
  return { f0: outF0, voiced: outV };
}

// ---------------------------------------------------------------------------------------------

export interface FrameTrackOptions {
  /**
   * Measure the per-frame voice-quality features (default true). With `false` only the pitch-derived fields (f0, midi,
   * voiced, periodicity, rmsDb) are filled and every spectral field stays NaN: this is what mix mode (analysis/mixMode.ts)
   * uses, because a song mix has no clean voice spectrum to measure. `x` and `sampleRate` are then not read.
   */
  spectral?: boolean;
}

/**
 * Builds FrameFeatures for every pitch-track frame and measures voice quality on voiced frames.
 * `x` must be the signal the track was computed from. Register labels are filled in later.
 * `onProgress` receives 0..1 over the spectral pass (the slow part).
 */
export function buildFrameTrack(
  x: Float32Array,
  sampleRate: number,
  track: PitchTrack,
  a4Hz: number,
  onProgress?: (fraction: number) => void,
  opts: FrameTrackOptions = {},
): FrameTrack {
  const spectral = opts.spectral !== false;
  const n = track.f0.length;
  const clean = despikePitch(track.f0, track.voiced);
  const frames: FrameFeatures[] = new Array(n);
  const subharmonicDb = new Float64Array(n).fill(NaN);
  const harmonicBalance = new Float64Array(n).fill(NaN);
  const slope = new Float64Array(n).fill(NaN);
  const aspiration = new Float64Array(n).fill(NaN);
  const h1h2Norm = new Float64Array(n).fill(NaN);
  const reportEvery = Math.max(1, Math.floor(n / 20));

  for (let i = 0; i < n; i++) {
    const f0 = clean.f0[i];
    const voiced = clean.voiced[i] === 1 && f0 > 0;
    const t = track.times[i];
    const periodicity = track.periodicity[i];
    const frame: FrameFeatures = {
      t,
      f0: voiced ? f0 : NaN,
      midi: voiced ? hzToMidi(f0, a4Hz) : NaN,
      voiced,
      periodicity,
      rmsDb: track.rmsDb[i],
      h1h2Db: NaN,
      alphaRatioDb: NaN,
      centroidHz: NaN,
      tiltDbPerOct: NaN,
      cppDb: NaN,
      hnrDb: NaN,
      register: null,
    };
    if (voiced && spectral) {
      const centre = Math.round(t * sampleRate);
      const s = analyzeSpectralFrame(x, sampleRate, centre, f0);
      frame.h1h2Db = s.h1h2Db;
      frame.alphaRatioDb = s.alphaRatioDb;
      frame.centroidHz = s.centroidHz;
      frame.tiltDbPerOct = s.tiltDbPerOct;
      frame.cppDb = s.cppDb;
      frame.hnrDb = hnrFromPeriodicity(periodicity);
      subharmonicDb[i] = s.subharmonicDb;
      harmonicBalance[i] = harmonicBalanceDb(x, sampleRate, centre, f0);
      slope[i] = harmonicSlope(harmonicBalance[i], f0);
      aspiration[i] = aspirationIndex(frame.hnrDb, frame.cppDb);
      h1h2Norm[i] = normalizedH1H2(frame.h1h2Db, f0);
    }
    frames[i] = frame;
    if (onProgress && i % reportEvery === 0) onProgress(i / n);
  }
  onProgress?.(1);
  return {
    frames,
    hopSec: track.hopSec,
    subharmonicDb,
    harmonicBalanceDb: harmonicBalance,
    harmonicSlope: slope,
    aspiration,
    h1h2Norm,
  };
}
