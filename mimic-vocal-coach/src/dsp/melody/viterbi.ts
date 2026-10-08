// Melody tracking on a salience map: a Viterbi search for the path of f0 bins that maximises the
// summed normalised salience minus a pitch-change penalty. Every frame gets a pitch (voicing is
// decided afterwards from the level of the cleaned harmonic energy, see vocalMelody.ts).

/** Cost per salience bin (20 cents) of a pitch change between consecutive 10 ms frames. */
export const JUMP_COST = 0.012;
/** Largest allowed change per frame, bins (14 bins = 280 cents per 10 ms). */
export const MAX_JUMP = 14;
/** Salience is divided by this percentile of the per-frame maxima, then capped at SALIENCE_CAP. */
export const REF_PERCENTILE = 90;
export const SALIENCE_CAP = 1.6;

export interface TrackResult {
  /** f0 bin per frame. */
  bin: Int16Array;
  /** Normalised salience at the chosen bin, 0..SALIENCE_CAP. */
  score: Float32Array;
}

/** Viterbi path through S[t * nBins + j]. */
export function trackSalience(S: Float32Array, nT: number, nBins: number): TrackResult {
  const bin = new Int16Array(nT);
  const score = new Float32Array(nT);
  if (nT === 0) return { bin, score };
  const frameMax = new Float32Array(nT);
  for (let t = 0; t < nT; t++) {
    let m = 0;
    for (let j = 0; j < nBins; j++) if (S[t * nBins + j] > m) m = S[t * nBins + j];
    frameMax[t] = m;
  }
  const sorted = Float32Array.from(frameMax).sort();
  const ref = Math.max(1e-12, sorted[Math.floor((REF_PERCENTILE / 100) * (nT - 1))]);
  const emit = (t: number, j: number) => Math.min(SALIENCE_CAP, S[t * nBins + j] / ref);

  const back = new Int8Array(nT * nBins); // predecessor offset: previous bin = j - back
  let prev = new Float64Array(nBins);
  let cur = new Float64Array(nBins);
  for (let j = 0; j < nBins; j++) prev[j] = emit(0, j);
  for (let t = 1; t < nT; t++) {
    for (let j = 0; j < nBins; j++) {
      const lo = j - MAX_JUMP > 0 ? j - MAX_JUMP : 0;
      const hi = j + MAX_JUMP < nBins - 1 ? j + MAX_JUMP : nBins - 1;
      let best = -Infinity;
      let bd = 0;
      for (let i = lo; i <= hi; i++) {
        const d = j - i;
        const v = prev[i] - JUMP_COST * (d < 0 ? -d : d);
        if (v > best) {
          best = v;
          bd = d;
        }
      }
      cur[j] = best + emit(t, j);
      back[t * nBins + j] = bd;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  let s = 0;
  for (let j = 1; j < nBins; j++) if (prev[j] > prev[s]) s = j;
  for (let t = nT - 1; t >= 0; t--) {
    bin[t] = s;
    score[t] = emit(t, s);
    if (t > 0) s -= back[t * nBins + s];
  }
  return { bin, score };
}
