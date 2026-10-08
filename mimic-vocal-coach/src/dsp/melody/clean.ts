// Clean-up of the extracted melody track: pitch fragments that cannot be a sung note.
//
// On a song mix the tracker keeps jumping to a plucked note, a bass note or a drum's pitch for a few frames at a time: each
// jump becomes a 50-150 ms "note" that the singer never sang, and they are the main reason a full-song reference has two to
// four times as many notes as were sung. A sung note that short does exist (a fast run), so a short stretch is dropped only
// when the cues that say "this is the lead voice" (confidence, level against the clip's loud frames, salience dominance, share
// of the spectrum on the harmonics) are weak as well. On the proxy mixes (songMix.ts, three band types, voice +3 to -6 dB,
// two vibrato widths) and on real singing voices over the proxy band this removes 80% of the time in wrong short stretches and
// 50% of the right ones (which are 4% of the right frames); see FRAGMENT_* for the constants.

/** A pitch stretch ends where the pitch moves by this many semitones or more between two frames. */
const STRETCH_JUMP_SEMITONES = 1.5;
/** Stretches shorter than this (seconds) are judged by their cues; longer ones are never dropped here. */
export const FRAGMENT_MAX_SEC = 0.15;
/** A short stretch whose trust is below this is dropped. */
export const FRAGMENT_MIN_TRUST = 0.25;

/**
 * Logistic model of "this short stretch is the lead voice", fitted on the proxy mixes (leave-one-condition-out AUC 0.84 on
 * stretches under 0.2 s) over [median confidence, median level re the clip's 90th percentile (dB), median salience dominance,
 * median harmonic share, ln(duration in s)]; features are standardised with FRAGMENT_MEAN / FRAGMENT_SCALE.
 */
const FRAGMENT_WEIGHTS = [0.1, 0.3, 0.27, 0.59, 0.54];
const FRAGMENT_BIAS = -3.35;
const FRAGMENT_MEAN = [0.528, -10.589, 0.449, 0.107, -3.669];
const FRAGMENT_SCALE = [0.313, 7.161, 0.12, 0.116, 1.103];

export function fragmentTrust(confidence: number, relLevelDb: number, dominance: number, share: number, durationSec: number): number {
  const x = [confidence, relLevelDb, dominance, share, Math.log(Math.max(durationSec, 1e-3))];
  let z = FRAGMENT_BIAS;
  for (let i = 0; i < x.length; i++) z += (FRAGMENT_WEIGHTS[i] * (x[i] - FRAGMENT_MEAN[i])) / FRAGMENT_SCALE[i];
  return 1 / (1 + Math.exp(-z));
}

export interface FragmentCues {
  /** Per-frame confidence (0..1), level re the clip's 90th percentile (dB), salience dominance (0..1), harmonic share (0..1). */
  confidence: ArrayLike<number>;
  relLevelDb: ArrayLike<number>;
  dominance: ArrayLike<number>;
  share: ArrayLike<number>;
}

function medianOf(a: ArrayLike<number>, from: number, to: number): number {
  const v: number[] = [];
  for (let i = from; i < to; i++) v.push(a[i]);
  v.sort((x, y) => x - y);
  return v[v.length >> 1];
}

/**
 * Unvoices (in place) the short pitch stretches (under FRAGMENT_MAX_SEC) whose trust is below FRAGMENT_MIN_TRUST. `f0` is in Hz
 * (read for the stretch boundaries); dropped frames get f0 = NaN and voiced = 0. Returns the number of frames dropped.
 */
export function dropFragments(f0: Float64Array, voiced: Uint8Array, hopSec: number, cues: FragmentCues): number {
  const n = Math.min(f0.length, voiced.length);
  const semis = (t: number) => 12 * Math.log2(f0[t] / 440);
  const maxFrames = Math.round(FRAGMENT_MAX_SEC / hopSec);
  let removed = 0;
  let i = 0;
  while (i < n) {
    if (!voiced[i] || !(f0[i] > 0)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && voiced[j] && f0[j] > 0 && Math.abs(semis(j) - semis(j - 1)) < STRETCH_JUMP_SEMITONES) j++;
    if (j - i < maxFrames) {
      const trust = fragmentTrust(
        medianOf(cues.confidence, i, j),
        medianOf(cues.relLevelDb, i, j),
        medianOf(cues.dominance, i, j),
        medianOf(cues.share, i, j),
        (j - i) * hopSec,
      );
      if (trust < FRAGMENT_MIN_TRUST) {
        for (let t = i; t < j; t++) {
          voiced[t] = 0;
          f0[t] = NaN;
        }
        removed += j - i;
      }
    }
    i = j;
  }
  return removed;
}
