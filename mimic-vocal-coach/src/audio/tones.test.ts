import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exercise } from '../types';

type Pattern = NonNullable<Exercise['pattern']>;

function ex(pattern: Pattern | undefined, id = 'ex'): Exercise {
  return { id, name: 'Test', goal: 'Test goal.', helps: [], steps: ['Sing.'], durationMin: 3, pattern };
}

const scale: Pattern = { kind: 'scale', steps: [0, 2, 4, 2, 0], bpm: 120, startOffsetFromPassaggio: -7, stepUpSemitones: 1, repetitions: 3 };

describe('patternSchedule', () => {
  it('starts at passaggio + offset, cues each round and rests between rounds', async () => {
    const { patternSchedule } = await import('./tones');
    const s = patternSchedule(scale, 62); // baritone-ish passaggio low D4 -> start G3 (55)
    expect(s.secPerBeat).toBe(0.5);
    const rounds = [0, 1, 2].map((r) => s.events.filter((e) => e.rep === r));
    expect(rounds[0].map((e) => [e.kind, e.midi, e.startBeat])).toEqual([
      ['cue', 55, 0],
      ['note', 55, 1],
      ['note', 57, 2],
      ['note', 59, 3],
      ['note', 57, 4],
      ['note', 55, 5],
    ]);
    // Round 2: one-beat rest after beat 6, cue a semitone up at beat 7.
    expect(rounds[1][0]).toEqual({ kind: 'cue', midi: 56, startBeat: 7, beats: 1, rep: 1 });
    expect(rounds[1].slice(1).map((e) => e.midi)).toEqual([56, 58, 60, 58, 56]);
    expect(rounds[2][0].startBeat).toBe(14);
    expect(s.totalBeats).toBe(20);
    expect(s.events.every((e) => e.beats === 1)).toBe(true);
  });

  it('holds sustain steps for four beats', async () => {
    const { patternSchedule } = await import('./tones');
    const s = patternSchedule({ kind: 'sustain', steps: [0, 4], bpm: 60, startOffsetFromPassaggio: 0, stepUpSemitones: 0, repetitions: 2 }, 60);
    const notes = s.events.filter((e) => e.kind === 'note');
    expect(notes.map((e) => [e.midi, e.startBeat, e.beats])).toEqual([
      [60, 1, 4],
      [64, 5, 4],
      [60, 11, 4],
      [64, 15, 4],
    ]);
    expect(s.totalBeats).toBe(19);
    expect(s.secPerBeat).toBe(1);
  });

  it('glides a siren up over two beats and back over two', async () => {
    const { patternSchedule } = await import('./tones');
    const s = patternSchedule({ kind: 'siren', steps: [-5, 7], bpm: 90, startOffsetFromPassaggio: 0, stepUpSemitones: 2, repetitions: 2 }, 64);
    expect(s.events).toEqual([
      { kind: 'cue', midi: 59, startBeat: 0, beats: 1, rep: 0 },
      { kind: 'glide', midi: 59, peakMidi: 71, startBeat: 1, beats: 4, rep: 0 },
      { kind: 'cue', midi: 61, startBeat: 6, beats: 1, rep: 1 },
      { kind: 'glide', midi: 61, peakMidi: 73, startBeat: 7, beats: 4, rep: 1 },
    ]);
    expect(s.totalBeats).toBe(11);
  });

  it('guards odd exercise data', async () => {
    const { patternSchedule, patternStartMidi } = await import('./tones');
    expect(patternSchedule({ ...scale, steps: [] }, 60).events).toEqual([]);
    const s = patternSchedule({ ...scale, bpm: 0, repetitions: 0 }, 60);
    expect(s.secPerBeat).toBeCloseTo(60 / 80);
    expect(new Set(s.events.map((e) => e.rep))).toEqual(new Set([0]));
    // Notes are clamped to the piano's range.
    expect(Math.max(...patternSchedule({ ...scale, startOffsetFromPassaggio: 60 }, 60).events.map((e) => e.midi))).toBe(108);
    expect(patternStartMidi(scale, 62)).toBe(55);
    expect(patternStartMidi({ ...scale, steps: [3, 5] }, 62)).toBe(58);
  });
});

// ---------------------------------------------------------------------------------------------
// Playback against a fake Web Audio graph (records what gets scheduled).

class FakeParam {
  value = 0;
  calls: [string, number, number?][] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(['set', v, t]);
    this.value = v;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['lin', v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(['exp', v, t]);
  }
  cancelScheduledValues(t: number) {
    this.calls.push(['cancel', 0, t]);
  }
}

class FakeNode {
  connected: unknown[] = [];
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {
    this.connected = [];
  }
}

class FakeOsc extends FakeNode {
  frequency = new FakeParam();
  type = 'sine';
  started: number | null = null;
  stops: number[] = [];
  wave: unknown = null;
  setPeriodicWave(w: unknown) {
    this.wave = w;
  }
  start(t: number) {
    this.started = t;
  }
  stop(t: number) {
    this.stops.push(t);
  }
}

class FakeCtx {
  static instances: FakeCtx[] = [];
  currentTime = 0;
  state: 'running' | 'suspended' = 'suspended';
  destination = new FakeNode();
  oscs: FakeOsc[] = [];
  gains: (FakeNode & { gain: FakeParam })[] = [];
  resumed = 0;
  constructor() {
    FakeCtx.instances.push(this);
  }
  resume() {
    this.resumed++;
    this.state = 'running';
    return Promise.resolve();
  }
  createOscillator() {
    const o = new FakeOsc();
    this.oscs.push(o);
    return o;
  }
  createGain() {
    const g = Object.assign(new FakeNode(), { gain: new FakeParam() });
    this.gains.push(g);
    return g;
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() });
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array) {
    return { real, imag };
  }
}

describe('playback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    FakeCtx.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports no audio and ends immediately without an AudioContext', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const tones = await import('./tones');
    expect(tones.audioSupported()).toBe(false);
    const onEnd = vi.fn();
    const p = tones.playPattern(ex(scale), 62, { onEnd });
    expect(p.playing).toBe(false);
    vi.runAllTimers();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(() => tones.playNote(60, 1)).not.toThrow();
    expect(() => tones.startDrone(60).stop()).not.toThrow();
  });

  it('schedules every note, fires onStep in order and onEnd at the end', async () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    const tones = await import('./tones');
    const steps: [number, number][] = [];
    const onEnd = vi.fn();
    const p = tones.playPattern(ex(scale), 62, { a4Hz: 440, onStep: (m, r) => steps.push([m, r]), onEnd });
    const ctx = FakeCtx.instances[0];
    expect(ctx.resumed).toBe(1);
    expect(p.playing).toBe(true);
    // 3 rounds x (cue + 5 notes), one oscillator each.
    expect(ctx.oscs).toHaveLength(18);
    expect(ctx.oscs[0].wave).not.toBeNull();
    // First cue G3 = 196 Hz at A4 = 440.
    expect(ctx.oscs[0].frequency.calls[0][1]).toBeCloseTo(196, 0);
    // Notes are half a second apart at 120 bpm.
    expect(ctx.oscs[2].started! - ctx.oscs[1].started!).toBeCloseTo(0.5);

    vi.advanceTimersByTime(20 * 500 + 1000);
    expect(steps.slice(0, 6)).toEqual([
      [55, 0],
      [55, 0],
      [57, 0],
      [59, 0],
      [57, 0],
      [55, 0],
    ]);
    expect(steps).toHaveLength(18);
    expect(steps[6]).toEqual([56, 1]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(p.playing).toBe(false);
  });

  it('stop() silences the bus, cancels pending steps and reports the end once', async () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    const tones = await import('./tones');
    const onStep = vi.fn();
    const onEnd = vi.fn();
    const p = tones.playPattern(ex(scale), 62, { onStep, onEnd });
    vi.advanceTimersByTime(700);
    const before = onStep.mock.calls.length;
    p.stop();
    p.stop();
    expect(p.playing).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onStep.mock.calls.length).toBe(before);
    const ctx = FakeCtx.instances[0];
    const master = ctx.gains[0];
    expect(master.gain.calls.some(([k, v]) => k === 'lin' && v === 0)).toBe(true);
  });

  it('a siren glides the oscillator up and back down', async () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    const tones = await import('./tones');
    const onStep = vi.fn();
    tones.playPattern(ex({ kind: 'siren', steps: [0, 12], bpm: 60, startOffsetFromPassaggio: 0, stepUpSemitones: 0, repetitions: 1 }), 57, { onStep });
    const glide = FakeCtx.instances[0].oscs[1];
    const [set, up, down] = glide.frequency.calls;
    expect(set[1]).toBeCloseTo(220, 0);
    expect(up[0]).toBe('exp');
    expect(up[1]).toBeCloseTo(440, 0);
    expect(down[1]).toBeCloseTo(220, 0);
    vi.advanceTimersByTime(10_000);
    expect(onStep.mock.calls.map((c) => c[0])).toEqual([57, 57, 69]);
  });

  it('shares one AudioContext and plays notes and drones', async () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    const tones = await import('./tones');
    tones.playNote(69, 1, { a4Hz: 442 });
    const drone = tones.startDrone(57);
    expect(FakeCtx.instances).toHaveLength(1);
    const ctx = FakeCtx.instances[0];
    expect(ctx.oscs[0].frequency.calls[0][1]).toBeCloseTo(442);
    expect(ctx.oscs[0].stops).toHaveLength(1);
    // The drone holds until stopped.
    expect(ctx.oscs[1].stops).toHaveLength(0);
    drone.stop();
    drone.stop();
    expect(ctx.oscs[1].stops).toHaveLength(1);
  });
});
