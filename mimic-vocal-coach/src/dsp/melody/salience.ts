// Harmonic-summation pitch salience (the first stage of Melodia, Salamon & Gomez 2012) computed
// from the peaks of a magnitude spectrum.
//
// Every spectral peak (frequency fp, amplitude ap) votes for each f0 candidate fp / h, h = 1..H,
// with weight alpha^(h-1) * ap. Votes land on a log-frequency grid (60 bins per octave = 20 cents)
// and are spread over +/-2 bins with a cos^2 window, which tolerates inharmonicity, vibrato smear
// and the finite resolution of the 93 ms analysis window. Peak amplitudes are first divided by the
// local mean over +/-WHITEN_BINS bins ("whitening"), so a weak upper partial of the voice counts as
// much as a loud low partial of the bass: what matters is how many harmonics line up. Because every
// partial below MAX_PEAK_HZ counts (not a fixed number of harmonics per candidate), a candidate an
// octave too high sees only half as many partials as the true f0, and the decaying weights make one
// an octave too low (which matches only the even partials) lose against the true f0.

export interface SalienceConfig {
  sampleRate: number;
  fftSize: number;
  fMin: number;
  fMax: number;
}

export const BINS_PER_OCTAVE = 60;
const SPREAD = 2;
const NUM_HARMONICS = 40;
const ALPHA = 0.92;
const WHITEN_BINS = 48;
const PEAK_RANGE_DB = 55;
const PEAK_MIN_RATIO = 1.6;
const MAX_PEAK_HZ = 3000;
/** Peaks below HP_FLOOR_HZ get no vote; the weight ramps linearly up to HP_KNEE_HZ (bass roll-off). */
const HP_KNEE_HZ = 150;
const HP_FLOOR_HZ = 70;
const MAX_PEAKS = 512;
/** The vote window is tabulated every 1/KSUB bin. */
const KSUB = 16;

export class SalienceMap {
  readonly nBins: number;
  readonly binHz: number;
  /** Highest FFT bin that can hold a peak that votes. */
  readonly kTop: number;
  private readonly fMin: number;
  private readonly harmW: Float64Array;
  private readonly harmLog2: Float64Array;
  private readonly kern: Float64Array;
  private readonly peakF = new Float64Array(MAX_PEAKS);
  private readonly peakA = new Float64Array(MAX_PEAKS);
  private readonly prefix: Float64Array;

  constructor(cfg: SalienceConfig, maxBins: number) {
    this.fMin = cfg.fMin;
    this.binHz = cfg.sampleRate / cfg.fftSize;
    this.kTop = Math.floor(MAX_PEAK_HZ / this.binHz);
    this.nBins = Math.ceil(BINS_PER_OCTAVE * Math.log2(cfg.fMax / cfg.fMin)) + 1;
    this.harmW = new Float64Array(NUM_HARMONICS);
    this.harmLog2 = new Float64Array(NUM_HARMONICS);
    for (let h = 0; h < NUM_HARMONICS; h++) {
      this.harmW[h] = Math.pow(ALPHA, h);
      this.harmLog2[h] = Math.log2(h + 1);
    }
    const half = Math.round((SPREAD + 1) * KSUB);
    this.kern = new Float64Array(2 * half + 1);
    for (let i = -half; i <= half; i++) this.kern[i + half] = Math.pow(Math.cos((Math.PI / 2) * (i / KSUB / (SPREAD + 1))), 2);
    this.prefix = new Float64Array(maxBins + 1);
  }

  /** Fractional salience bin of frequency f. */
  binOf(f: number): number {
    return BINS_PER_OCTAVE * Math.log2(f / this.fMin);
  }

  /** Centre frequency of salience bin j. */
  freqOf(j: number): number {
    return this.fMin * Math.pow(2, j / BINS_PER_OCTAVE);
  }

  /** Salience of one frame from amp[0..kEnd) into out[0..nBins) (overwritten). */
  frame(amp: Float32Array, ampOffset: number, kEnd: number, out: Float32Array, outOffset: number): void {
    const { binHz, harmW, harmLog2, kern, nBins, peakF, peakA, prefix } = this;
    out.fill(0, outOffset, outOffset + nBins);
    const kTop = Math.min(kEnd - 1, this.kTop);
    const kLo = Math.max(2, Math.floor(HP_FLOOR_HZ / binHz));
    let maxA = 0;
    prefix[0] = 0;
    for (let k = 0; k <= kTop; k++) {
      const a = amp[ampOffset + k];
      prefix[k + 1] = prefix[k] + a;
      if (a > maxA) maxA = a;
    }
    if (!(maxA > 0)) return;
    const floorA = maxA * Math.pow(10, -PEAK_RANGE_DB / 20);
    let nPeaks = 0;
    for (let k = kLo; k < kTop - 1 && nPeaks < MAX_PEAKS; k++) {
      const a = amp[ampOffset + k];
      const left = amp[ampOffset + k - 1];
      const right = amp[ampOffset + k + 1];
      if (a < floorA || !(a > left) || a < right) continue;
      const lo = k - WHITEN_BINS > 0 ? k - WHITEN_BINS : 0;
      const hi = k + WHITEN_BINS < kTop ? k + WHITEN_BINS : kTop;
      const ratio = a / ((prefix[hi + 1] - prefix[lo]) / (hi - lo + 1) + 1e-20);
      if (ratio < PEAK_MIN_RATIO) continue;
      // Parabolic interpolation of the peak position on the log magnitude.
      const la = Math.log(left + 1e-20);
      const lb = Math.log(a + 1e-20);
      const lc = Math.log(right + 1e-20);
      const den = la - 2 * lb + lc;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / den)) : 0;
      const f = (k + d) * binHz;
      let w = ratio;
      if (f < HP_KNEE_HZ) w *= Math.max(0, (f - HP_FLOOR_HZ) / (HP_KNEE_HZ - HP_FLOOR_HZ));
      peakF[nPeaks] = f;
      peakA[nPeaks] = w;
      nPeaks++;
    }
    const half = Math.round((SPREAD + 1) * KSUB);
    const lnFmin = Math.log2(this.fMin);
    for (let p = 0; p < nPeaks; p++) {
      const ap = peakA[p];
      if (!(ap > 0)) continue;
      const base = BINS_PER_OCTAVE * (Math.log2(peakF[p]) - lnFmin);
      for (let h = 0; h < NUM_HARMONICS; h++) {
        const jf = base - BINS_PER_OCTAVE * harmLog2[h]; // bin of f0 = fp / (h + 1)
        if (jf < -SPREAD - 1) break; // higher h only goes lower
        if (jf > nBins + SPREAD) continue;
        const wh = harmW[h] * ap;
        const j0 = Math.max(0, Math.ceil(jf - SPREAD - 0.5));
        const j1 = Math.min(nBins - 1, Math.floor(jf + SPREAD + 0.5));
        for (let j = j0; j <= j1; j++) out[outOffset + j] += wh * kern[Math.round((j - jf) * KSUB) + half];
      }
    }
  }
}
