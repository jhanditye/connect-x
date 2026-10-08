// Test support for the scorer and the phrase comparison (imported by tests only; never by app code).
// A phrase synthesiser with exact ground truth (notes, breaths, vibrato, scoops, detune, gain), error injectors, the phrase
// fixtures, and a few signal tools (channel simulation, formant-preserving TD-PSOLA to re-time and re-pitch real singing).
// All audio is synthetic or comes from the caller's own files; nothing here ships in the app bundle.

import { analyzeTake } from '../../analysis/analyze';
import { fft, nextPow2 } from '../../dsp/fft';
import { trackPitch } from '../../dsp/pitch';
import { resample } from '../../dsp/resample';
import { concat, makeRng, silence, synthVoice, type SynthOptions } from '../../testing/synth';
import type { VoiceAnalysis, VoiceType } from '../../types';

export const SR = 22050;

export function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ---------------------------------------------------------------------------------------------
// Phrase synthesis with ground truth

export interface PNote {
  midi: number;
  durSec: number;
  /** Silence before this note (a breath). 0 / undefined = legato from the previous note. */
  restBefore?: number;
  vibrato?: { rateHz: number; extentCents: number; delaySec: number } | null;
  /** Start this many cents away from the pitch (negative = scoop up from below) and glide in over scoopSec. */
  scoopCents?: number;
  scoopSec?: number;
  /** Pitch drops by this many cents over the last 150 ms of the note. */
  fallCents?: number;
  detuneCents?: number;
  gainDb?: number;
}

export type ToneParams = Pick<SynthOptions, 'breathNoise' | 'tiltDbPerOct' | 'h1BoostDb' | 'subharmonic' | 'vowel' | 'jitter' | 'shimmer'>;

export const DEFAULT_TONE: ToneParams = { vowel: 'a', tiltDbPerOct: -12, breathNoise: 0.04, jitter: 0.004, shimmer: 0.02 };

const GLIDE = 0.04;

export function renderPhrase(
  notes: PNote[],
  tone: ToneParams = DEFAULT_TONE,
  opts: { seed?: number; leadIn?: number; tail?: number; noiseRms?: number } = {},
): Float32Array {
  const lead = opts.leadIn ?? 0.15;
  const tail = opts.tail ?? 0.2;
  const segs: PNote[][] = [];
  for (const n of notes) {
    if (segs.length === 0 || (n.restBefore ?? 0) > 0) segs.push([n]);
    else segs[segs.length - 1].push(n);
  }
  const parts: Float32Array[] = [silence(lead, SR)];
  let segIdx = 0;
  for (const seg of segs) {
    const rest = seg[0].restBefore ?? 0;
    if (rest > 0) parts.push(silence(rest, SR));
    const starts: number[] = [];
    let total = 0;
    for (const n of seg) {
      starts.push(total);
      total += n.durSec;
    }
    const f0 = (tt: number): number => {
      let idx = seg.length - 1;
      for (let i = 0; i < seg.length; i++) {
        if (tt < starts[i] + seg[i].durSec) {
          idx = i;
          break;
        }
      }
      const n = seg[idx];
      const into = tt - starts[idx];
      let midi = n.midi + (n.detuneCents ?? 0) / 100;
      if (idx > 0 && into < GLIDE) {
        const prev = seg[idx - 1];
        const pm = prev.midi + (prev.detuneCents ?? 0) / 100;
        midi = pm + (midi - pm) * (into / GLIDE);
      }
      if (n.scoopCents) {
        const sd = n.scoopSec ?? 0.12;
        if (into < sd) midi += (n.scoopCents / 100) * (1 - into / sd);
      }
      if (n.fallCents) {
        const left = n.durSec - into;
        if (left < 0.15) midi -= (n.fallCents / 100) * (1 - left / 0.15);
      }
      let hz = 440 * 2 ** ((midi - 69) / 12);
      if (n.vibrato && into >= n.vibrato.delaySec) {
        const ramp = Math.min(1, (into - n.vibrato.delaySec) / 0.25);
        hz *= 2 ** ((ramp * n.vibrato.extentCents * Math.sin(2 * Math.PI * n.vibrato.rateHz * (into - n.vibrato.delaySec))) / 1200);
      }
      return hz;
    };
    let audio = synthVoice({ ...tone, sampleRate: SR, f0, durationSec: total, seed: (opts.seed ?? 11) + segIdx * 7, attackSec: 0.03, releaseSec: 0.06 });
    if (seg.some((n) => n.gainDb)) {
      const g = new Float32Array(audio.length).fill(1);
      for (let i = 0; i < seg.length; i++) {
        const a = Math.round(starts[i] * SR);
        const b = Math.round((starts[i] + seg[i].durSec) * SR);
        const v = 10 ** ((seg[i].gainDb ?? 0) / 20);
        for (let k = a; k < b && k < g.length; k++) g[k] = v;
      }
      const w = Math.round(0.03 * SR);
      let acc = 0;
      const sm = new Float32Array(g.length);
      for (let k = 0; k < g.length; k++) {
        acc += g[k];
        if (k >= w) acc -= g[k - w];
        sm[k] = acc / Math.min(w, k + 1);
      }
      audio = audio.map((v, k) => v * sm[k]);
    }
    parts.push(audio);
    segIdx++;
  }
  parts.push(silence(tail, SR));
  const audio = concat(...parts);
  const nr = opts.noiseRms ?? 0.0012;
  return nr > 0 ? roomNoise(audio, nr, (opts.seed ?? 11) + 1000) : audio;
}

/** Deterministic low-level room noise (about -58 dBFS) so no frame is digital silence, like any real recording. */
export function roomNoise(x: Float32Array, rms = 0.0012, seed = 3): Float32Array {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = Float32Array.from(x);
  for (let i = 0; i < out.length; i++) {
    const u = Math.max(rnd(), 1e-12);
    out[i] += rms * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  }
  return out;
}

export function analyse(x: Float32Array, voiceType: VoiceType = 'tenor'): VoiceAnalysis {
  return analyzeTake(x, SR, { voiceType });
}

// ---------------------------------------------------------------------------------------------
// Fixtures

const V = (delaySec: number, rateHz = 5.6, extentCents = 45) => ({ rateHz, extentCents, delaySec });

/** About 9 s: two sub-phrases, leaps, two long notes with late vibrato, a scoop into a long note, a fall-off, one breath. */
export const PH_A: PNote[] = [
  { midi: 55, durSec: 0.55 },
  { midi: 59, durSec: 0.45 },
  { midi: 62, durSec: 0.6, scoopCents: -80, scoopSec: 0.12 },
  { midi: 64, durSec: 1.5, vibrato: V(0.35) },
  { midi: 62, durSec: 0.5 },
  { midi: 60, durSec: 0.65 },
  { midi: 67, durSec: 0.6, restBefore: 0.4, scoopCents: -100, scoopSec: 0.15 },
  { midi: 64, durSec: 0.55 },
  { midi: 62, durSec: 0.5 },
  { midi: 57, durSec: 0.7, fallCents: 70 },
  { midi: 55, durSec: 1.7, vibrato: V(0.45) },
];

/** About 3 s, four notes: the short-phrase case. */
export const PH_SHORT: PNote[] = [
  { midi: 57, durSec: 0.5 },
  { midi: 61, durSec: 0.45 },
  { midi: 64, durSec: 0.6 },
  { midi: 62, durSec: 1.2, vibrato: V(0.3) },
];

/** A fast run (ornament) and a long note with vibrato. */
export const PH_RUN: PNote[] = [
  { midi: 57, durSec: 0.6 },
  { midi: 64, durSec: 0.5 },
  { midi: 66, durSec: 0.12 }, { midi: 64, durSec: 0.12 }, { midi: 62, durSec: 0.12 }, { midi: 64, durSec: 0.12 }, { midi: 66, durSec: 0.12 }, { midi: 67, durSec: 0.12 },
  { midi: 64, durSec: 1.4, vibrato: V(0.3, 6.2, 60) },
  { midi: 60, durSec: 0.6 },
  { midi: 57, durSec: 1.3 },
];

export const clone = (ns: PNote[]): PNote[] => ns.map((n) => ({ ...n, vibrato: n.vibrato ? { ...n.vibrato } : n.vibrato }));
export const shiftKey = (ns: PNote[], semis: number): PNote[] => clone(ns).map((n) => ({ ...n, midi: n.midi + semis }));

export function refAnalysis(notes: PNote[] = PH_A, tone: ToneParams = DEFAULT_TONE, seed = 11, voiceType: VoiceType = 'tenor'): VoiceAnalysis {
  return analyse(renderPhrase(notes, tone, { seed, leadIn: 0.15, tail: 0.2 }), voiceType);
}

export interface AttemptSpec {
  notes?: PNote[];
  tone?: ToneParams;
  seed?: number;
  /** Seconds of nothing before the phrase starts. */
  lead?: number;
  tail?: number;
  /** Semitones above (+) or below (-) the reference. */
  key?: number;
  voiceType?: VoiceType;
  noise?: number;
  /** Applied to the rendered audio before analysis (channel). */
  channel?: (x: Float32Array) => Float32Array;
}

export function attemptAudio(spec: AttemptSpec = {}): Float32Array {
  const notes = shiftKey(spec.notes ?? PH_A, spec.key ?? 0);
  const body = renderPhrase(notes, spec.tone ?? DEFAULT_TONE, { seed: spec.seed ?? 77, leadIn: 0, tail: 0, noiseRms: 0 });
  let x = concat(silence(spec.lead ?? 1.6, SR), body, silence(spec.tail ?? 0.6, SR));
  if (spec.channel) x = spec.channel(x);
  return roomNoise(x, spec.noise ?? 0.0012, (spec.seed ?? 77) + 5);
}

export function attemptAnalysis(spec: AttemptSpec = {}): VoiceAnalysis {
  return analyse(attemptAudio(spec), spec.voiceType ?? 'tenor');
}

// ---------------------------------------------------------------------------------------------
// Error injection on a note list (the ground truth is known exactly)

export function detuneAll(ns: PNote[], sdCents: number, seed = 3): PNote[] {
  const r = makeRng(seed);
  return clone(ns).map((n) => ({ ...n, detuneCents: (n.detuneCents ?? 0) + sdCents * gauss(r) }));
}
export function detuneOne(ns: PNote[], k: number, cents: number): PNote[] {
  const out = clone(ns);
  out[k].detuneCents = (out[k].detuneCents ?? 0) + cents;
  return out;
}
export function detuneConst(ns: PNote[], cents: number): PNote[] {
  return clone(ns).map((n) => ({ ...n, detuneCents: (n.detuneCents ?? 0) + cents }));
}
/** Linear drift: note i gets total * (onset_i / total_duration) cents. */
export function drift(ns: PNote[], totalCents: number): PNote[] {
  const out = clone(ns);
  let t = 0;
  const total = ns.reduce((s, n) => s + (n.restBefore ?? 0) + n.durSec, 0);
  for (const n of out) {
    t += n.restBefore ?? 0;
    n.detuneCents = (n.detuneCents ?? 0) + totalCents * (t / total);
    t += n.durSec;
  }
  return out;
}
/** Error that grows with pitch height: +slope cents per semitone above the lowest note. */
export function heightSlope(ns: PNote[], centsPerSemitone: number): PNote[] {
  const lo = Math.min(...ns.map((n) => n.midi));
  return clone(ns).map((n) => ({ ...n, detuneCents: (n.detuneCents ?? 0) + centsPerSemitone * (n.midi - lo) }));
}
/** Land `cents` short of the target on every note that is at least `minLeap` semitones from the previous. */
export function undershootLeaps(ns: PNote[], cents: number, minLeap = 4): PNote[] {
  const out = clone(ns);
  for (let k = 1; k < out.length; k++) {
    const iv = ns[k].midi - ns[k - 1].midi;
    if (Math.abs(iv) >= minLeap) out[k].detuneCents = (out[k].detuneCents ?? 0) - Math.sign(iv) * cents;
  }
  return out;
}
export function tempo(ns: PNote[], factor: number): PNote[] {
  return clone(ns).map((n) => ({ ...n, durSec: n.durSec * factor, restBefore: n.restBefore ? n.restBefore * factor : n.restBefore }));
}
/** Start note k `ms` later (positive) or earlier, keeping every later onset where it was. */
export function shiftOnset(ns: PNote[], k: number, ms: number): PNote[] {
  const out = clone(ns);
  const s = ms / 1000;
  if (k === 0) {
    out[0].restBefore = (out[0].restBefore ?? 0) + s;
    return out;
  }
  const rest = out[k].restBefore ?? 0;
  if (rest > 0) {
    out[k].restBefore = Math.max(0.05, rest + s);
    out[k].durSec = Math.max(0.12, out[k].durSec - s);
  } else {
    out[k - 1].durSec = Math.max(0.12, out[k - 1].durSec + s);
    out[k].durSec = Math.max(0.12, out[k].durSec - s);
  }
  return out;
}
export function jitterOnsets(ns: PNote[], sdMs: number, seed = 5): PNote[] {
  const r = makeRng(seed);
  let out = clone(ns);
  for (let k = 1; k < out.length; k++) out = shiftOnset(out, k, sdMs * gauss(r));
  return out;
}
/** Cut note k short by `frac` of its length and leave a gap, so every onset is unchanged. */
export function cutShort(ns: PNote[], k: number, frac: number): PNote[] {
  const out = clone(ns);
  const cut = out[k].durSec * frac;
  out[k].durSec -= cut;
  if (k + 1 < out.length) out[k + 1].restBefore = (out[k + 1].restBefore ?? 0) + cut;
  return out;
}
export function durJitter(ns: PNote[], sdFrac: number, seed = 8): PNote[] {
  const r = makeRng(seed);
  const out = clone(ns);
  for (let k = 0; k + 1 < out.length; k++) {
    const f = Math.max(-0.5, Math.min(0.5, sdFrac * gauss(r)));
    if (f < 0) {
      const cut = -f * out[k].durSec;
      out[k].durSec -= cut;
      out[k + 1].restBefore = (out[k + 1].restBefore ?? 0) + cut;
    } else if (out[k + 1].restBefore && out[k + 1].restBefore! > f * out[k].durSec) {
      const add = f * out[k].durSec;
      out[k].durSec += add;
      out[k + 1].restBefore! -= add;
    }
  }
  return out;
}
export function noVibrato(ns: PNote[]): PNote[] {
  return clone(ns).map((n) => ({ ...n, vibrato: null }));
}
export function scaleVibrato(ns: PNote[], f: { rate?: number; extent?: number; delay?: number }): PNote[] {
  return clone(ns).map((n) =>
    n.vibrato ? { ...n, vibrato: { rateHz: n.vibrato.rateHz * (f.rate ?? 1), extentCents: n.vibrato.extentCents * (f.extent ?? 1), delaySec: n.vibrato.delaySec * (f.delay ?? 1) } } : n,
  );
}
export function gainPattern(ns: PNote[], dbs: number[]): PNote[] {
  return clone(ns).map((n, i) => ({ ...n, gainDb: dbs[i % dbs.length] }));
}
export function dropNote(ns: PNote[], k: number): PNote[] {
  const out = clone(ns);
  const [gone] = out.splice(k, 1);
  if (k > 0) out[k - 1].durSec += gone.durSec + (gone.restBefore ?? 0);
  else if (out.length) out[0].restBefore = (out[0].restBefore ?? 0) + gone.durSec;
  return out;
}
export function wrongNote(ns: PNote[], k: number, semis: number): PNote[] {
  const out = clone(ns);
  out[k].midi += semis;
  return out;
}
export function noScoop(ns: PNote[]): PNote[] {
  return clone(ns).map((n) => ({ ...n, scoopCents: 0, fallCents: 0 }));
}
export function sliceNotes(ns: PNote[], a: number, b: number): PNote[] {
  const out = clone(ns).slice(a, b);
  if (out.length) out[0].restBefore = 0;
  return out;
}

export interface Human {
  pitchSd: number;
  driftCents: number;
  onsetSd: number;
  tempo: number;
  tempoSd: number;
  gainSd: number;
  vibKeep: number;
  vibRateSd: number;
  vibExtentSd: number;
  dropScoops: boolean;
  wrong: number;
  dropNotes: number;
}

/** Simulated singers, from a careful copy to a poor one (random errors of each kind). */
export const HUMAN: Record<'pro' | 'good' | 'weak' | 'poor', Human> = {
  pro: { pitchSd: 12, driftCents: 0, onsetSd: 30, tempo: 1, tempoSd: 0.02, gainSd: 1, vibKeep: 1, vibRateSd: 0.07, vibExtentSd: 0.15, dropScoops: false, wrong: 0, dropNotes: 0 },
  good: { pitchSd: 25, driftCents: -20, onsetSd: 55, tempo: 0.96, tempoSd: 0.03, gainSd: 2, vibKeep: 0.5, vibRateSd: 0.12, vibExtentSd: 0.3, dropScoops: true, wrong: 0, dropNotes: 0 },
  weak: { pitchSd: 45, driftCents: -40, onsetSd: 100, tempo: 0.88, tempoSd: 0.04, gainSd: 3, vibKeep: 0, vibRateSd: 0, vibExtentSd: 0, dropScoops: true, wrong: 1, dropNotes: 0 },
  poor: { pitchSd: 70, driftCents: -70, onsetSd: 150, tempo: 0.8, tempoSd: 0.05, gainSd: 4, vibKeep: 0, vibRateSd: 0, vibExtentSd: 0, dropScoops: true, wrong: 2, dropNotes: 1 },
};

export function humanize(ns: PNote[], h: Human, seed: number): PNote[] {
  const r = makeRng(seed * 7919 + 13);
  let out = detuneAll(clone(ns), h.pitchSd, seed + 100);
  if (h.driftCents) out = drift(out, h.driftCents * (0.6 + 0.8 * r()));
  const wrongIdx = new Set<number>();
  while (wrongIdx.size < h.wrong) wrongIdx.add(1 + Math.floor(r() * (out.length - 2)));
  for (const k of wrongIdx) out[k].midi += (r() < 0.5 ? -1 : 1) * (2 + Math.round(r()));
  out = jitterOnsets(out, h.onsetSd, seed + 200);
  out = tempo(out, h.tempo * (1 + h.tempoSd * gauss(r)));
  out = gainPattern(out, out.map(() => h.gainSd * gauss(r)));
  for (const n of out) {
    if (n.vibrato) {
      if (r() > h.vibKeep) n.vibrato = null;
      else n.vibrato = { rateHz: n.vibrato.rateHz * (1 + h.vibRateSd * gauss(r)), extentCents: n.vibrato.extentCents * Math.max(0.3, 1 + h.vibExtentSd * gauss(r)), delaySec: Math.max(0.1, n.vibrato.delaySec + 0.08 * gauss(r)) };
    }
    if (h.dropScoops) {
      n.scoopCents = 0;
      n.fallCents = 0;
    }
  }
  for (let d = 0; d < h.dropNotes; d++) out = dropNote(out, 1 + Math.floor(r() * (out.length - 2)));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Signal tools: channel simulation and formant-preserving TD-PSOLA

export function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/** RBJ biquad, second order Butterworth, one pass (phase is irrelevant to the analysis). */
export function biquad(x: Float32Array, type: 'hp' | 'lp', fc: number, sr = SR): Float32Array {
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const cs = Math.cos(w0);
  const b0 = type === 'lp' ? (1 - cs) / 2 : (1 + cs) / 2;
  const b1 = type === 'lp' ? 1 - cs : -(1 + cs);
  const b2 = b0;
  const a0 = 1 + alpha;
  const a1 = -2 * cs;
  const a2 = 1 - alpha;
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** Phone-like channel: high-pass and low-pass corners. */
export function micRolloff(x: Float32Array, hpHz: number, lpHz = 0, sr = SR): Float32Array {
  let y = x;
  if (hpHz > 0) y = biquad(y, 'hp', hpHz, sr);
  if (lpHz > 0) y = biquad(y, 'lp', lpHz, sr);
  return y;
}

/** First-order tilt y = x - a x[-1] at the same overall level: a > 0 brightens, a < 0 darkens. */
export function tilt(x: Float32Array, a: number): Float32Array {
  const out = new Float32Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    out[i] = x[i] - a * prev;
    prev = x[i];
  }
  const g = rms(x) / (rms(out) || 1);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/** Stationary white noise at an SNR relative to the signal's overall RMS. */
export function addNoise(x: Float32Array, snrDb: number, seed = 5): Float32Array {
  const rng = makeRng(seed);
  const sigRms = rms(x.filter((v) => Math.abs(v) > 1e-4));
  const nRms = sigRms * 10 ** (-snrDb / 20);
  const noise = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) noise[i] = gauss(rng);
  const nr = rms(noise) || 1;
  const out = Float32Array.from(x);
  for (let i = 0; i < x.length; i++) out[i] += (noise[i] / nr) * nRms;
  return out;
}

/** Breathy component: noise high-passed at `hpHz` and scaled to follow the signal envelope, `relDb` below it. */
export function addAspiration(x: Float32Array, relDb: number, seed = 9, sr = SR, hpHz = 1500): Float32Array {
  const rng = makeRng(seed);
  const n = new Float32Array(x.length);
  for (let i = 0; i < n.length; i++) n[i] = gauss(rng);
  const nf = biquad(n, 'hp', hpHz, sr);
  const w = Math.round(0.03 * sr);
  const out = Float32Array.from(x);
  let acc = 0;
  const sq = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) sq[i] = x[i] * x[i];
  const nrm = rms(nf) || 1;
  const g = 10 ** (relDb / 20);
  for (let i = 0; i < x.length; i++) {
    acc += sq[i];
    if (i >= w) acc -= sq[i - w];
    out[i] += (nf[i] / nrm) * Math.sqrt(acc / Math.min(w, i + 1)) * g;
  }
  return out;
}

/** Convolve with a synthetic room impulse response (decaying noise); wet level in dB relative to dry. */
export function reverb(x: Float32Array, rt60: number, wetDb: number, seed = 21, sr = SR): Float32Array {
  const rng = makeRng(seed);
  const len = Math.round(rt60 * sr);
  const ir = new Float64Array(len);
  const decay = Math.log(1000) / (rt60 * sr);
  for (let i = 0; i < len; i++) ir[i] = gauss(rng) * Math.exp(-decay * i);
  let e = 0;
  for (let i = 0; i < len; i++) e += ir[i] * ir[i];
  const wet = 10 ** (wetDb / 20) / Math.sqrt(e);
  const size = nextPow2(x.length + len);
  const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size);
  for (let i = 0; i < x.length; i++) ar[i] = x[i];
  for (let i = 0; i < len; i++) br[i] = ir[i] * wet;
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < size; i++) {
    const re = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = re;
    ai[i] = im;
  }
  fft(ar, ai, true);
  const out = Float32Array.from(x);
  for (let i = 0; i < x.length; i++) out[i] += ar[i];
  return out;
}

export interface PsolaSpec {
  /** Output duration, s. */
  durationSec: number;
  /** Input time (s) that output time t is read from. Monotone non-decreasing. */
  timeMap: (tOut: number) => number;
  /** Pitch factor at output time t (1 = unchanged, 2 = octave up). Applied to voiced material only. */
  pitchFactor: (tOut: number) => number;
}

interface Marks {
  t: Float64Array;
  voiced: Uint8Array;
  T: Float64Array;
}

function analysisMarks(x: Float32Array, sr: number): Marks {
  const tr = trackPitch(x, sr, { hopSec: 0.01 });
  const f0At = (t: number): number => {
    const i = Math.max(0, Math.min(tr.f0.length - 1, Math.round(t / 0.01)));
    return tr.voiced[i] ? tr.f0[i] : NaN;
  };
  const ts: number[] = [];
  const vs: number[] = [];
  const Ts: number[] = [];
  let t = 0;
  const dur = x.length / sr;
  while (t < dur) {
    const f0 = f0At(t);
    if (!Number.isFinite(f0)) {
      ts.push(t);
      vs.push(0);
      Ts.push(0.01);
      t += 0.01;
      continue;
    }
    const T0 = 1 / f0;
    const a = Math.max(0, Math.round((t - 0.25 * T0) * sr));
    const b = Math.min(x.length - 1, Math.round((t + 0.25 * T0) * sr));
    let best = a;
    for (let i = a; i <= b; i++) if (x[i] > x[best]) best = i;
    const tm = best / sr;
    if (ts.length && tm <= ts[ts.length - 1]) {
      t += T0;
      continue;
    }
    ts.push(tm);
    vs.push(1);
    Ts.push(T0);
    t = tm + T0;
  }
  return { t: Float64Array.from(ts), voiced: Uint8Array.from(vs), T: Float64Array.from(Ts) };
}

function nearestMark(m: Marks, tau: number): number {
  let lo = 0;
  let hi = m.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m.t[mid] < tau) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(m.t[lo - 1] - tau) <= Math.abs(m.t[lo] - tau)) lo--;
  return lo;
}

/** TD-PSOLA re-timing and re-pitching. Formants stay where they are (the spectral envelope is not resampled). */
export function psola(x: Float32Array, spec: PsolaSpec, sr = SR): Float32Array {
  const marks = analysisMarks(x, sr);
  const n = Math.round(spec.durationSec * sr);
  const out = new Float32Array(n);
  let ts = 0;
  let guard = 0;
  while (ts < spec.durationSec && guard++ < 5_000_000) {
    const tau = Math.max(0, Math.min(x.length / sr - 1e-3, spec.timeMap(ts)));
    const i = nearestMark(marks, tau);
    const voiced = marks.voiced[i] === 1;
    const T0 = marks.T[i];
    const beta = voiced ? Math.max(0.25, Math.min(4, spec.pitchFactor(ts))) : 1;
    const half = Math.max(2, Math.round(T0 * sr));
    const centre = Math.round(marks.t[i] * sr);
    const oc = Math.round(ts * sr);
    for (let k = -half; k <= half; k++) {
      const si = centre + k;
      const oi = oc + k;
      if (si < 0 || si >= x.length || oi < 0 || oi >= n) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / (half + 1));
      out[oi] += (x[si] * w) / beta;
    }
    ts += T0 / beta;
  }
  return out;
}

/** Piecewise-linear map through (outT -> inT) anchors. */
export function pwl(anchors: [number, number][]): (t: number) => number {
  return (t) => {
    if (t <= anchors[0][0]) return anchors[0][1] + (t - anchors[0][0]);
    for (let i = 1; i < anchors.length; i++) {
      if (t <= anchors[i][0]) {
        const [x0, y0] = anchors[i - 1];
        const [x1, y1] = anchors[i];
        return x1 > x0 ? y0 + ((t - x0) / (x1 - x0)) * (y1 - y0) : y1;
      }
    }
    const [x0, y0] = anchors[anchors.length - 2];
    const [x1, y1] = anchors[anchors.length - 1];
    return y1 + (t - x1) * (x1 > x0 ? (y1 - y0) / (x1 - x0) : 1);
  };
}

export const centsToFactor = (c: number): number => 2 ** (c / 1200);

/** A clip at the analysis rate (22.05 kHz), so PSOLA marks and the analyser see the same samples. */
export function toAnalysisRate(x: Float32Array, rate: number): Float32Array {
  return resample(x, rate, SR);
}

/** PSOLA at 4x the analysis rate: at 22.05 kHz one sample is 60 cents of a 780 Hz period, so marks on whole samples add pitch jitter. */
export function psolaHQ(x: Float32Array, spec: PsolaSpec): Float32Array {
  const up = resample(x, SR, SR * 4);
  const y = psola(up, spec, SR * 4);
  return resample(y, SR * 4, SR);
}
