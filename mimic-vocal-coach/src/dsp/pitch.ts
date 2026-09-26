// Pitch tracking: YIN (de Cheveigne & Kawahara 2002) with an FFT-computed difference function,
// a voicing decision tuned for breathy singing, a period-doubling check for rasp, and light
// octave-error cleanup.
//
// Frame layout. For lag tau the difference function compares x[s + j] with x[s + j + tau] for
// j < W, so the pair is centred at s + (W - 1)/2 + tau/2. We place s so that this centre lands on
// the frame centre for the middle of the lag range; at the extremes (65 Hz or 1400 Hz with the
// defaults) the effective centre is off by at most (tauMax - tauMin)/4 samples (~3.5 ms at
// 22.05 kHz), well under one hop, so the contour stays aligned with the audio.

import { fft, nextPow2, rfft } from './fft';
import { clamp, medianFilter, percentile } from './stats';

export interface PitchTrack {
  sampleRate: number;
  hopSec: number; // 0.01
  times: Float64Array; // frame centre times, s
  f0: Float64Array; // Hz, NaN when unvoiced
  periodicity: Float64Array; // 0..1 (1 - YIN aperiodicity at the chosen lag)
  rmsDb: Float64Array; // dBFS
  voiced: Uint8Array; // 1 = voiced
}

export interface PitchOptions {
  hopSec?: number;
  minHz?: number;
  maxHz?: number;
  threshold?: number;
}

const DEFAULT_HOP_SEC = 0.01;
const DEFAULT_MIN_HZ = 65;
const DEFAULT_MAX_HZ = 1400;
const DEFAULT_THRESHOLD = 0.15;

/**
 * Integration window W in periods of minHz. 1.5 periods of 65 Hz is ~23 ms at any rate: enough
 * for a stable dip at the lowest pitch, short enough that a 7 Hz, +/-100 cent vibrato changes the
 * period by only a few percent inside one window (YIN then reports the local mean, which is what
 * we want for the contour).
 */
const WINDOW_PERIODS = 1.5;

/**
 * When no dip goes under the absolute threshold (typical for breathy voice, where aspiration
 * noise keeps d'(T) around 0.2-0.4), taking the global minimum invites octave-down errors because
 * d'(2T) is often marginally lower than d'(T). Instead take the first dip within this margin of
 * the global minimum.
 */
const FALLBACK_MARGIN = 0.1;

/**
 * The dip is chosen on d' but the lag is located on the raw difference function d within this
 * fraction of the chosen lag. With a noise floor the cumulative-mean normalisation tilts d'
 * (its denominator keeps shrinking as tau approaches the period), which moves the minimum of d'
 * to shorter lags: up to ~1 semitone sharp for breathy voice. d itself has no such tilt.
 */
const REFINE_FRACTION = 0.15;

/**
 * Lag interpolation. A clean dip (d' <= NOISY_DIP) gets the classic 3-point parabola: bright
 * voices have a sharp, V-shaped dip at sample scale that a wider fit would bias. A noisy dip gets
 * a least-squares parabola over +/- FIT_FRACTION of the lag: aspiration noise adds
 * sample-to-sample ripple to d that throws a 3-point fit off by tens of cents, while a few
 * percent of the period is still inside the parabolic bottom of a smooth dip.
 */
const NOISY_DIP = 0.08;
const FIT_FRACTION = 0.08;

/**
 * Voicing. A frame is voiced when it passes the loudness gates and its periodicity is at least
 * P_STRONG, or at least P_WEAK while continuing the pitch of an adjacent voiced frame (hysteresis,
 * which keeps soft onsets/offsets and breathy stretches attached to their notes).
 * Measured on the synthesiser: clean voice ~0.99, breathNoise 0.6 ~0.75, breathNoise 1.5 ~0.33,
 * white noise < 0.15.
 */
const P_STRONG = 0.55;
const P_WEAK = 0.4;
const WEAK_JOIN_SEMITONES = 1;
/** Absolute floor: nothing below -60 dBFS counts as singing. */
const ABS_FLOOR_DB = -60;
/** Frames must be this far above the noise floor (10th percentile of frame RMS)... */
const NOISE_MARGIN_DB = 6;
/**
 * ...but the gate never rises above (90th percentile - this). Without the cap a take that is
 * voiced throughout would have its "noise floor" at the singing level and gate itself out.
 */
const GATE_BELOW_LOUD_DB = 20;
const SILENCE_DB = -120;

/**
 * Octave-up guard. With a weak H1 and a strong H2 (pressed or belted tone, F1 near 2*f0) d'(T/2)
 * can dip just under the absolute threshold. If the dip at twice the chosen lag is much deeper,
 * the chosen lag was half the period. Clean voice has d'(T) ~ d'(2T), breathy voice too, so they
 * are untouched; genuine period doubling that this lets through is caught by the zig-zag test.
 */
const OCTAVE_UP_MIN_DP = 0.1;
const OCTAVE_UP_RATIO = 0.25;

/**
 * Period doubling (rasp, subharmonics). A voice whose cycles alternate slightly is strictly
 * periodic at 2T, so YIN reports an octave below the note being sung. Its spectrum at the
 * long-period candidate f0c = sr/tau shows the tell-tale zig-zag: the odd multiples of f0c (the
 * subharmonics) sit below the mean of their even neighbours (the real harmonics) all the way up
 * the spectrum. A formant envelope can push one or two odd multiples down (vowel /a/ at 175 Hz:
 * H4 and H6 sit on F1 and F2, dips of about -4 dB) but then the dips return to ~ -1 dB, so the
 * test needs a deep average over every usable odd multiple up to ZIGZAG_MAX_HZ. A subharmonic
 * series at half the harmonic amplitude gives dips of about -6 dB; real rasp is usually weaker
 * (deeper dips). The same test repairs ordinary YIN octave-down errors, where the odd multiples
 * fall between true harmonics.
 */
const ZIGZAG_MAX_HZ = 3000;
const ZIGZAG_FIRST_DB = -3;
const ZIGZAG_MEAN_DB = -4;
const ZIGZAG_DEEP_DB = -2;
const ZIGZAG_DEEP_SHARE = 0.6;
/**
 * A dip only counts where both even neighbours stand this far above the spectrum midway between
 * components; elsewhere (upper harmonics of a breathy voice buried in aspiration noise, or
 * harmonics smeared by heavy jitter) the "zig-zag" would be noise. Multiple 3 must count and at
 * least three multiples in all, otherwise the test declines to decide: with only two, a breathy
 * /a/ at 175 Hz (H4 on F1, H6 on F2, everything above buried in noise) looks exactly like rasp.
 */
const ZIGZAG_MIN_CLEARANCE_DB = 10;
const ZIGZAG_MIN_DIPS = 3;
/**
 * Only candidates f0c <= 190 Hz (a sung note <= ~380 Hz, G4) are tested. Above that there are
 * too few harmonics below 3 kHz to outvote formant alignment (e.g. vowel /e/ at 294 Hz: H2, H6
 * and H8 sit on F1, F2 and F3). Strong period doubling on higher notes therefore still reads an
 * octave low; mild rasp there is tracked correctly anyway because YIN finds the short period first.
 */
const ZIGZAG_MAX_F0C_HZ = 190;

/**
 * Octave cleanup: running median over +/-170 ms, so an octave error is folded back when it
 * persists for less than ~175 ms. On real low male voices YIN can lock onto 2*f0 for 110-140 ms
 * at a time, alternating with correct stretches (a +/-70 ms median left those in place and they
 * became fake notes, runs and "register flips"). The price: a genuine octave leap held for less
 * than ~175 ms (a quick grace note up and back) is folded too; leaps held for 0.2 s or more stay.
 */
const OCTAVE_MEDIAN_SEC = 0.35;
/** Voiced islands shorter than this are dropped (clicks, consonant bursts). */
const MIN_VOICED_SEC = 0.04;

/** Reusable YIN engine for one (W, tauMin, tauMax) configuration. Allocates only in the constructor. */
class Yin {
  readonly segLen: number;
  private readonly n: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly cum: Float64Array;
  private readonly d: Float64Array;
  private readonly dp: Float64Array;
  /** Results of the last run()/settle(): fractional lag and d' there. */
  tau = 0;
  aperiodicity = 1;
  /** False when the chosen lag is not a local minimum of d (the dip lies outside minHz..maxHz). */
  inRange = false;

  constructor(
    readonly w: number,
    readonly tauMin: number,
    readonly tauMax: number,
  ) {
    // One extra lag beyond tauMax so a dip at tauMax can be checked and interpolated.
    this.segLen = w + tauMax + 1;
    this.n = nextPow2(this.segLen);
    this.re = new Float64Array(this.n);
    this.im = new Float64Array(this.n);
    this.cum = new Float64Array(this.segLen + 1);
    this.d = new Float64Array(tauMax + 2);
    this.dp = new Float64Array(tauMax + 2);
  }

  /** Analyse `seg` (length >= segLen) and pick the period. */
  run(seg: Float64Array, threshold: number): void {
    const { n, w, segLen, re, im, cum, d, dp, tauMin, tauMax } = this;

    // Cross-correlation r(tau) = sum_{j<W} a[j] b[j+tau] with a = seg[0..W), b = seg[0..segLen),
    // both real, packed into one complex FFT as a + i b. n >= segLen, so no circular wrap.
    for (let i = 0; i < n; i++) {
      re[i] = i < w ? seg[i] : 0;
      im[i] = i < segLen ? seg[i] : 0;
    }
    fft(re, im);
    const mask = n - 1;
    for (let k = 0; k <= n >> 1; k++) {
      const nk = (n - k) & mask;
      const zr = re[k];
      const zi = im[k];
      const cr = re[nk];
      const ci = im[nk];
      // Unpack A = FFT(a) and B = FFT(b) from Z = FFT(a + i b).
      const ar = 0.5 * (zr + cr);
      const ai = 0.5 * (zi - ci);
      const br = 0.5 * (zi + ci);
      const bi = -0.5 * (zr - cr);
      // conj(A) * B; the result is Hermitian because the correlation is real.
      const pr = ar * br + ai * bi;
      const pi = ar * bi - ai * br;
      re[k] = pr;
      im[k] = pi;
      re[nk] = pr;
      im[nk] = -pi;
    }
    fft(re, im, true);

    cum[0] = 0;
    for (let i = 0; i < segLen; i++) cum[i + 1] = cum[i] + seg[i] * seg[i];
    const e0 = cum[w];

    // d(tau) = sum (a_j - b_{j+tau})^2 = e0 + e_tau - 2 r(tau); then the cumulative-mean-normalised d'.
    d[0] = 0;
    dp[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      const v = e0 + (cum[tau + w] - cum[tau]) - 2 * re[tau];
      const dv = v > 0 ? v : 0;
      d[tau] = dv;
      running += dv;
      dp[tau] = running > 0 ? (dv * tau) / running : 1;
    }

    // Absolute threshold: the first dip under it. Its minimum is taken over the whole run of lags
    // that stay under the threshold rather than by walking downhill, because with aspiration
    // noise d' has sample-level ripples that stop a downhill walk short of the true minimum.
    let best = firstDip(dp, tauMin, tauMax, threshold);
    if (best < 0) {
      let gi = tauMin;
      for (let tau = tauMin + 1; tau <= tauMax; tau++) if (dp[tau] < dp[gi]) gi = tau;
      best = firstDip(dp, tauMin, tauMax, dp[gi] + FALLBACK_MARGIN);
      if (best < 0) best = gi;
    }
    if (dp[best] > OCTAVE_UP_MIN_DP && Math.round(2 * best * 0.9) <= tauMax) {
      const lo = Math.round(2 * best * 0.9);
      const hi = Math.min(tauMax, Math.round(2 * best * 1.1));
      let b2 = lo;
      for (let t = lo + 1; t <= hi; t++) if (dp[t] < dp[b2]) b2 = t;
      if (dp[b2] < OCTAVE_UP_RATIO * dp[best]) best = b2;
    }
    this.settle(best, REFINE_FRACTION);
  }

  /**
   * Locate the period near `guess` (within +/- frac) on the raw difference function, refine it
   * by parabolic interpolation and read d' there. Requires a prior run() on the same frame.
   */
  settle(guess: number, frac: number): void {
    const { d, dp, tauMin, tauMax } = this;
    const lo = Math.max(tauMin, Math.floor(guess * (1 - frac)));
    const hi = Math.min(tauMax, Math.max(lo, Math.ceil(guess * (1 + frac))));
    let bi = lo;
    for (let t = lo + 1; t <= hi; t++) if (d[t] < d[bi]) bi = t;
    this.inRange = d[bi - 1] >= d[bi] && d[bi + 1] >= d[bi];

    const h = dp[bi] > NOISY_DIP ? Math.min(Math.round(FIT_FRACTION * bi), bi - 1, tauMax + 1 - bi) : 1;
    const s = parabolicMinimum(d, bi, h);
    this.tau = bi + s;

    // d' at the refined lag: the parabola through the three values around bi when the vertex is
    // within a lag of it, otherwise linear interpolation (the parabola is not valid that far out).
    let ap: number;
    if (Math.abs(s) <= 1) {
      const pa = dp[bi - 1];
      const pb = dp[bi];
      const pc = dp[bi + 1];
      ap = pb + 0.5 * (pc - pa) * s + 0.5 * (pa - 2 * pb + pc) * s * s;
    } else {
      const i0 = Math.min(tauMax, Math.floor(this.tau));
      const f = this.tau - i0;
      ap = dp[i0] * (1 - f) + dp[i0 + 1] * f;
    }
    this.aperiodicity = clamp(ap, 0, 1);
  }
}

/**
 * Offset (in lags, |offset| <= h) of the vertex of a least-squares parabola fitted to y[c-h..c+h].
 * h <= 1 is the classic three-point interpolation.
 */
function parabolicMinimum(y: Float64Array, c: number, h: number): number {
  if (h <= 1) {
    const a = y[c - 1];
    const b = y[c];
    const e = y[c + 1];
    const den = a - 2 * b + e;
    return den > 0 ? clamp((0.5 * (a - e)) / den, -0.5, 0.5) : 0;
  }
  let sy = 0;
  let sty = 0;
  let st2y = 0;
  let st2 = 0;
  let st4 = 0;
  for (let t = -h; t <= h; t++) {
    const v = y[c + t];
    const t2 = t * t;
    sy += v;
    sty += t * v;
    st2y += t2 * v;
    st2 += t2;
    st4 += t2 * t2;
  }
  const n = 2 * h + 1;
  const b = sty / st2;
  const curv = (st2y - (st2 * sy) / n) / (st4 - (st2 * st2) / n);
  return curv > 0 ? clamp(-b / (2 * curv), -h, h) : 0;
}

/** Index of the minimum of the first run of lags where dp < thr, or -1 if there is none. */
function firstDip(dp: Float64Array, tauMin: number, tauMax: number, thr: number): number {
  let tau = tauMin;
  while (tau <= tauMax && dp[tau] >= thr) tau++;
  if (tau > tauMax) return -1;
  let best = tau;
  for (; tau <= tauMax && dp[tau] < thr; tau++) if (dp[tau] < dp[best]) best = tau;
  return best;
}

const yinCache = new Map<string, Yin>();

function yinFor(w: number, tauMin: number, tauMax: number): Yin {
  const key = `${w}:${tauMin}:${tauMax}`;
  let y = yinCache.get(key);
  if (!y) {
    if (yinCache.size > 16) yinCache.clear();
    y = new Yin(w, tauMin, tauMax);
    yinCache.set(key, y);
  }
  return y;
}

interface ZigzagScratch {
  win: Float64Array;
  buf: Float64Array;
  re: Float64Array;
  im: Float64Array;
}
const zigzagCache = new Map<number, ZigzagScratch>();

function zigzagScratch(len: number): ZigzagScratch {
  let s = zigzagCache.get(len);
  if (!s) {
    const win = new Float64Array(len);
    for (let i = 0; i < len; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
    s = { win, buf: new Float64Array(len), re: new Float64Array(len + 1), im: new Float64Array(len + 1) };
    zigzagCache.set(len, s);
  }
  return s;
}

const DOUBLED = 1;
const NOT_DOUBLED = 0;
const ABSTAIN = -1;
/** Frame was not tested (unvoiced, or the test does not apply to its candidate lag). */
const NO_CANDIDATE = -2;
type ZigzagVerdict = typeof DOUBLED | typeof NOT_DOUBLED | typeof ABSTAIN;
/**
 * Voting reach for the doubling decision and the minimum number of DOUBLED verdicts (which must
 * also outnumber NOT_DOUBLED two to one). Rasp gives dense DOUBLED verdicts (typically 8-15 of the
 * 15 frames); a breathy voice produces an occasional stray one, never more than 2 in a window
 * on the synthesiser.
 */
const VOTE_SEC = 0.07;
const VOTE_MIN_YES = 3;
const HALF_LAG_FRACTION = 0.1;

/** Whether the zig-zag test can run for this candidate lag (see ZIGZAG_MAX_F0C_HZ). */
function zigzagApplies(sampleRate: number, tau: number, tauMin: number): boolean {
  const f0c = sampleRate / tau;
  return tau / 2 >= tauMin + 1 && f0c <= ZIGZAG_MAX_F0C_HZ && 6 * f0c <= Math.min(ZIGZAG_MAX_HZ, 0.45 * sampleRate);
}

/**
 * Zig-zag test on the spectrum around `centre` for the candidate f0c = sampleRate / tau:
 * DOUBLED when the odd multiples of f0c look like subharmonics (the voice is really at 2 * f0c),
 * ABSTAIN when too few components stand clear of the noise to tell. Call only when zigzagApplies().
 */
function zigzagVerdict(x: ArrayLike<number>, centre: number, sampleRate: number, tau: number): ZigzagVerdict {
  const f0c = sampleRate / tau;
  const topHz = Math.min(ZIGZAG_MAX_HZ, 0.45 * sampleRate);
  // At least 4 periods in the Hann window, so neighbouring components (f0c apart) are resolved;
  // 2x zero padding for finer bins.
  const lw = clamp(nextPow2(Math.ceil(4 * tau)), 512, 4096);
  const nfft = 2 * lw;
  const { win, buf, re, im } = zigzagScratch(lw);
  const start = Math.round(centre) - (lw >> 1);
  const len = x.length;
  for (let i = 0; i < lw; i++) {
    const idx = start + i;
    buf[i] = idx >= 0 && idx < len ? x[idx] * win[i] : 0;
  }
  rfft(buf, nfft, re, im);
  const binHz = sampleRate / nfft;
  const band = (centreHz: number, halfHz: number, usePeak: boolean): number => {
    const lo = Math.max(1, Math.round((centreHz - halfHz) / binHz));
    const hi = Math.min(lw, Math.round((centreHz + halfHz) / binHz));
    let acc = 0;
    for (let k = lo; k <= hi; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      acc = usePeak ? Math.max(acc, p) : acc + p / (hi - lo + 1);
    }
    return 10 * Math.log10(acc + 1e-30);
  };
  const level = (j: number) => band(j * f0c, 0.2 * f0c, true);
  const valley = (j: number) => band(j * f0c, 0.1 * f0c, false);

  let sum = 0;
  let count = 0;
  let deep = 0;
  for (let j = 3; (j + 1) * f0c <= topHz; j += 2) {
    const below = level(j - 1);
    const above = level(j + 1);
    const floor = 0.5 * (valley(j - 0.5) + valley(j + 0.5));
    if (Math.min(below, above) - floor < ZIGZAG_MIN_CLEARANCE_DB) {
      if (j === 3) return ABSTAIN;
      continue;
    }
    const dip = level(j) - 0.5 * (below + above);
    if (j === 3 && dip >= ZIGZAG_FIRST_DB) return NOT_DOUBLED;
    sum += dip;
    count++;
    if (dip < ZIGZAG_DEEP_DB) deep++;
  }
  if (count < ZIGZAG_MIN_DIPS) return ABSTAIN;
  return sum / count < ZIGZAG_MEAN_DB && deep >= ZIGZAG_DEEP_SHARE * count ? DOUBLED : NOT_DOUBLED;
}

interface LagRange {
  tauMin: number;
  tauMax: number;
}

function lagRange(sampleRate: number, minHz: number, maxHz: number): LagRange {
  if (!(sampleRate > 0)) throw new Error(`pitch: invalid sample rate ${sampleRate}`);
  if (!(minHz > 0) || !(maxHz > minHz)) throw new Error(`pitch: invalid pitch range ${minHz}-${maxHz} Hz`);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.max(tauMin + 2, Math.ceil(sampleRate / minHz));
  return { tauMin, tauMax };
}

function toDb(meanSquare: number): number {
  return meanSquare > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(meanSquare)) : SILENCE_DB;
}

function hzToSemis(hz: number): number {
  return 12 * Math.log2(hz / 440);
}

/**
 * YIN (FFT-accelerated difference function) + voicing decision + octave-jump cleanup. Defaults 65-1400 Hz.
 * Frame i is centred on sample round(i * hopSec * sampleRate) and times[i] = i * hopSec.
 * For period-doubled (raspy) frames f0 is the sung note and `periodicity` is measured at that
 * period, so it is low (the subharmonics count as aperiodic energy) even though the frame is voiced.
 */
export function trackPitch(x: Float32Array, sampleRate: number, opts: PitchOptions = {}): PitchTrack {
  const hopSec = opts.hopSec ?? DEFAULT_HOP_SEC;
  const minHz = opts.minHz ?? DEFAULT_MIN_HZ;
  const maxHz = Math.min(opts.maxHz ?? DEFAULT_MAX_HZ, sampleRate * 0.45);
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  if (!(hopSec > 0)) throw new Error(`trackPitch: invalid hop ${hopSec}`);
  const { tauMin, tauMax } = lagRange(sampleRate, minHz, maxHz);
  const w = Math.ceil((WINDOW_PERIODS * sampleRate) / minHz);
  const yin = yinFor(w, tauMin, tauMax);

  const len = x.length;
  const hopSamples = hopSec * sampleRate;
  const nFrames = len > 0 ? Math.floor((len - 1) / hopSamples) + 1 : 0;
  const times = new Float64Array(nFrames);
  const rawF0 = new Float64Array(nFrames);
  const periodicity = new Float64Array(nFrames);
  /** Periodicity at the lag YIN picked before any period-doubling correction; drives voicing. */
  const strength = new Float64Array(nFrames);
  const rmsDb = new Float64Array(nFrames);
  const inRange = new Uint8Array(nFrames);
  // Period-doubling candidates: the zig-zag verdict and the estimate at half the lag.
  const verdict = new Int8Array(nFrames).fill(NO_CANDIDATE);
  const halfF0 = new Float64Array(nFrames);
  const halfPeriodicity = new Float64Array(nFrames);
  const halfInRange = new Uint8Array(nFrames);

  // Prefix sums of x^2 for O(1) frame RMS over a W-long window centred on the frame.
  const energy = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) energy[i + 1] = energy[i] + x[i] * x[i];

  const seg = new Float64Array(yin.segLen);
  const lead = Math.floor((w + (tauMin + tauMax) / 2) / 2);
  const halfW = w >> 1;
  for (let i = 0; i < nFrames; i++) {
    const c = Math.round(i * hopSamples);
    times[i] = i * hopSec;
    const s = c - lead;
    if (s >= 0 && s + yin.segLen <= len) {
      for (let j = 0; j < yin.segLen; j++) seg[j] = x[s + j];
    } else {
      for (let j = 0; j < yin.segLen; j++) {
        const idx = s + j;
        seg[j] = idx >= 0 && idx < len ? x[idx] : 0;
      }
    }
    const lo = Math.max(0, c - halfW);
    const hi = Math.min(len, c - halfW + w);
    rmsDb[i] = toDb((energy[hi] - energy[lo]) / w);

    yin.run(seg, threshold);
    strength[i] = 1 - yin.aperiodicity;
    periodicity[i] = strength[i];
    inRange[i] = yin.inRange ? 1 : 0;
    rawF0[i] = sampleRate / yin.tau;
    if (yin.inRange && strength[i] >= P_WEAK && rmsDb[i] >= ABS_FLOOR_DB && zigzagApplies(sampleRate, yin.tau, tauMin)) {
      verdict[i] = zigzagVerdict(x, c, sampleRate, yin.tau);
      yin.settle(yin.tau / 2, HALF_LAG_FRACTION);
      halfF0[i] = sampleRate / yin.tau;
      halfPeriodicity[i] = 1 - yin.aperiodicity;
      halfInRange[i] = yin.inRange ? 1 : 0;
    }
  }
  applyDoublingVotes(verdict, rawF0, periodicity, inRange, halfF0, halfPeriodicity, halfInRange, hopSec);

  const voiced = decideVoicing(rawF0, strength, rmsDb, inRange);
  const f0 = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) f0[i] = voiced[i] ? rawF0[i] : NaN;
  fixOctaveErrors(f0, Math.max(3, Math.round(OCTAVE_MEDIAN_SEC / hopSec) | 1));
  removeShortIslands(f0, voiced, Math.max(1, Math.round(MIN_VOICED_SEC / hopSec)));

  return { sampleRate, hopSec, times, f0, periodicity, rmsDb, voiced };
}

/**
 * Per-frame zig-zag verdicts are noisy under heavy jitter (many abstain), so the decision is a
 * vote of the decided verdicts within +/- VOTE_SEC among frames whose candidate pitch is
 * within a semitone (a vote only means something for the same candidate lag). Frames voted
 * DOUBLED switch to their half-lag estimate. Mutates the frame arrays.
 */
function applyDoublingVotes(
  verdict: Int8Array,
  f0: Float64Array,
  periodicity: Float64Array,
  inRange: Uint8Array,
  halfF0: Float64Array,
  halfPeriodicity: Float64Array,
  halfInRange: Uint8Array,
  hopSec: number,
): void {
  const n = verdict.length;
  const reach = Math.max(1, Math.round(VOTE_SEC / hopSec));
  const doubled = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (verdict[i] === NO_CANDIDATE) continue;
    let yes = 0;
    let no = 0;
    const semis = hzToSemis(f0[i]);
    for (let j = Math.max(0, i - reach); j <= Math.min(n - 1, i + reach); j++) {
      if (verdict[j] !== DOUBLED && verdict[j] !== NOT_DOUBLED) continue;
      if (Math.abs(hzToSemis(f0[j]) - semis) > 1) continue;
      if (verdict[j] === DOUBLED) yes++;
      else no++;
    }
    doubled[i] = yes >= VOTE_MIN_YES && yes >= 2 * no ? 1 : 0;
  }
  for (let i = 0; i < n; i++) {
    if (!doubled[i]) continue;
    f0[i] = halfF0[i];
    periodicity[i] = halfPeriodicity[i];
    inRange[i] = halfInRange[i];
  }
}

/** Loudness gates plus periodicity with hysteresis. Returns 1 for voiced frames. */
function decideVoicing(
  rawF0: Float64Array,
  strength: Float64Array,
  rmsDb: Float64Array,
  inRange: Uint8Array,
): Uint8Array {
  const n = rawF0.length;
  const voiced = new Uint8Array(n);
  if (n === 0) return voiced;
  const floorDb = percentile(rmsDb, 10);
  const loudDb = percentile(rmsDb, 90);
  const gateDb = Math.max(ABS_FLOOR_DB, Math.min(floorDb + NOISE_MARGIN_DB, loudDb - GATE_BELOW_LOUD_DB));

  const weak = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inRange[i] || rmsDb[i] < gateDb) continue;
    if (strength[i] >= P_STRONG) voiced[i] = 1;
    else if (strength[i] >= P_WEAK) weak[i] = 1;
  }
  const joins = (i: number, j: number) =>
    Math.abs(hzToSemis(rawF0[i]) - hzToSemis(rawF0[j])) < WEAK_JOIN_SEMITONES;
  for (let i = 1; i < n; i++) if (weak[i] && !voiced[i] && voiced[i - 1] && joins(i, i - 1)) voiced[i] = 1;
  for (let i = n - 2; i >= 0; i--) if (weak[i] && !voiced[i] && voiced[i + 1] && joins(i, i + 1)) voiced[i] = 1;
  return voiced;
}

/**
 * Corrects frames that sit about an octave away from the running median of their neighbourhood
 * (NaN-aware, so unvoiced frames are ignored). A genuine leap that is held for longer than half
 * the median window becomes the majority on its side and is left alone. Mutates f0.
 */
function fixOctaveErrors(f0: Float64Array, window: number): void {
  const n = f0.length;
  const semis = new Float64Array(n);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) semis[i] = Number.isNaN(f0[i]) ? NaN : hzToSemis(f0[i]);
    const med = medianFilter(semis, window);
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(semis[i])) continue;
      const diff = semis[i] - med[i];
      if (diff > 9 && Math.abs(diff - 12) < 3) {
        f0[i] /= 2;
        changed = true;
      } else if (diff < -9 && Math.abs(diff + 12) < 3) {
        f0[i] *= 2;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/** Unvoices runs of voiced frames shorter than minFrames. Mutates f0 and voiced. */
function removeShortIslands(f0: Float64Array, voiced: Uint8Array, minFrames: number): void {
  const n = voiced.length;
  let i = 0;
  while (i < n) {
    if (!voiced[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && voiced[j]) j++;
    if (j - i < minFrames) {
      for (let k = i; k < j; k++) {
        voiced[k] = 0;
        f0[k] = NaN;
      }
    }
    i = j;
  }
}

/**
 * Single-frame YIN for live display (tuner). Returns null when unvoiced.
 * The whole frame is used: the integration window is frame.length minus the largest lag, and the
 * largest lag is capped at half the frame so the window is never shorter than it (a 2048-sample
 * frame covers the default 65 Hz floor at 44.1 and 48 kHz). The period-doubling check runs on the
 * single frame without the vote used by trackPitch, so a very breathy low voice can occasionally
 * flick an octave up; smooth the displayed value over a few frames.
 */
export function detectPitch(
  frame: Float32Array,
  sampleRate: number,
  minHz = DEFAULT_MIN_HZ,
  maxHz = DEFAULT_MAX_HZ,
): { hz: number; periodicity: number } | null {
  const len = frame.length;
  const range = lagRange(sampleRate, minHz, Math.min(maxHz, sampleRate * 0.45));
  const tauMin = range.tauMin;
  const tauMax = Math.min(range.tauMax, Math.floor(len / 2) - 1);
  if (tauMax < tauMin + 2) return null;
  const w = len - tauMax - 1;

  let ss = 0;
  for (let i = 0; i < len; i++) ss += frame[i] * frame[i];
  if (toDb(ss / len) < ABS_FLOOR_DB) return null;

  const yin = yinFor(w, tauMin, tauMax);
  const seg = Float64Array.from(frame);
  yin.run(seg, DEFAULT_THRESHOLD);
  const strength = 1 - yin.aperiodicity;
  if (!yin.inRange || strength < P_STRONG) return null;
  if (zigzagApplies(sampleRate, yin.tau, tauMin) && zigzagVerdict(frame, len / 2, sampleRate, yin.tau) === DOUBLED) {
    yin.settle(yin.tau / 2, HALF_LAG_FRACTION);
    if (!yin.inRange) return null;
  }
  return { hz: sampleRate / yin.tau, periodicity: 1 - yin.aperiodicity };
}
