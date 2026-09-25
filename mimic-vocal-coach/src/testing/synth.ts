// Deterministic singing-voice synthesiser for tests and demos.
//
// Additive synthesis of a glottal-like harmonic source with a chosen spectral tilt, shaped by
// vowel formant resonances, plus optional vibrato, jitter, shimmer, aspiration noise and a
// subharmonic (period-doubling) component that reads as rasp. It is not meant to sound good; it
// gives the analysis code signals whose ground truth is known.

export type Vowel = 'a' | 'e' | 'i' | 'o' | 'u' | 'none';

export interface SynthOptions {
  sampleRate?: number;
  durationSec: number;
  /** Constant f0 in Hz, or a function of time (seconds) returning Hz. */
  f0: number | ((t: number) => number);
  /** Sinusoidal vibrato. extentCents is the semi-extent (± cents). */
  vibrato?: { rateHz: number; extentCents: number; delaySec?: number };
  /** Relative cycle-to-cycle period jitter, e.g. 0.01 = 1 %. */
  jitter?: number;
  /** Relative cycle-to-cycle amplitude jitter, e.g. 0.05 = 5 %. */
  shimmer?: number;
  /** Aspiration noise RMS relative to the harmonic RMS (0 = none, 1 = equal). */
  breathNoise?: number;
  /** Source slope in dB per octave. Pressed/chest ≈ -6 to -9, modal ≈ -12, falsetto ≈ -18 to -24. */
  tiltDbPerOct?: number;
  /** Extra boost (dB) applied to harmonic 1 only. Positive values mimic a breathy/falsetto H1-H2. */
  h1BoostDb?: number;
  vowel?: Vowel;
  /** Peak amplitude of the output, default 0.5. */
  amplitude?: number;
  /** 0..1 level of an f0/2 subharmonic series (rasp / vocal fry texture). */
  subharmonic?: number;
  attackSec?: number;
  releaseSec?: number;
  seed?: number;
}

const FORMANTS: Record<Exclude<Vowel, 'none'>, { f: number[]; bw: number[] }> = {
  a: { f: [730, 1090, 2440, 3300], bw: [90, 110, 160, 200] },
  e: { f: [530, 1840, 2480, 3400], bw: [80, 110, 160, 200] },
  i: { f: [270, 2290, 3010, 3500], bw: [60, 100, 160, 200] },
  o: { f: [570, 840, 2410, 3300], bw: [80, 100, 160, 200] },
  u: { f: [300, 870, 2240, 3300], bw: [70, 100, 160, 200] },
};

/** Small seeded PRNG (mulberry32) so tests are reproducible. */
export function makeRng(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Magnitude response of a cascade of 2-pole resonators, normalised to 1 at DC. */
export function formantGain(freq: number, vowel: Vowel): number {
  if (vowel === 'none') return 1;
  const { f, bw } = FORMANTS[vowel];
  let g = 1;
  for (let i = 0; i < f.length; i++) {
    const fc = f[i];
    const hb = bw[i] / 2;
    const num = fc * fc + hb * hb;
    const den = Math.sqrt(((freq - fc) ** 2 + hb * hb) * ((freq + fc) ** 2 + hb * hb));
    g *= num / den;
  }
  return g;
}

/** Synthesize a sustained or pitch-varying sung tone. */
export function synthVoice(opts: SynthOptions): Float32Array {
  const sr = opts.sampleRate ?? 22050;
  const n = Math.max(1, Math.round(opts.durationSec * sr));
  const out = new Float32Array(n);
  const rng = makeRng(opts.seed ?? 7);
  const tilt = opts.tiltDbPerOct ?? -12;
  const vowel = opts.vowel ?? 'a';
  const f0At = typeof opts.f0 === 'function' ? opts.f0 : () => opts.f0 as number;
  const vib = opts.vibrato;
  const jitter = opts.jitter ?? 0;
  const shimmer = opts.shimmer ?? 0;
  const sub = opts.subharmonic ?? 0;
  const h1Boost = Math.pow(10, (opts.h1BoostDb ?? 0) / 20);
  const nyq = sr / 2;

  // Phase of the fundamental in cycles; harmonic k uses k * phase. A half-rate phase drives the subharmonic.
  let phase = 0;
  let halfPhase = 0;
  let jitterFactor = 1;
  let shimmerFactor = 1;
  const harmonic = new Float32Array(n);
  const pulse = new Float32Array(n); // glottal-cycle envelope used to modulate aspiration noise

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let f0 = f0At(t);
    if (vib && t >= (vib.delaySec ?? 0)) {
      f0 *= Math.pow(2, (vib.extentCents * Math.sin(2 * Math.PI * vib.rateHz * (t - (vib.delaySec ?? 0)))) / 1200);
    }
    f0 *= jitterFactor;
    const prev = phase;
    phase += f0 / sr;
    halfPhase += f0 / (2 * sr);
    if (Math.floor(phase) !== Math.floor(prev)) {
      // New glottal cycle: draw fresh jitter/shimmer perturbations.
      jitterFactor = 1 + jitter * gaussian(rng);
      shimmerFactor = Math.max(0, 1 + shimmer * gaussian(rng));
    }
    const maxK = Math.floor((nyq * 0.95) / f0);
    let s = 0;
    for (let k = 1; k <= maxK; k++) {
      const fk = k * f0;
      let amp = Math.pow(k, tilt / 6.0206) * formantGain(fk, vowel);
      if (k === 1) amp *= h1Boost;
      s += amp * Math.sin(2 * Math.PI * k * phase);
    }
    if (sub > 0) {
      // Odd multiples of f0/2 fall between the harmonics: the classic period-doubling signature.
      const maxJ = Math.floor((nyq * 0.95) / (f0 / 2));
      for (let j = 1; j <= maxJ; j += 2) {
        const fj = (j * f0) / 2;
        const amp = sub * Math.pow(j / 2, tilt / 6.0206) * formantGain(fj, vowel);
        s += amp * Math.sin(2 * Math.PI * j * halfPhase);
      }
    }
    harmonic[i] = s * shimmerFactor;
    const cyc = phase - Math.floor(phase);
    pulse[i] = 0.35 + 0.65 * Math.exp(-((cyc - 0.3) ** 2) / 0.02);
  }

  // Normalise the harmonic part to unit RMS so breathNoise is a clean ratio.
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += harmonic[i] * harmonic[i];
  const hRms = Math.sqrt(sumSq / n) || 1;
  for (let i = 0; i < n; i++) out[i] = harmonic[i] / hRms;

  const breath = opts.breathNoise ?? 0;
  if (breath > 0) {
    // Aspiration: white noise, gently high-passed (first difference mixed with the raw noise),
    // pulsed with the glottal cycle, then scaled to the requested RMS ratio.
    const noise = new Float32Array(n);
    let prevW = 0;
    let nSq = 0;
    for (let i = 0; i < n; i++) {
      const w = gaussian(rng);
      const v = (0.6 * (w - prevW) + 0.4 * w) * pulse[i];
      prevW = w;
      noise[i] = v;
      nSq += v * v;
    }
    const nRms = Math.sqrt(nSq / n) || 1;
    for (let i = 0; i < n; i++) out[i] += (breath * noise[i]) / nRms;
  }

  // Envelope and peak normalisation.
  const attack = Math.max(1, Math.round((opts.attackSec ?? 0.03) * sr));
  const release = Math.max(1, Math.round((opts.releaseSec ?? 0.05) * sr));
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < attack) env = i / attack;
    if (i > n - release) env = Math.min(env, (n - i) / release);
    out[i] *= env;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const gain = (opts.amplitude ?? 0.5) / (peak || 1);
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

export interface MelodyNote {
  midi: number;
  durSec: number;
}

/**
 * Sing a sequence of notes legato (with a short glide between them) on one breath.
 * All other SynthOptions apply to the whole line.
 */
export function synthMelody(
  notes: MelodyNote[],
  opts: Omit<SynthOptions, 'f0' | 'durationSec'> & { glideSec?: number; a4Hz?: number },
): Float32Array {
  const a4 = opts.a4Hz ?? 440;
  const glide = opts.glideSec ?? 0.04;
  const starts: number[] = [];
  let total = 0;
  for (const nt of notes) {
    starts.push(total);
    total += nt.durSec;
  }
  const f0 = (t: number): number => {
    let idx = notes.length - 1;
    for (let i = 0; i < notes.length; i++) {
      if (t < starts[i] + notes[i].durSec) {
        idx = i;
        break;
      }
    }
    const cur = notes[idx].midi;
    const into = t - starts[idx];
    let midi = cur;
    if (idx > 0 && into < glide) {
      const prevMidi = notes[idx - 1].midi;
      midi = prevMidi + (cur - prevMidi) * (into / glide);
    }
    return a4 * Math.pow(2, (midi - 69) / 12);
  };
  return synthVoice({ ...opts, f0, durationSec: total });
}

/** Pure sine tone. */
export function sine(freqHz: number, durationSec: number, sampleRate = 22050, amplitude = 0.5): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

export function silence(durationSec: number, sampleRate = 22050): Float32Array {
  return new Float32Array(Math.round(durationSec * sampleRate));
}

/** White noise at a given RMS. */
export function whiteNoise(durationSec: number, rms: number, sampleRate = 22050, seed = 3): Float32Array {
  const rng = makeRng(seed);
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rms * gaussian(rng);
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Mix b into a (same length or shorter) at a gain. Returns a new array. */
export function mix(a: Float32Array, b: Float32Array, gainB = 1): Float32Array {
  const out = Float32Array.from(a);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) out[i] += gainB * b[i];
  return out;
}

export function midiToHz(midi: number, a4Hz = 440): number {
  return a4Hz * Math.pow(2, (midi - 69) / 12);
}
