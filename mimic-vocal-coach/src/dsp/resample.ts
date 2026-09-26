// Channel down-mix and band-limited sample-rate conversion.
//
// resample() evaluates a Kaiser-windowed sinc low-pass at the fractional input position of every
// output sample (Smith's bandlimited interpolation). For integer rates the ratio is reduced to
// L/M and the kernel is precomputed for all L phases (a polyphase filter), so the inner loop is a
// plain dot product with no trig and no table interpolation.

export const ANALYSIS_RATE = 22050;

/** Average all channels into one. Channels of unequal length are truncated to the shortest. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels.reduce((m, c) => Math.min(m, c.length), Infinity);
  const out = new Float32Array(n);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/**
 * Filter design. Passband edge 0.9 x the lower Nyquist, stopband edge exactly at the lower Nyquist,
 * so nothing above the output Nyquist can alias back (content in the 10 % transition band is only
 * partly kept, which costs nothing audible for voice). 80 dB stopband: far below 16-bit
 * quantisation of real recordings; the test only needs > 40 dB.
 */
const PASS_FRACTION = 0.9;
const STOP_ATTEN_DB = 80;
/** Beyond this many phases the ratio is not worth tabulating exactly; round to the nearest phase instead. */
const MAX_PHASES = 4096;

interface ResamplePlan {
  /** Exact rational step (output n reads input position n * m / l) when `exact`. */
  exact: boolean;
  l: number;
  m: number;
  phases: number;
  /** Half-width of the kernel in input samples; taps = 2 * half. */
  half: number;
  taps: number;
  /** phases x taps, tap j of phase p multiplies input sample floor(pos) - half + 1 + j. */
  table: Float64Array;
}

const planCache = new Map<string, ResamplePlan>();

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Zeroth-order modified Bessel function of the first kind (power series; converges fast for x < 30). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function makePlan(fromRate: number, toRate: number): ResamplePlan {
  const lowNyq = Math.min(fromRate, toRate) / 2;
  const passHz = PASS_FRACTION * lowNyq;
  const cutoffHz = (passHz + lowNyq) / 2;
  const transition = (lowNyq - passHz) / fromRate; // cycles per input sample
  // Kaiser's formulas for beta and length at the requested stopband attenuation.
  const beta = 0.1102 * (STOP_ATTEN_DB - 8.7);
  const length = (STOP_ATTEN_DB - 8) / (2.285 * 2 * Math.PI * transition);
  const half = Math.max(2, Math.ceil(length / 2));
  const taps = 2 * half;

  let exact = false;
  let l = 0;
  let m = 0;
  if (Number.isInteger(fromRate) && Number.isInteger(toRate)) {
    const g = gcd(fromRate, toRate);
    l = toRate / g;
    m = fromRate / g;
    exact = l <= MAX_PHASES;
  }
  const phases = exact ? l : MAX_PHASES;

  const fc = cutoffHz / fromRate; // normalised cutoff, cycles per input sample
  const i0Beta = besselI0(beta);
  const table = new Float64Array(phases * taps);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const t = j - half + 1 - frac; // distance from the output position, input samples
      const u = t / half;
      let w = 0;
      if (Math.abs(u) < 1) w = besselI0(beta * Math.sqrt(1 - u * u)) / i0Beta;
      const arg = 2 * fc * t;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      const h = 2 * fc * sinc * w;
      table[p * taps + j] = h;
      sum += h;
    }
    // Unit DC gain for every phase removes the small phase-dependent gain ripple.
    if (sum !== 0) for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
  }
  return { exact, l, m, phases, half, taps, table };
}

function planFor(fromRate: number, toRate: number): ResamplePlan {
  const key = `${fromRate}->${toRate}`;
  let plan = planCache.get(key);
  if (!plan) {
    plan = makePlan(fromRate, toRate);
    planCache.set(key, plan);
  }
  return plan;
}

/** Band-limited resampling (low-pass before decimation). Returns input unchanged if rates match. */
export function resample(x: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return x;
  if (!(fromRate > 0) || !(toRate > 0) || !Number.isFinite(fromRate) || !Number.isFinite(toRate)) {
    throw new Error(`resample: invalid sample rates ${fromRate} -> ${toRate}`);
  }
  const len = x.length;
  if (len === 0) return new Float32Array(0);
  const outLen = Math.max(1, Math.round((len * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const { exact, l, m, phases, half, taps, table } = planFor(fromRate, toRate);
  const ratio = fromRate / toRate;

  for (let n = 0; n < outLen; n++) {
    let i0: number;
    let ph: number;
    if (exact) {
      const num = n * m;
      i0 = Math.floor(num / l);
      ph = num - i0 * l;
    } else {
      const pos = n * ratio;
      i0 = Math.floor(pos);
      ph = Math.round((pos - i0) * phases);
      if (ph === phases) {
        i0++;
        ph = 0;
      }
    }
    const base = i0 - half + 1;
    const off = ph * taps;
    let acc = 0;
    if (base >= 0 && base + taps <= len) {
      for (let j = 0; j < taps; j++) acc += x[base + j] * table[off + j];
    } else {
      // Near the ends, samples outside the signal count as zero.
      const jLo = Math.max(0, -base);
      const jHi = Math.min(taps, len - base);
      for (let j = jLo; j < jHi; j++) acc += x[base + j] * table[off + j];
    }
    out[n] = acc;
  }
  return out;
}
