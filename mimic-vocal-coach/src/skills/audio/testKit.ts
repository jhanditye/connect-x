// Test fakes for src/skills/audio (not used by the app): a Web Audio context whose clock follows Date.now() (so
// vi.useFakeTimers drives it), and a Recorder whose analyser serves frames of a prepared signal in step with that clock.

import type { InterruptionReason, Recorder } from '../../audio/recorder';

export class FakeParam {
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

export class FakeNode {
  connected: unknown[] = [];
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {
    this.connected = [];
  }
}

export class FakeOsc extends FakeNode {
  frequency = new FakeParam();
  type = 'sine';
  started: number | null = null;
  stops: number[] = [];
  setPeriodicWave() {}
  start(t: number) {
    this.started = t;
  }
  stop(t: number) {
    this.stops.push(t);
  }
}

/** A context whose clock runs with Date.now() while `running` (fake timers move Date.now). `frozen` stops the clock. */
export class FakeClockCtx {
  static instances: FakeClockCtx[] = [];
  static startFrozen = false;
  state: 'running' | 'suspended' | 'closed' = 'suspended';
  sampleRate = 48000;
  destination = new FakeNode();
  oscs: FakeOsc[] = [];
  gains: (FakeNode & { gain: FakeParam })[] = [];
  frozen = FakeClockCtx.startFrozen;
  private base = Date.now();
  private frozenAt = 0;
  constructor() {
    FakeClockCtx.instances.push(this);
  }
  get currentTime() {
    return this.frozen ? this.frozenAt : (Date.now() - this.base) / 1000;
  }
  resume() {
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

/** Oscillators started at context time `t` (rounded to the ms) with their first frequency. */
export function startedTones(ctx: FakeClockCtx): { at: number; hz: number }[] {
  return ctx.oscs.map((o) => ({ at: Math.round((o.started ?? NaN) * 1000) / 1000, hz: o.frequency.calls[0]?.[1] ?? NaN }));
}

export interface FakeRecorderControl {
  recorder: Recorder;
  started: boolean;
  stopped: boolean;
  cancelled: boolean;
  /** Fire an interruption as the real recorder would. */
  interrupt(reason: InterruptionReason): void;
}

/**
 * A Recorder whose analyser returns the 2048 samples of `signal` that end at the current clock time (zeros before
 * the start and after the end). stop() returns the signal up to the stop time.
 */
export function fakeRecorder(signal: Float32Array, sampleRate: number, opts: { startError?: Error; fftSize?: number } = {}): FakeRecorderControl {
  const fftSize = opts.fftSize ?? 2048;
  let base = 0;
  let live = false;
  const clock = () => (Date.now() - base) / 1000;
  const context = {
    sampleRate,
    get currentTime() {
      return clock();
    },
  };
  const analyser = {
    fftSize,
    context,
    getFloatTimeDomainData(buf: Float32Array) {
      const end = Math.round(clock() * sampleRate);
      for (let i = 0; i < buf.length; i++) {
        const k = end - buf.length + i;
        buf[i] = k >= 0 && k < signal.length ? signal[k] : 0;
      }
    },
  } as unknown as AnalyserNode;
  const handlers: { fn: ((r: InterruptionReason) => void) | null } = { fn: null };
  let interrupted: InterruptionReason | null = null;
  const control: FakeRecorderControl = {
    started: false,
    stopped: false,
    cancelled: false,
    interrupt(reason) {
      interrupted ??= reason;
      handlers.fn?.(reason);
    },
    recorder: {
      async start() {
        if (opts.startError) throw opts.startError;
        base = Date.now();
        live = true;
        control.started = true;
      },
      async stop() {
        const n = Math.min(signal.length, Math.round(clock() * sampleRate));
        live = false;
        control.stopped = true;
        return { samples: signal.slice(0, n), sampleRate, interrupted };
      },
      cancel() {
        live = false;
        control.cancelled = true;
      },
      get analyser() {
        return live ? analyser : null;
      },
      get capturedSec() {
        return clock();
      },
      get onInterruption() {
        return handlers.fn;
      },
      set onInterruption(fn: ((r: InterruptionReason) => void) | null | undefined) {
        handlers.fn = fn ?? null;
      },
    },
  };
  return control;
}
