// Voice-quality measures for one voiced frame, given its f0.
//
// CALIBRATION on the synthesiser (src/testing/synth.ts). Regenerate with
//   npx vitest run src/dsp/spectral.calibration.test.ts --silent=false
// Medians over frames 0.1-0.7 s of 0.8 s tones. Spectral measures use the true f0; periodicity is
// trackPitch's over voiced frames (all frames when none are voiced); HNR = hnrFromPeriodicity.
// Voices: pressed tilt -7 dB/oct | modal -12 | light mix -14, H1 +3 dB, breath 0.15 |
// breathy -16, H1 +6, breath 0.6 | falsetto -20, H1 +10, breath 0.35 | whisper-ish -16,
// breath 1.5 | rasp -9, subharmonic 0.4, jitter 0.02, shimmer 0.08.
// Columns: voiced share, periodicity, HNR dB, H1-H2 dB, tilt dB/oct, alpha ratio dB,
// centroid Hz, CPP dB, subharmonic dB.
//
//   voice / f0 / vowel     voic%  per.   HNR  H1-H2   tilt  alpha  centr   CPP   subh
//   pressed 147 a           100%  1.00  40.0    5.2  -17.8   -9.5    710  35.1  -60.0
//   pressed 147 i           100%  1.00  40.0   -1.0  -13.8  -30.6    386  35.1  -60.0
//   pressed 220 a           100%  1.00  40.0    2.5  -20.6   -5.3    762  33.2  -60.0
//   pressed 220 i           100%  1.00  40.0   19.1  -14.3  -31.0    406  31.7  -60.0
//   pressed 330 a           100%  1.00  40.0   -8.2  -23.6  -16.2    756  31.4  -60.0
//   pressed 330 i           100%  1.00  40.0   25.0  -16.7  -22.0    621  31.9  -60.0
//   modal 147 a             100%  1.00  40.0   10.2  -20.0  -16.4    503  34.2  -60.0
//   modal 147 i             100%  1.00  40.0    4.0  -15.4  -47.9    236  32.7  -60.0
//   modal 220 a             100%  1.00  40.0    7.5  -22.5  -11.4    591  31.5  -60.0
//   modal 220 i             100%  1.00  40.0   24.1  -15.1  -47.5    262  28.5  -60.0
//   modal 330 a             100%  1.00  40.0   -3.2  -23.8  -20.0    647  29.1  -60.0
//   modal 330 i             100%  1.00  40.0   30.0  -16.7  -36.1    402  28.3  -60.0
//   light mix 147 a         100%  0.98  16.7   15.2   -8.8  -20.9   2458  20.4  -51.2
//   light mix 147 i         100%  0.98  16.8    9.0   -8.7  -24.5   2668  17.1  -39.9
//   light mix 220 a         100%  0.98  16.6   12.5  -10.5  -16.3   2456  18.7  -45.2
//   light mix 220 i         100%  0.98  16.8   29.3  -11.2  -24.6   2929  15.6  -36.9
//   light mix 330 a         100%  0.98  16.4    1.8  -13.2  -20.9   2594  17.2  -44.4
//   light mix 330 i         100%  0.98  16.5   34.8  -12.7  -24.5   2993  14.6  -38.6
//   breathy 147 a           100%  0.74   4.5   20.4   -5.2  -12.3   4066  16.9  -40.4
//   breathy 147 i           100%  0.74   4.5   14.1   -5.7  -12.4   4112  16.4  -36.8
//   breathy 220 a           100%  0.74   4.6   17.6   -9.2  -12.2   4014  16.3  -39.7
//   breathy 220 i           100%  0.74   4.6   34.3   -7.3  -12.6   4190  14.4  -34.9
//   breathy 330 a           100%  0.73   4.4    6.8   -9.9  -12.4   4016  15.5  -40.3
//   breathy 330 i           100%  0.73   4.4   35.8  -10.1  -12.5   4214  13.6  -36.0
//   falsetto 147 a          100%  0.89   9.2   28.5   -5.3  -17.1   3760  16.4  -38.4
//   falsetto 147 i          100%  0.89   9.2   22.2   -6.4  -17.1   3759  16.3  -36.6
//   falsetto 220 a          100%  0.89   9.2   25.6  -13.9  -17.2   3733  16.0  -37.8
//   falsetto 220 i          100%  0.89   9.2   40.5   -8.5  -17.2   3812  14.6  -35.0
//   falsetto 330 a          100%  0.89   9.0   14.8  -16.5  -17.1   3711  15.3  -39.9
//   falsetto 330 i          100%  0.89   9.0   40.8  -11.7  -17.2   3837  13.5  -36.6
//   whisper-ish 147 a         0%  0.31  -3.6   14.4   -3.8   -4.4   4487  16.5  -39.8
//   whisper-ish 147 i         0%  0.31  -3.5    8.1   -4.4   -4.5   4528  16.1  -36.7
//   whisper-ish 220 a         0%  0.32  -3.4   11.7   -6.6   -4.5   4443  16.2  -38.0
//   whisper-ish 220 i         0%  0.32  -3.3   27.3   -5.3   -4.7   4579  14.3  -34.8
//   whisper-ish 330 a         0%  0.31  -3.5    0.7   -5.8   -4.5   4478  14.7  -39.1
//   whisper-ish 330 i         0%  0.32  -3.3   28.0   -7.4   -4.6   4597  13.4  -35.4
//   rasp 147 a               98%  0.39  -2.0    7.3   -1.4  -12.3    639  24.7  -14.7
//   rasp 147 i              100%  0.33  -3.1    1.0  -16.8  -37.9    298  26.7  -16.7
//   rasp 220 a              100%  0.38  -2.1    4.6  -14.1   -9.1    714  23.9  -16.9
//   rasp 220 i              100%  0.57   1.2   21.3  -13.9  -37.1    349  23.4  -16.1
//   rasp 330 a              100%  0.63   2.3   -5.9  -23.8  -14.4    799  21.3  -13.0
//   rasp 330 i              100%  0.10  -5.0   27.0  -12.4  -31.0    469  23.4  -29.8
//
//   Medians over f0 147/220/330 Hz x vowels a/i:
//   voice / f0 / vowel     voic%  per.   HNR  H1-H2   tilt  alpha  centr   CPP   subh
//   pressed                 100%  1.00  40.0    3.8  -17.2  -19.1    665  32.6  -60.0
//   modal                   100%  1.00  40.0    8.8  -18.3  -28.0    453  30.3  -60.0
//   light mix               100%  0.98  16.7   13.9  -10.8  -22.7   2631  17.2  -42.2
//   breathy                 100%  0.74   4.5   19.0   -8.3  -12.4   4089  15.9  -38.2
//   falsetto                100%  0.89   9.2   27.1  -10.1  -17.1   3759  15.7  -37.2
//   whisper-ish               0%  0.31  -3.4   13.1   -5.6   -4.5   4508  15.4  -37.3
//   rasp                    100%  0.38  -2.0    6.0  -14.0  -22.7    554  23.7  -16.4
//
//   Recording noise (white, SNR re tone RMS), 220 Hz vowel a:
//   voice / f0 / vowel     voic%  per.   HNR  H1-H2   tilt  alpha  centr   CPP   subh
//   modal SNR 40 dB         100%  1.00  39.0    7.5  -17.3  -11.4    766  23.4  -53.0
//   modal SNR 30 dB         100%  1.00  30.2    7.5  -14.4  -11.4   1096  21.0  -48.5
//   modal SNR 20 dB         100%  0.99  20.3    7.5  -10.0  -11.2   1824  18.5  -44.1
//   breathy SNR 40 dB       100%  0.74   4.6   17.6   -9.2  -12.2   4014  16.4  -39.4
//   breathy SNR 30 dB       100%  0.74   4.6   17.6   -9.3  -12.2   4014  16.1  -40.6
//   breathy SNR 20 dB       100%  0.74   4.5   17.7   -9.2  -11.9   3993  15.4  -38.6
//
// Reading the numbers:
// - The synthesiser has no recording noise, which inflates the CPP of clean tones (28-35 dB).
//   With 30-40 dB SNR a modal tone reads ~21-23 dB; breath-dominated tones stay ~13-17 dB.
// - H1-H2 is not formant-corrected: /i/ (F1 ~270 Hz, near H1) adds 10-25 dB, and /a/ at 330 Hz
//   (H2 near F1) goes negative. Compare within a vowel or use medians over a whole take.
// - Alpha ratio and centroid rise with aspiration noise (the synthesiser's breath noise is
//   broadband), so breathy and falsetto tones read "brighter" than modal ones. Judge brightness
//   on clear (high-CPP) frames or from harmonicDb.
// - Tilt includes the vowel envelope; the synthesiser has no +6 dB/oct lip radiation, so its
//   vowels read steeper than real voices. Breath noise flattens tilt.
// - subharmonicDb: -60 means none; breath-type tones read -35 to -51; rasp -13 to -30.
// - Periodicity/HNR: clean 1.00/40 dB, light mix 0.98/17, falsetto 0.89/9, breathy 0.74/4.5,
//   whisper-ish 0.31 (unvoiced); rasp 0.1-0.6, measured at the sung period, where the
//   subharmonics count as aperiodic energy.

import { nextPow2, rfft } from './fft';

export interface SpectralFrame {
  h1h2Db: number;
  alphaRatioDb: number;
  centroidHz: number;
  tiltDbPerOct: number;
  cppDb: number;
  harmonicDb: number[]; // first 10 harmonic levels relative to H1 (H1 = 0)
  subharmonicDb: number; // energy between harmonics at odd multiples of f0/2 relative to harmonics, dB (noise-compensated, floor -60)
}

/** 2048 samples at 22.05 kHz (~93 ms): six periods even at 65 Hz; the Hann main lobe (+/-21.5 Hz) resolves harmonics spaced >= ~45 Hz. */
const REF_RATE = 22050;
const REF_WINDOW = 2048;
const HARMONIC_COUNT = 10;
/** Harmonic search half-width: +/-15 % of k*f0, capped at 0.3*f0 so neighbouring harmonics never overlap. */
const HARMONIC_SEARCH_REL = 0.15;
const HARMONIC_SEARCH_CAP = 0.3;
const MIN_SEARCH_BINS = 2;
/** Tilt regression uses harmonics up to this frequency (and needs at least 3 of them). */
const TILT_MAX_HZ = 5000;
/**
 * A harmonic only enters the tilt regression if it stands at least this far above the spectrum
 * midway to its neighbours, i.e. it is distinguishable from the noise/leakage floor at all.
 * Floor-bound "harmonics" otherwise bend the slope toward the floor (a clean -24 dB/oct source
 * read as -17). With heavy aspiration noise the regression then rests on the few low harmonics
 * that remain, whose local slope near F1 is flatter: breathy voices read flatter than their
 * source tilt (see the calibration table).
 */
const TILT_MIN_PROMINENCE_DB = 6;
const ALPHA_LOW_HZ = 50;
const ALPHA_SPLIT_HZ = 1000;
const ALPHA_HIGH_HZ = 5000;
const CENTROID_LOW_HZ = 50;
const CENTROID_HIGH_HZ = 8000;
/**
 * Cepstral trend line from 1 ms to 50 ms quefrency, Praat's default range for peak prominence.
 * It spans every period in the 65-1000 Hz singing range, so the baseline under the rahmonic peak
 * is interpolated rather than extrapolated, and the line is the same for every f0 (CPP values
 * stay comparable across notes).
 */
const CPP_TREND_LO_SEC = 0.001;
const CPP_TREND_HI_SEC = 0.05;
/** Rahmonic search: +/-15 % around the known period. */
const CPP_SEARCH_REL = 0.15;
/** Floor for the dB spectrum, relative to its maximum; keeps near-zero bins from dominating the cepstrum. */
const SPECTRUM_FLOOR_REL = 1e-10;
/** Subharmonic measure: first 8 harmonics and the midpoints (k + 0.5) * f0 after them. */
const SUBHARMONIC_COUNT = 8;
const SUBHARMONIC_BAND_REL = 0.1;
const SUBHARMONIC_FLOOR_BAND_REL = 0.05;
/** Per-harmonic floor: "no subharmonic energy distinguishable from noise". */
const SUBHARMONIC_FLOOR_DB = -60;
/** Midpoint levels are the peak within +/-10 % of f0 (at least 2 bins) around (k + 0.5) * f0. */
const MIDPOINT_SEARCH_REL = 0.1;

interface Context {
  sampleRate: number;
  winLen: number;
  fftSize: number;
  binHz: number;
  nBins: number;
  window: Float64Array;
  frame: Float64Array;
  re: Float64Array;
  im: Float64Array;
  power: Float64Array;
  db: Float64Array;
  ceps: Float64Array;
  cre: Float64Array;
  cim: Float64Array;
  levels: Float64Array;
  /** mids[k] = level at (k + 0.5) * f0, midway between harmonics k and k + 1 (k = 0 is f0 / 2). */
  mids: Float64Array;
  /** Cepstral trend-line quefrency range (samples) and its precomputed regression sums. */
  qLo: number;
  qHi: number;
  sq: number;
  sqq: number;
}

const contexts = new Map<number, Context>();

function contextFor(sampleRate: number): Context {
  const cached = contexts.get(sampleRate);
  if (cached) return cached;
  const winLen = 2 * Math.round((REF_WINDOW * sampleRate) / REF_RATE / 2);
  // 2x zero padding: finer bins for peak picking and a cepstrum long enough for the trend range.
  const fftSize = 2 * nextPow2(winLen);
  const nBins = fftSize / 2 + 1;
  const window = new Float64Array(winLen);
  for (let i = 0; i < winLen; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / winLen);
  const qLo = Math.max(1, Math.round(CPP_TREND_LO_SEC * sampleRate));
  const qHi = Math.min(fftSize / 2 - 1, Math.round(CPP_TREND_HI_SEC * sampleRate));
  let sq = 0;
  let sqq = 0;
  for (let q = qLo; q <= qHi; q++) {
    sq += q;
    sqq += q * q;
  }
  const ctx: Context = {
    sampleRate,
    winLen,
    fftSize,
    binHz: sampleRate / fftSize,
    nBins,
    window,
    frame: new Float64Array(winLen),
    re: new Float64Array(nBins),
    im: new Float64Array(nBins),
    power: new Float64Array(nBins),
    db: new Float64Array(nBins),
    ceps: new Float64Array(fftSize),
    cre: new Float64Array(nBins),
    cim: new Float64Array(nBins),
    levels: new Float64Array(256),
    mids: new Float64Array(256),
    qLo,
    qHi,
    sq,
    sqq,
  };
  contexts.set(sampleRate, ctx);
  return ctx;
}

function nanFrame(): SpectralFrame {
  return {
    h1h2Db: NaN,
    alphaRatioDb: NaN,
    centroidHz: NaN,
    tiltDbPerOct: NaN,
    cppDb: NaN,
    harmonicDb: new Array<number>(HARMONIC_COUNT).fill(NaN),
    subharmonicDb: NaN,
  };
}

/**
 * Peak level (dB) of the spectrum within +/- halfHz of fHz, refined by parabolic interpolation
 * of the dB values around the maximum bin. NaN if the band is outside the spectrum.
 */
function peakDb(ctx: Context, fHz: number, halfHz: number): number {
  const { db, binHz, nBins } = ctx;
  const centre = fHz / binHz;
  const half = Math.max(MIN_SEARCH_BINS, halfHz / binHz);
  const lo = Math.max(1, Math.floor(centre - half));
  const hi = Math.min(nBins - 2, Math.ceil(centre + half));
  if (lo > hi) return NaN;
  let m = lo;
  for (let k = lo + 1; k <= hi; k++) if (db[k] > db[m]) m = k;
  const a = db[m - 1];
  const b = db[m];
  const c = db[m + 1];
  const den = a - 2 * b + c;
  if (den >= 0) return b;
  const p = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  return b - 0.25 * (a - c) * p;
}

/** Measure one voiced frame of `x` centred at sample index `centre`, given its f0. Uses a ~93 ms Hann window at 22050 Hz. */
export function analyzeSpectralFrame(x: Float32Array, sampleRate: number, centre: number, f0: number): SpectralFrame {
  const nyquist = sampleRate / 2;
  if (!(f0 > 0) || !Number.isFinite(f0) || !(sampleRate > 0) || 2 * f0 >= nyquist * 0.95) return nanFrame();
  const ctx = contextFor(sampleRate);
  const { winLen, fftSize, binHz, nBins, window, frame, re, im, power, db } = ctx;

  // Windowed frame (zeros beyond the signal) -> power spectrum -> floored dB spectrum.
  const start = Math.round(centre) - winLen / 2;
  const len = x.length;
  for (let i = 0; i < winLen; i++) {
    const idx = start + i;
    frame[i] = idx >= 0 && idx < len ? x[idx] * window[i] : 0;
  }
  rfft(frame, fftSize, re, im);
  let maxP = 0;
  for (let k = 0; k < nBins; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    power[k] = p;
    if (p > maxP) maxP = p;
  }
  if (!(maxP > 0)) return nanFrame();
  const floorP = maxP * SPECTRUM_FLOOR_REL;
  for (let k = 0; k < nBins; k++) db[k] = 10 * Math.log10(power[k] > floorP ? power[k] : floorP);

  // Harmonic levels L_k and midpoint levels M_k at (k + 0.5) * f0 (dB), up to the frequencies any
  // measure needs.
  const maxHarmonicHz = Math.min(nyquist * 0.95, Math.max(TILT_MAX_HZ, (HARMONIC_COUNT + 0.5) * f0));
  const kMax = Math.min(ctx.levels.length - 2, Math.floor(maxHarmonicHz / f0));
  const { levels, mids } = ctx;
  for (let k = 1; k <= kMax; k++) {
    const halfHz = Math.min(HARMONIC_SEARCH_REL * k * f0, HARMONIC_SEARCH_CAP * f0);
    levels[k] = peakDb(ctx, k * f0, halfHz);
  }
  for (let k = 0; k <= kMax; k++) {
    mids[k] = (k + 0.5) * f0 < nyquist * 0.95 ? peakDb(ctx, (k + 0.5) * f0, MIDPOINT_SEARCH_REL * f0) : NaN;
  }

  // H1-H2 straight from the spectrum, not corrected for formants (Iseli-Alwan style correction
  // would need formant estimates). A low F1 near H1 or H2 (vowels /i/, /u/) therefore shifts it,
  // so compare takes on similar vowels.
  const h1h2Db = kMax >= 2 ? levels[1] - levels[2] : NaN;

  const harmonicDb: number[] = [];
  for (let k = 1; k <= HARMONIC_COUNT; k++) harmonicDb.push(k <= kMax ? levels[k] - levels[1] : NaN);

  const tiltDbPerOct = harmonicTilt(levels, mids, kMax, f0);
  const alphaRatioDb = bandRatioDb(power, binHz, nBins);
  const centroidHz = spectralCentroid(power, binHz, nBins, nyquist);
  const cppDb = cepstralPeakProminence(ctx, f0);
  const subharmonicDb = subharmonicLevel(ctx, levels, kMax, f0, nyquist);

  return { h1h2Db, alphaRatioDb, centroidHz, tiltDbPerOct, cppDb, harmonicDb, subharmonicDb };
}

/**
 * Least-squares slope of harmonic level (dB) against log2(frequency) for harmonics <= 5 kHz that
 * stand clear of the inter-harmonic floor (TILT_MIN_PROMINENCE_DB); needs >= 3 of them.
 */
function harmonicTilt(levels: Float64Array, mids: Float64Array, kMax: number, f0: number): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let k = 1; k <= kMax && k * f0 <= TILT_MAX_HZ; k++) {
    const y = levels[k];
    if (Number.isNaN(y)) continue;
    const around = Number.isNaN(mids[k]) ? mids[k - 1] : 0.5 * (mids[k - 1] + mids[k]);
    if (y - around < TILT_MIN_PROMINENCE_DB) continue;
    const xv = Math.log2(k * f0);
    n++;
    sx += xv;
    sy += y;
    sxx += xv * xv;
    sxy += xv * y;
  }
  if (n < 3) return NaN;
  const den = n * sxx - sx * sx;
  return den > 0 ? (n * sxy - sx * sy) / den : NaN;
}

/** Alpha ratio: 10*log10(energy 1-5 kHz / energy 50 Hz-1 kHz). */
function bandRatioDb(power: Float64Array, binHz: number, nBins: number): number {
  let low = 0;
  let high = 0;
  const kLow = Math.ceil(ALPHA_LOW_HZ / binHz);
  const kSplit = Math.ceil(ALPHA_SPLIT_HZ / binHz);
  const kHigh = Math.min(nBins - 1, Math.floor(ALPHA_HIGH_HZ / binHz));
  for (let k = kLow; k < kSplit; k++) low += power[k];
  for (let k = kSplit; k <= kHigh; k++) high += power[k];
  return low > 0 && high > 0 ? 10 * Math.log10(high / low) : NaN;
}

/** Amplitude-weighted (|X|, not |X|^2) mean frequency over 50 Hz..min(8 kHz, Nyquist). */
function spectralCentroid(power: Float64Array, binHz: number, nBins: number, nyquist: number): number {
  const kLo = Math.ceil(CENTROID_LOW_HZ / binHz);
  const kHi = Math.min(nBins - 1, Math.floor(Math.min(CENTROID_HIGH_HZ, nyquist) / binHz));
  let num = 0;
  let den = 0;
  for (let k = kLo; k <= kHi; k++) {
    const mag = Math.sqrt(power[k]);
    num += k * binHz * mag;
    den += mag;
  }
  return den > 0 ? num / den : NaN;
}

/**
 * Cepstral peak prominence (Hillenbrand et al. 1994): real cepstrum of the dB power spectrum,
 * expressed in dB; the rahmonic peak near the known period (+/-15 %) minus the value of a
 * least-squares trend line (1-50 ms quefrency) at the peak's quefrency.
 */
function cepstralPeakProminence(ctx: Context, f0: number): number {
  const { db, ceps, cre, cim, fftSize, nBins, sampleRate, qLo, qHi, sq, sqq } = ctx;
  const half = fftSize / 2;
  // The dB spectrum is real and even, so its inverse DFT is a forward real FFT (up to 1/N,
  // which only offsets the cepstral dB values and cancels in the prominence).
  for (let k = 0; k <= half; k++) ceps[k] = db[k];
  for (let k = 1; k < half; k++) ceps[fftSize - k] = db[k];
  rfft(ceps, fftSize, cre, cim);

  const cepDb = (q: number): number => 20 * Math.log10(Math.abs(cre[q]) + 1e-12);

  const peakLo = Math.max(2, Math.floor(sampleRate / (f0 * (1 + CPP_SEARCH_REL))));
  const peakHi = Math.min(nBins - 2, Math.ceil(sampleRate / (f0 * (1 - CPP_SEARCH_REL))));
  if (peakLo > peakHi) return NaN;
  let qm = peakLo;
  let best = cepDb(peakLo);
  for (let q = peakLo + 1; q <= peakHi; q++) {
    const v = cepDb(q);
    if (v > best) {
      best = v;
      qm = q;
    }
  }
  const a = cepDb(qm - 1);
  const c = cepDb(qm + 1);
  const den = a - 2 * best + c;
  let qPeak = qm;
  let peak = best;
  if (den < 0) {
    const p = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    qPeak = qm + p;
    peak = best - 0.25 * (a - c) * p;
  }

  let sy = 0;
  let sqy = 0;
  for (let q = qLo; q <= qHi; q++) {
    const y = cepDb(q);
    sy += y;
    sqy += q * y;
  }
  const n = qHi - qLo + 1;
  const den2 = n * sqq - sq * sq;
  if (!(den2 > 0)) return NaN;
  const slope = (n * sqy - sq * sy) / den2;
  const intercept = (sy - slope * sq) / n;
  return peak - (slope * qPeak + intercept);
}

/** Mean power over the bins in [fHz - halfHz, fHz + halfHz] (at least one bin). */
function bandMeanPower(ctx: Context, fHz: number, halfHz: number): number {
  const { power, binHz, nBins } = ctx;
  const lo = Math.max(1, Math.round((fHz - halfHz) / binHz));
  const hi = Math.min(nBins - 1, Math.max(lo, Math.round((fHz + halfHz) / binHz)));
  let sum = 0;
  for (let k = lo; k <= hi; k++) sum += power[k];
  return sum / (hi - lo + 1);
}

/**
 * Subharmonic (period-doubling) energy for k = 1..8: the mean power in +/-0.1*f0 around the
 * midpoint (k + 0.5) * f0, minus the noise floor measured at the quarter points (k + 0.25) * f0
 * and (k + 0.75) * f0 (+/-0.05*f0), relative to the peak power of harmonic k; each term in dB,
 * floored at SUBHARMONIC_FLOOR_DB, then averaged.
 *
 * The SPEC's plain "midpoint level minus harmonic level" cannot tell rasp from breath: aspiration
 * noise fills the midpoints just as well (on the synthesiser breathy, falsetto and whisper-like
 * voices all read -9 to -11 dB, the same as a strong subharmonic). Period doubling puts a peak at
 * the midpoint that stands above the quarter points; noise does not.
 */
function subharmonicLevel(ctx: Context, levels: Float64Array, kMax: number, f0: number, nyquist: number): number {
  let sum = 0;
  let n = 0;
  for (let k = 1; k <= SUBHARMONIC_COUNT && k <= kMax && (k + 0.75) * f0 < nyquist * 0.95; k++) {
    if (Number.isNaN(levels[k])) continue;
    const harm = Math.pow(10, levels[k] / 10);
    const mid = bandMeanPower(ctx, (k + 0.5) * f0, SUBHARMONIC_BAND_REL * f0);
    const floor =
      0.5 *
      (bandMeanPower(ctx, (k + 0.25) * f0, SUBHARMONIC_FLOOR_BAND_REL * f0) +
        bandMeanPower(ctx, (k + 0.75) * f0, SUBHARMONIC_FLOOR_BAND_REL * f0));
    const excess = Math.max(0, mid - floor);
    sum += Math.max(SUBHARMONIC_FLOOR_DB, 10 * Math.log10(excess / harm + 1e-30));
    n++;
  }
  return n > 0 ? sum / n : NaN;
}

/** HNR estimate from YIN periodicity p (0..1): 10*log10(p/(1-p)), clamped to [-5, 40]. */
export function hnrFromPeriodicity(p: number): number {
  if (Number.isNaN(p)) return NaN;
  if (p >= 1) return 40;
  if (p <= 0) return -5;
  return Math.max(-5, Math.min(40, 10 * Math.log10(p / (1 - p))));
}
