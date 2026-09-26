// A ~15 s synthesized take for the "Try a demo take" button, built to exercise every part of the
// results page for a baritone: a rising phrase through the passaggio with chest-heavy, louder
// notes at the top; held notes with ~5.5 Hz vibrato; a short run; and a flip into falsetto on a
// top note. Phrases are separated by short breaths. Deterministic.
//
// It uses a wavetable version of the test synthesiser (same harmonic source model, vowel formants
// and pulsed aspiration noise; see src/testing/synth.ts) because summing every harmonic per sample
// for 15 s at 44.1 kHz takes over a second on the main thread, and this runs on a button press.

import { fft } from '../dsp/fft';
import { formantGain, makeRng, type Vowel } from '../testing/synth';

interface Timbre {
  tiltDbPerOct: number;
  h1BoostDb: number;
  breath: number;
  vowel: Vowel;
}

interface DemoNote {
  midi: number;
  durSec: number;
  /** Level in dB relative to the other notes (the whole take is normalised to a -3 dBFS peak). */
  levelDb: number;
  timbre: Timbre;
  vibrato?: boolean;
  /** Tuning error, so the pitch-accuracy readout is not an implausible zero. */
  cents?: number;
}

interface DemoPhrase {
  startSec: number;
  notes: DemoNote[];
  /** Seconds of audible aspiration before the tone starts (a breathy onset). */
  airSec?: number;
}

const CHEST: Timbre = { tiltDbPerOct: -7, h1BoostDb: 0, breath: 0.03, vowel: 'a' };
const CHEST_O: Timbre = { ...CHEST, vowel: 'o' };
const MIX: Timbre = { tiltDbPerOct: -12, h1BoostDb: 3, breath: 0.12, vowel: 'a' };
const MIX_O: Timbre = { ...MIX, vowel: 'o' };
const FALSETTO: Timbre = { tiltDbPerOct: -20, h1BoostDb: 10, breath: 0.3, vowel: 'o' };

const PHRASES: DemoPhrase[] = [
  {
    // G3 -> A4 through the baritone passaggio (D4-G4), getting louder in chest as it climbs,
    // then easing into a lighter mix on the held A4.
    startSec: 0.35,
    notes: [
      { midi: 55, durSec: 0.45, levelDb: -22, timbre: CHEST },
      { midi: 57, durSec: 0.35, levelDb: -21, timbre: CHEST, cents: 12 },
      { midi: 59, durSec: 0.35, levelDb: -19, timbre: CHEST },
      { midi: 62, durSec: 0.45, levelDb: -17, timbre: CHEST, cents: -8 },
      { midi: 64, durSec: 0.45, levelDb: -14, timbre: CHEST, cents: 15 },
      { midi: 66, durSec: 0.45, levelDb: -12, timbre: CHEST, cents: 22 },
      { midi: 67, durSec: 0.6, levelDb: -10, timbre: CHEST, cents: 18 },
      { midi: 69, durSec: 1.0, levelDb: -14, timbre: MIX, vibrato: true, cents: -10 },
    ],
  },
  {
    // Held notes with vibrato in a mix, starting with an aspirated (breathy) onset.
    startSec: 4.95,
    airSec: 0.08,
    notes: [
      { midi: 64, durSec: 1.3, levelDb: -16, timbre: MIX_O, vibrato: true, cents: 6 },
      { midi: 62, durSec: 1.5, levelDb: -18, timbre: MIX_O, vibrato: true, cents: -14 },
    ],
  },
  {
    // A short run (7 notes of 0.13 s) landing on a held D4.
    startSec: 8.2,
    notes: [
      { midi: 59, durSec: 0.13, levelDb: -18, timbre: MIX },
      { midi: 62, durSec: 0.13, levelDb: -17, timbre: MIX },
      { midi: 64, durSec: 0.13, levelDb: -16, timbre: MIX },
      { midi: 67, durSec: 0.13, levelDb: -15, timbre: MIX, cents: -25 },
      { midi: 64, durSec: 0.13, levelDb: -16, timbre: MIX },
      { midi: 62, durSec: 0.13, levelDb: -17, timbre: MIX },
      { midi: 59, durSec: 0.13, levelDb: -18, timbre: MIX },
      { midi: 62, durSec: 0.9, levelDb: -18, timbre: MIX, vibrato: true, cents: 9 },
    ],
  },
  {
    // Climb in chest, then flip up a fifth into a soft falsetto B4 with vibrato.
    startSec: 10.95,
    notes: [
      { midi: 62, durSec: 0.6, levelDb: -16, timbre: CHEST_O },
      { midi: 64, durSec: 0.5, levelDb: -13, timbre: CHEST_O, cents: 10 },
      { midi: 71, durSec: 1.3, levelDb: -17, timbre: FALSETTO, vibrato: true, cents: -12 },
      { midi: 69, durSec: 0.7, levelDb: -19, timbre: FALSETTO, cents: -6 },
    ],
  },
];

const TOTAL_SEC = 15;
const TABLE_SIZE = 2048;
const GLIDE_SEC = 0.04;
const ATTACK_SEC = 0.04;
const RELEASE_SEC = 0.08;
const VIBRATO = { rateHz: 5.5, extentCents: 45, delaySec: 0.25, rampSec: 0.2 };
/** Background noise so the noise floor and SNR look like a real (good) home recording. */
const ROOM_NOISE_RMS = 0.0005;
const DEMO_PEAK = 0.7;

/** One period of the harmonic source for a note (unit RMS), built by inverse FFT. */
function makeTable(f0: number, timbre: Timbre, sampleRate: number): Float64Array {
  const re = new Float64Array(TABLE_SIZE);
  const im = new Float64Array(TABLE_SIZE);
  const maxK = Math.min(TABLE_SIZE / 2 - 1, Math.floor((sampleRate * 0.45) / f0));
  const h1 = Math.pow(10, timbre.h1BoostDb / 20);
  let power = 0;
  for (let k = 1; k <= maxK; k++) {
    let amp = Math.pow(k, timbre.tiltDbPerOct / 6.0206) * formantGain(k * f0, timbre.vowel);
    if (k === 1) amp *= h1;
    // sin(2 pi k n / N) has spectrum -i N/2 at bin k and +i N/2 at bin N - k.
    im[k] = -amp * (TABLE_SIZE / 2);
    im[TABLE_SIZE - k] = amp * (TABLE_SIZE / 2);
    power += (amp * amp) / 2;
  }
  fft(re, im, true);
  const scale = 1 / Math.sqrt(power || 1);
  for (let i = 0; i < TABLE_SIZE; i++) re[i] *= scale;
  return re;
}

function lookup(table: Float64Array, phase: number): number {
  const pos = (phase - Math.floor(phase)) * TABLE_SIZE;
  const i = Math.floor(pos);
  const frac = pos - i;
  return table[i] + (table[(i + 1) % TABLE_SIZE] - table[i]) * frac;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function renderPhrase(out: Float32Array, sampleRate: number, phrase: DemoPhrase, rng: () => number): void {
  const tables = phrase.notes.map((n) => makeTable(midiToHz(n.midi), n.timbre, sampleRate));
  const pitches = phrase.notes.map((n) => n.midi + (n.cents ?? 0) / 100);
  const gains = phrase.notes.map((n) => Math.pow(10, n.levelDb / 20));
  const starts: number[] = [];
  let total = 0;
  for (const n of phrase.notes) {
    starts.push(total);
    total += n.durSec;
  }
  const s0 = Math.round(phrase.startSec * sampleRate);
  const len = Math.round(total * sampleRate);
  let phase = 0;
  let prevNoise = 0;
  let idx = 0;

  // Aspirated onset: breath noise fading in over airSec before the tone.
  if (phrase.airSec) {
    const airLen = Math.round(phrase.airSec * sampleRate);
    const level = Math.pow(10, (phrase.notes[0].levelDb - 12) / 20);
    for (let i = 0; i < airLen; i++) {
      const w = gauss(rng);
      const v = 0.6 * (w - prevNoise) + 0.4 * w;
      prevNoise = w;
      const pos = s0 - airLen + i;
      if (pos >= 0 && pos < out.length) out[pos] += level * v * Math.min(1, (i / airLen) * 2);
    }
  }

  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    while (idx < phrase.notes.length - 1 && t >= starts[idx + 1]) idx++;
    const note = phrase.notes[idx];
    const into = t - starts[idx];
    const prev = idx > 0 ? phrase.notes[idx - 1] : null;
    const g = prev && into < GLIDE_SEC ? into / GLIDE_SEC : 1;
    let midi = prev ? pitches[idx - 1] + (pitches[idx] - pitches[idx - 1]) * g : pitches[idx];
    if (note.vibrato && into > VIBRATO.delaySec) {
      const ramp = Math.min(1, (into - VIBRATO.delaySec) / VIBRATO.rampSec);
      midi += (ramp * VIBRATO.extentCents * Math.sin(2 * Math.PI * VIBRATO.rateHz * (into - VIBRATO.delaySec))) / 100;
    }
    phase += midiToHz(midi) / sampleRate;
    // Timbre and level crossfade from the previous note over the glide.
    const cur = lookup(tables[idx], phase);
    const tone = prev ? g * cur + (1 - g) * lookup(tables[idx - 1], phase) : cur;
    const gain = prev ? gains[idx - 1] + (gains[idx] - gains[idx - 1]) * g : gains[idx];
    const breath = prev ? prev.timbre.breath + (note.timbre.breath - prev.timbre.breath) * g : note.timbre.breath;
    const cyc = phase - Math.floor(phase);
    const pulse = 0.35 + 0.65 * Math.exp(-((cyc - 0.3) ** 2) / 0.02);
    const w = gauss(rng);
    const noise = (0.6 * (w - prevNoise) + 0.4 * w) * pulse;
    prevNoise = w;
    let env = 1;
    if (t < ATTACK_SEC) env = t / ATTACK_SEC;
    if (total - t < RELEASE_SEC) env = Math.min(env, (total - t) / RELEASE_SEC);
    const pos = s0 + i;
    if (pos < out.length) out[pos] += env * gain * (tone + breath * noise * 0.8);
  }
}

function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** ~15 s synthesized take (rising phrase through the passaggio, held notes with vibrato, a short run, a falsetto flip) for the "Try a demo take" button. */
export function makeDemoTake(sampleRate = 44100): { samples: Float32Array; sampleRate: number } {
  const sr = sampleRate > 8000 && Number.isFinite(sampleRate) ? Math.round(sampleRate) : 44100;
  const out = new Float32Array(Math.round(TOTAL_SEC * sr));
  const rng = makeRng(2024);
  for (let i = 0; i < out.length; i++) out[i] = ROOM_NOISE_RMS * gauss(rng);
  for (const phrase of PHRASES) renderPhrase(out, sr, phrase, rng);
  // The note levels are relative; set the loudest peak to -3 dBFS so nothing clips.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = peak > 0 ? DEMO_PEAK / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return { samples: out, sampleRate: sr };
}
