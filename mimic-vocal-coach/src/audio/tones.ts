// Practice tones with Web Audio: a soft piano/organ-like voice built from a few sine partials (one
// PeriodicWave oscillator per note), shaped by an ADSR envelope and a gentle lowpass. No samples.
// The shared AudioContext is created lazily, so the first call must come from a user gesture.

import { midiToHz } from '../dsp/music';
import type { Exercise } from '../types';

export interface PatternPlayer {
  stop(): void;
  readonly playing: boolean;
}

type Pattern = NonNullable<Exercise['pattern']>;

export interface PatternEvent {
  kind: 'cue' | 'note' | 'glide';
  /** The sounding note; for a glide the low note it starts and ends on. */
  midi: number;
  /** Glide only: the top note, reached halfway through the glide. */
  peakMidi?: number;
  startBeat: number;
  beats: number;
  /** Repetition index, 0-based. */
  rep: number;
}

export interface PatternSchedule {
  events: PatternEvent[];
  totalBeats: number;
  secPerBeat: number;
}

// Keep generated notes on a piano's range whatever the exercise data says.
const MIDI_MIN = 21;
const MIDI_MAX = 108;
const DEFAULT_BPM = 80;
const SIREN_HALF_BEATS = 2;
const SUSTAIN_BEATS = 4;

function clampMidi(m: number): number {
  return Math.min(MIDI_MAX, Math.max(MIDI_MIN, Math.round(m)));
}

/**
 * The note sequence of an exercise pattern, in beats. Each repetition starts with a one-beat cue
 * note (its first pitch) so the singer hears the new key; repetitions are separated by a one-beat
 * rest and transposed up by `stepUpSemitones`. Scales and arpeggios play one beat per step,
 * 'sustain' holds each step for four beats, and 'siren' glides from steps[0] to steps[1] over two
 * beats and back down over two.
 */
export function patternSchedule(pattern: Pattern, passaggioLowMidi: number): PatternSchedule {
  const bpm = Number.isFinite(pattern.bpm) && pattern.bpm >= 20 && pattern.bpm <= 300 ? pattern.bpm : DEFAULT_BPM;
  const reps = Math.max(1, Math.min(24, Math.floor(Number.isFinite(pattern.repetitions) ? pattern.repetitions : 1)));
  const steps = pattern.steps.filter((s) => Number.isFinite(s));
  const events: PatternEvent[] = [];
  let beat = 0;
  if (steps.length === 0) return { events, totalBeats: 0, secPerBeat: 60 / bpm };
  const start = passaggioLowMidi + pattern.startOffsetFromPassaggio;
  const stepUp = Number.isFinite(pattern.stepUpSemitones) ? pattern.stepUpSemitones : 0;
  for (let rep = 0; rep < reps; rep++) {
    if (rep > 0) beat += 1; // rest between repetitions
    const base = start + rep * stepUp;
    events.push({ kind: 'cue', midi: clampMidi(base + steps[0]), startBeat: beat, beats: 1, rep });
    beat += 1;
    if (pattern.kind === 'siren') {
      const low = clampMidi(base + steps[0]);
      const high = clampMidi(base + (steps.length > 1 ? steps[1] : steps[0]));
      events.push({ kind: 'glide', midi: low, peakMidi: high, startBeat: beat, beats: 2 * SIREN_HALF_BEATS, rep });
      beat += 2 * SIREN_HALF_BEATS;
    } else {
      const len = pattern.kind === 'sustain' ? SUSTAIN_BEATS : 1;
      for (const s of steps) {
        events.push({ kind: 'note', midi: clampMidi(base + s), startBeat: beat, beats: len, rep });
        beat += len;
      }
    }
  }
  return { events, totalBeats: beat, secPerBeat: 60 / bpm };
}

/** The first note a pattern plays for a given passaggio (what the Practice page shows as "starts on"). */
export function patternStartMidi(pattern: Pattern, passaggioLowMidi: number): number {
  return clampMidi(passaggioLowMidi + pattern.startOffsetFromPassaggio + (pattern.steps[0] ?? 0));
}

// ---------------------------------------------------------------------------------------------
// Web Audio engine

type AudioContextCtor = new () => AudioContext;

let sharedCtx: AudioContext | null = null;
const waves = new WeakMap<AudioContext, PeriodicWave | null>();

function audioCtor(): AudioContextCtor | null {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Whether this browser can play practice tones at all. */
export function audioSupported(): boolean {
  return audioCtor() !== null;
}

function getContext(): AudioContext | null {
  if (!sharedCtx) {
    const Ctor = audioCtor();
    if (!Ctor) return null;
    try {
      sharedCtx = new Ctor();
    } catch {
      return null;
    }
  }
  if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => undefined);
  return sharedCtx;
}

// Harmonic amplitudes 1, 2, 3, 4, 5: a round fundamental with a little upper colour (piano/organ-ish).
const PARTIALS = [0, 1, 0.42, 0.2, 0.1, 0.05];

function toneWave(ac: AudioContext): PeriodicWave | null {
  if (waves.has(ac)) return waves.get(ac) ?? null;
  let wave: PeriodicWave | null = null;
  try {
    const imag = new Float32Array(PARTIALS);
    wave = ac.createPeriodicWave(new Float32Array(imag.length), imag);
  } catch {
    wave = null;
  }
  waves.set(ac, wave);
  return wave;
}

interface Envelope {
  attack: number;
  decay: number;
  /** Sustain level relative to the peak. */
  sustain: number;
  release: number;
}

const PLUCK: Envelope = { attack: 0.012, decay: 0.35, sustain: 0.55, release: 0.14 };
const ORGAN: Envelope = { attack: 0.25, decay: 0.2, sustain: 0.85, release: 0.4 };

interface Voice {
  osc: OscillatorNode;
  env: GainNode;
  /** When the voice (including release) finishes, in context time. */
  end: number;
}

/**
 * One note from `start` for `dur` seconds (release after). `freqs` with more than one value glides
 * through them evenly over the note. With `hold`, the note sustains until the caller stops it and
 * `dur` only bounds the attack/decay. Returns null only if node creation fails.
 */
function scheduleVoice(
  ac: AudioContext,
  dest: AudioNode,
  start: number,
  dur: number,
  freqs: number[],
  peak: number,
  env: Envelope,
  hold = false,
): Voice | null {
  try {
    const osc = ac.createOscillator();
    const wave = toneWave(ac);
    if (wave) osc.setPeriodicWave(wave);
    else osc.type = 'sine';
    osc.frequency.setValueAtTime(freqs[0], start);
    for (let i = 1; i < freqs.length; i++) osc.frequency.exponentialRampToValueAtTime(freqs[i], start + (dur * i) / (freqs.length - 1));

    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    // Around the 4th-5th harmonic of the highest note: softens the upper partials without muffling.
    filter.frequency.setValueAtTime(Math.min(6000, Math.max(...freqs) * 4.5), start);
    filter.Q.setValueAtTime(0.5, start);

    const gain = ac.createGain();
    const g = gain.gain;
    const attackEnd = start + Math.min(env.attack, dur * 0.5);
    const decayEnd = Math.min(start + dur, attackEnd + env.decay);
    const end = start + dur + env.release;
    g.setValueAtTime(0, start);
    g.linearRampToValueAtTime(peak, attackEnd);
    g.linearRampToValueAtTime(peak * env.sustain, decayEnd);
    if (!hold) {
      g.setValueAtTime(peak * env.sustain, start + dur);
      g.linearRampToValueAtTime(0, end);
    }

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    osc.start(start);
    // Stop is scheduled only once per oscillator: older engines throw on a second stop().
    if (!hold) osc.stop(end + 0.02);
    return { osc, env: gain, end };
  } catch {
    return null;
  }
}

function masterBus(ac: AudioContext, volume: number): GainNode {
  const master = ac.createGain();
  master.gain.setValueAtTime(Math.min(1, Math.max(0, volume)), ac.currentTime);
  master.connect(ac.destination);
  return master;
}

/** Fades a bus out quickly (avoids a click), then stops its voices and disconnects it. */
function silence(ac: AudioContext, master: GainNode, voices: Voice[]): void {
  const now = ac.currentTime;
  try {
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.04);
    for (const v of voices) {
      try {
        v.osc.stop(now + 0.05);
      } catch {
        // Already stopped.
      }
    }
  } catch {
    // Context closed; nothing is sounding.
  }
  setTimeout(() => {
    try {
      master.disconnect();
    } catch {
      // Already disconnected.
    }
  }, 120);
}

const DEFAULT_VOLUME = 0.35;

/** Plays a single note (reference pitch). */
export function playNote(midi: number, durSec: number, opts: { a4Hz?: number; volume?: number } = {}): void {
  const ac = getContext();
  if (!ac || !Number.isFinite(midi)) return;
  const master = masterBus(ac, opts.volume ?? DEFAULT_VOLUME);
  const start = ac.currentTime + 0.02;
  const v = scheduleVoice(ac, master, start, Math.max(0.1, durSec), [midiToHz(clampMidi(midi), opts.a4Hz ?? 440)], 0.8, PLUCK);
  const endMs = ((v?.end ?? start) - ac.currentTime + 0.2) * 1000;
  setTimeout(() => {
    try {
      master.disconnect();
    } catch {
      // Already disconnected.
    }
  }, endMs);
}

/** Holds a note until stop() (for tuning against a steady pitch). */
export function startDrone(midi: number, opts: { a4Hz?: number; volume?: number } = {}): { stop(): void } {
  const ac = getContext();
  if (!ac || !Number.isFinite(midi)) return { stop: () => undefined };
  const master = masterBus(ac, (opts.volume ?? DEFAULT_VOLUME) * 0.8);
  const v = scheduleVoice(ac, master, ac.currentTime + 0.02, 1, [midiToHz(clampMidi(midi), opts.a4Hz ?? 440)], 0.8, ORGAN, true);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const now = ac.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0, now + ORGAN.release);
        v?.osc.stop(now + ORGAN.release + 0.05);
      } catch {
        // Context closed.
      }
      setTimeout(() => {
        try {
          master.disconnect();
        } catch {
          // Already disconnected.
        }
      }, (ORGAN.release + 0.2) * 1000);
    },
  };
}

/**
 * Plays an exercise's pattern starting from the user's passaggio (see patternSchedule). onStep
 * fires as each note (and a siren's top note) sounds; onEnd fires when it finishes or is stopped.
 */
export function playPattern(
  ex: Exercise,
  passaggioLowMidi: number,
  opts: { a4Hz?: number; volume?: number; onStep?: (midi: number, rep: number) => void; onEnd?: () => void } = {},
): PatternPlayer {
  const ac = ex.pattern ? getContext() : null;
  const schedule = ex.pattern ? patternSchedule(ex.pattern, passaggioLowMidi) : null;
  if (!ac || !schedule || schedule.events.length === 0) {
    // Nothing can play: report the end asynchronously, like a real (very short) playback.
    setTimeout(() => opts.onEnd?.(), 0);
    return { stop: () => undefined, playing: false };
  }

  const a4 = opts.a4Hz ?? 440;
  const spb = schedule.secPerBeat;
  const master = masterBus(ac, opts.volume ?? DEFAULT_VOLUME);
  const t0 = ac.currentTime + 0.12;
  const voices: Voice[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let playing = true;
  const at = (sec: number, fn: () => void) => timers.push(setTimeout(fn, Math.max(0, (sec - ac.currentTime) * 1000)));

  for (const ev of schedule.events) {
    const start = t0 + ev.startBeat * spb;
    const dur = ev.beats * spb;
    if (ev.kind === 'glide') {
      const low = midiToHz(ev.midi, a4);
      const high = midiToHz(ev.peakMidi ?? ev.midi, a4);
      const v = scheduleVoice(ac, master, start, dur * 0.97, [low, high, low], 0.75, ORGAN);
      if (v) voices.push(v);
      at(start, () => opts.onStep?.(ev.midi, ev.rep));
      at(start + dur / 2, () => opts.onStep?.(ev.peakMidi ?? ev.midi, ev.rep));
    } else {
      // Slightly detached notes read as separate steps; the cue is softer than the pattern.
      const v = scheduleVoice(ac, master, start, dur * 0.9, [midiToHz(ev.midi, a4)], ev.kind === 'cue' ? 0.55 : 0.8, ev.beats >= SUSTAIN_BEATS ? ORGAN : PLUCK);
      if (v) voices.push(v);
      at(start, () => opts.onStep?.(ev.midi, ev.rep));
    }
  }

  const finish = () => {
    if (!playing) return;
    playing = false;
    for (const t of timers) clearTimeout(t);
    silence(ac, master, voices);
    opts.onEnd?.();
  };
  at(t0 + schedule.totalBeats * spb + 0.25, finish);

  return {
    stop: finish,
    get playing() {
      return playing;
    },
  };
}
