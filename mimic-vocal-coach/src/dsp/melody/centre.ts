// Centre emphasis from the L/R short-time spectra.
//
// For a bin dominated by a centre-panned source L = R, so the side spectrum S = (L - R) / 2 is zero
// and the mid spectrum M = (L + R) / 2 equals the source. Wide material (hard-panned instruments,
// stereo reverb, decorrelated pads) has |S| at least as large as |M|. The "centreness"
//
//     c = (|M|^2 - |S|^2) / (|M|^2 + |S|^2) = 2 Re(L R*) / (|L|^2 + |R|^2)      in [-1, 1]
//
// is 1 for equal level and phase, 0 for equal level 90 degrees apart (or one silent channel) and -1
// for opposite phase: the level-similarity and phase-difference cues of ADRess / panning-index
// methods in one number. Powers are smoothed over +/-2 bins (one Hann main lobe) first, because a
// per-bin ratio of two noisy complex numbers is erratic. The gain applied to |M| is
// max(FLOOR, c^POWER): a soft emphasis, not a hard mask, so a stereo-widened lead vocal (double
// tracking, chorus, reverb) is attenuated by at most 12 dB.

export const CENTRE_POWER = 0.5;
export const CENTRE_FLOOR = 0.25;

/** Writes the gain (0..1) for bins 0..k-1; pm, ps = per-bin |M|^2, |S|^2; smM, smS = scratch. */
export function centreGain(pm: Float64Array, ps: Float64Array, k: number, smM: Float64Array, smS: Float64Array, gain: Float32Array): void {
  smooth5(pm, smM, k);
  smooth5(ps, smS, k);
  for (let i = 0; i < k; i++) {
    const m = smM[i];
    const s = smS[i];
    const c = (m - s) / (m + s + 1e-20);
    const g = c > 0 ? Math.pow(c, CENTRE_POWER) : 0;
    gain[i] = g < CENTRE_FLOOR ? CENTRE_FLOOR : g;
  }
}

/** Smooths p[0..k) with the kernel [1 2 3 2 1] / 9 into out (edges repeat). */
function smooth5(p: Float64Array, out: Float64Array, k: number): void {
  for (let i = 0; i < k; i++) {
    const a = p[i >= 2 ? i - 2 : 0];
    const b = p[i >= 1 ? i - 1 : 0];
    const d = p[i + 1 < k ? i + 1 : k - 1];
    const e = p[i + 2 < k ? i + 2 : k - 1];
    out[i] = (a + 2 * b + 3 * p[i] + 2 * d + e) / 9;
  }
}
