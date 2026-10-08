import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '../dsp/stretchClient';
import { runRenderJob, type RenderRequest, type RenderResponse } from '../dsp/stretchProtocol';
import { installFakeAudio, type FakeAudio, type FakeAudioBuffer, type FakeAudioContext } from '../testing/fakeAudio';
import {
  attemptBuffer,
  attemptStartForBoth,
  bufferFromSamples,
  clearPlaybackCache,
  createPhrasePlayer,
  hearBothBuffer,
  peakNormalize,
  PlaybackCache,
  playbackCacheStats,
  preparePlayback,
  sideBySide,
  type PreparedPlayback,
} from './player';

let env: FakeAudio | null = null;
afterEach(() => {
  env?.restore();
  env = null;
  clearPlaybackCache();
  vi.useRealTimers();
});

function newCtx(options: Parameters<typeof installFakeAudio>[0] = {}): { ctx: AudioContext; fake: FakeAudioContext; env: FakeAudio } {
  env = installFakeAudio({ startSuspended: false, ...options });
  const ctx = new AudioContext();
  return { ctx, fake: ctx as unknown as FakeAudioContext, env };
}

const tone = (sec: number, sr: number, hz = 330, amp = 0.4): Float32Array => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
const peak = (x: Float32Array): number => {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
};
const energy = (x: Float32Array): number => {
  let e = 0;
  for (const v of x) e += v * v;
  return e;
};

/** A render worker double that answers like the real one, a tick later. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = 0;
  requests: RenderRequest[] = [];
  static created: FakeWorker[] = [];
  constructor() {
    FakeWorker.created.push(this);
    setTimeout(() => this.emit({ type: 'alive' }), 0);
  }
  private emit(m: RenderResponse): void {
    if (!this.terminated) this.onmessage?.({ data: m } as MessageEvent<RenderResponse>);
  }
  postMessage(message: RenderRequest): void {
    this.requests.push(message);
    setTimeout(() => runRenderJob(message, (m) => this.emit(m)), 10);
  }
  terminate(): void {
    this.terminated++;
  }
}
const withFakeWorker = { createWorker: () => new FakeWorker() };

describe('PlaybackCache', () => {
  const entry = (n: number): PreparedPlayback => ({ buffer: { length: n, numberOfChannels: 1 } as unknown as AudioBuffer, rate: 1, semitones: 0 });

  it('drops the least recently used entry past the count limit, and a read counts as use', () => {
    const c = new PlaybackCache({ maxEntries: 2, maxBytes: 1e9 });
    c.set('a', entry(10));
    c.set('b', entry(10));
    expect(c.get('a')).toBeDefined();
    c.set('c', entry(10));
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
    expect(c.get('c')).toBeDefined();
    expect(c.size).toBe(2);
  });

  it('drops old entries past the byte limit but always keeps the newest one', () => {
    const c = new PlaybackCache({ maxEntries: 10, maxBytes: 100 });
    c.set('a', entry(15)); // 60 bytes
    c.set('b', entry(15));
    expect(c.size).toBe(1);
    expect(c.get('b')).toBeDefined();
    c.set('huge', entry(1000));
    expect(c.size).toBe(1);
    expect(c.get('huge')).toBeDefined();
    expect(c.bytes).toBe(4000);
    c.clear();
    expect(c.size).toBe(0);
  });

  it('setting a key again replaces it', () => {
    const c = new PlaybackCache();
    c.set('a', entry(1));
    const e2 = entry(2);
    c.set('a', e2);
    expect(c.size).toBe(1);
    expect(c.get('a')).toBe(e2);
  });
});

describe('pure helpers', () => {
  it('peakNormalize scales to the target, leaves silence alone and zeroes NaN without touching the input', () => {
    const x = Float32Array.from([0.1, -0.2, NaN, 0.05]);
    const y = peakNormalize(x, 0.8);
    expect(peak(y)).toBeCloseTo(0.8, 5);
    expect(y[2]).toBe(0);
    expect(Number.isNaN(x[2])).toBe(true);
    expect(peakNormalize(new Float32Array(10))).toEqual(new Float32Array(10));
    expect(peakNormalize(new Float32Array(0)).length).toBe(0);
  });

  it('sideBySide puts the guide left and the attempt right, lined up by the attempt start', () => {
    const guide = Float32Array.from([1, 2, 3, 4]);
    const attempt = Float32Array.from([0, 0, 9, 8, 7, 6, 5]);
    const { left, right } = sideBySide(guide, attempt, 10, 0.2); // guide time 0 is attempt sample 2
    expect(Array.from(left)).toEqual([1, 2, 3, 4, 0]);
    expect(Array.from(right)).toEqual([9, 8, 7, 6, 5]);
  });

  it('sideBySide pads the right ear when the singer came in before the guide, and ignores a non-finite offset', () => {
    const { left, right } = sideBySide(Float32Array.from([1, 1, 1]), Float32Array.from([5, 5]), 10, -0.2);
    expect(Array.from(left)).toEqual([1, 1, 1, 0, 0].slice(0, left.length));
    expect(Array.from(right)).toEqual([0, 0, 5, 5].slice(0, right.length));
    const same = sideBySide(Float32Array.from([1, 2]), Float32Array.from([3, 4]), 10, NaN);
    expect(Array.from(same.right)).toEqual([3, 4]);
    expect(() => sideBySide(guide0(), guide0(), 0, 0)).toThrow(RangeError);
  });

  it('bufferFromSamples copies, and refuses nothing with a message that names the next step', () => {
    const { ctx } = newCtx();
    const x = tone(0.1, 48000);
    const b = bufferFromSamples(ctx, x, 48000);
    expect(b.length).toBe(x.length);
    x[0] = 123;
    expect(b.getChannelData(0)[0]).not.toBe(123);
    expect(() => bufferFromSamples(ctx, new Float32Array(0), 48000)).toThrow(/Add the clip file again/);
    expect(() => bufferFromSamples(ctx, x, 0)).toThrow(/no audio/);
  });

  it('hearBothBuffer is stereo with both ears at the same level, and insists on one sample rate', () => {
    const { ctx } = newCtx();
    const guide: PreparedPlayback = { buffer: bufferFromSamples(ctx, tone(0.5, 48000, 220, 0.2), 48000), rate: 0.75, semitones: 0 };
    const attempt = { samples: tone(0.6, 48000, 330, 0.7), sampleRate: 48000 };
    const both = hearBothBuffer(ctx, guide, attempt, 0.05);
    expect(both.numberOfChannels).toBe(2);
    const l = both.getChannelData(0);
    const r = both.getChannelData(1);
    expect(peak(l)).toBeCloseTo(0.8, 2);
    expect(peak(r)).toBeCloseTo(0.8, 2);
    expect(both.length).toBe(Math.max(guide.buffer.length, attempt.samples.length - 2400));
    expect(() => hearBothBuffer(ctx, guide, { samples: tone(0.1, 44100), sampleRate: 44100 }, 0)).toThrow(RangeError);
    expect(() => hearBothBuffer(ctx, { ...guide, buffer: { ...guide.buffer, getChannelData: () => new Float32Array(0), sampleRate: 48000 } as unknown as AudioBuffer }, { samples: new Float32Array(0), sampleRate: 48000 }, 0)).toThrow(/no audio/);
  });
});

function guide0(): Float32Array {
  return new Float32Array(2);
}

describe('attempt helpers', () => {
  it('attemptBuffer is a normalised copy at the attempt rate', () => {
    const { ctx } = newCtx();
    const x = tone(0.2, 48000, 300, 0.05);
    const b = attemptBuffer(ctx, { samples: x, sampleRate: 48000 });
    expect(b.sampleRate).toBe(48000);
    expect(peak(b.getChannelData(0))).toBeCloseTo(0.9, 3);
    expect(peak(x)).toBeCloseTo(0.05, 3);
  });

  it('attemptStartForBoth: sing-along uses the schedule plus the sync offset', () => {
    expect(attemptStartForBoth({ mode: 'sing-along', refStartInCaptureSec: 2.25, syncOffsetMs: 180, matchedStartSec: 2.7, refFirstNoteSec: 0.15, rate: 1 })).toBeCloseTo(2.43, 6);
    expect(attemptStartForBoth({ mode: 'sing-along', refStartInCaptureSec: 2.25, syncOffsetMs: null, matchedStartSec: null, refFirstNoteSec: 0, rate: 1 })).toBe(2.25);
  });

  it('attemptStartForBoth: turn-taking lines up the first notes, scaled by the speed the guide played at', () => {
    expect(attemptStartForBoth({ mode: 'turn-taking', refStartInCaptureSec: null, syncOffsetMs: null, matchedStartSec: 3, refFirstNoteSec: 0.15, rate: 0.75 })).toBeCloseTo(2.8, 6);
    expect(attemptStartForBoth({ mode: 'turn-taking', refStartInCaptureSec: null, syncOffsetMs: null, matchedStartSec: null, refFirstNoteSec: 0.15, rate: 1 })).toBe(0);
    // A sing-along take that has no schedule (an interrupted clock) falls back to the first-note rule.
    expect(attemptStartForBoth({ mode: 'sing-along', refStartInCaptureSec: null, syncOffsetMs: 100, matchedStartSec: 2, refFirstNoteSec: 0.5, rate: 1 })).toBeCloseTo(1.5, 6);
    expect(attemptStartForBoth({ mode: 'turn-taking', refStartInCaptureSec: null, syncOffsetMs: null, matchedStartSec: 1, refFirstNoteSec: 0, rate: 0 })).toBe(1);
  });
});

describe('preparePlayback', () => {
  const audioAt = (sr: number, sec = 1) => ({ samples: tone(sec, sr), sampleRate: sr, startSec: 0 });

  it('full speed in the original key at the context rate is a plain copy, cached, with no render', async () => {
    const { ctx } = newCtx();
    const audio = audioAt(48000);
    const make = vi.fn(() => new FakeWorker());
    const a = await preparePlayback(ctx, audio, 1, 0, { render: { createWorker: make } });
    expect(make).not.toHaveBeenCalled();
    expect(a).toMatchObject({ rate: 1, semitones: 0 });
    expect(a.buffer.sampleRate).toBe(48000);
    expect(a.buffer.getChannelData(0)).toEqual(audio.samples);
    const b = await preparePlayback(ctx, audio, 1, 0);
    expect(b).toBe(a);
    expect(playbackCacheStats().entries).toBe(1);
  });

  it('slowing renders in the worker at the context rate, and the second ask comes from the cache', async () => {
    vi.useFakeTimers();
    FakeWorker.created = [];
    const { ctx } = newCtx();
    const audio = audioAt(22050, 1);
    const p = preparePlayback(ctx, audio, 0.75, 0, { render: withFakeWorker });
    await vi.advanceTimersByTimeAsync(50);
    const a = await p;
    expect(a.rate).toBe(0.75);
    expect(a.buffer.sampleRate).toBe(48000);
    expect(Math.abs(a.buffer.duration - 1 / 0.75)).toBeLessThan(0.02);
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0].terminated).toBe(1);
    const b = await preparePlayback(ctx, audio, 0.75, 0, { render: withFakeWorker });
    expect(b).toBe(a);
    expect(FakeWorker.created).toHaveLength(1);
    // Another rate or key is another entry; rounding makes 0.7500001 the same one.
    expect(await preparePlayback(ctx, audio, 0.7500001, 0.001, { render: withFakeWorker })).toBe(a);
  });

  it('forwards render progress', async () => {
    vi.useFakeTimers();
    FakeWorker.created = [];
    const { ctx } = newCtx();
    const seen: number[] = [];
    const p = preparePlayback(ctx, audioAt(22050, 2), 0.6, 2, { render: withFakeWorker, onProgress: (v) => seen.push(v) });
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(seen.at(-1)).toBe(1);
  });

  it('without a worker the render happens here, still at the context rate', async () => {
    const { ctx } = newCtx();
    const audio = audioAt(22050, 1);
    const out = await preparePlayback(ctx, audio, 0.9, 0, { render: { forceMainThread: true }, cache: false });
    expect(out.buffer.sampleRate).toBe(48000);
    expect(Math.abs(out.buffer.duration - 1 / 0.9)).toBeLessThan(0.02);
    const keyed = await preparePlayback(ctx, audio, 1, -3, { render: { forceMainThread: true }, cache: false });
    expect(keyed.buffer.sampleRate).toBe(48000);
    expect(Math.abs(keyed.buffer.duration - 1)).toBeLessThan(0.02);
  });

  it('shares one render between two asks for the same thing', async () => {
    vi.useFakeTimers();
    FakeWorker.created = [];
    const { ctx } = newCtx();
    const audio = audioAt(22050, 1);
    const a = preparePlayback(ctx, audio, 0.6, 0, { render: withFakeWorker });
    const b = preparePlayback(ctx, audio, 0.6, 0, { render: withFakeWorker });
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).toBe(await b);
    expect(FakeWorker.created).toHaveLength(1);
  });

  it('an abort rejects only that caller; the render goes on for the other and stops when nobody is left', async () => {
    vi.useFakeTimers();
    FakeWorker.created = [];
    const { ctx } = newCtx();
    const audio = audioAt(22050, 1);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = preparePlayback(ctx, audio, 0.6, 0, { render: withFakeWorker, signal: c1.signal }).catch((e: unknown) => e);
    const b = preparePlayback(ctx, audio, 0.6, 0, { render: withFakeWorker, signal: c2.signal });
    await vi.advanceTimersByTimeAsync(1);
    c1.abort();
    expect(await a).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    expect((await b).rate).toBe(0.6);

    // Everyone gives up: the worker is terminated and nothing is cached.
    clearPlaybackCache();
    const c3 = new AbortController();
    const d = preparePlayback(ctx, audio, 0.5, 0, { render: withFakeWorker, signal: c3.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1);
    c3.abort();
    expect(await d).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeWorker.created.at(-1)?.terminated).toBe(1);
    expect(playbackCacheStats().entries).toBe(0);
  });

  it('a signal that is already aborted never starts a render', async () => {
    const { ctx } = newCtx();
    const make = vi.fn(() => new FakeWorker());
    const c = new AbortController();
    c.abort();
    await expect(preparePlayback(ctx, audioAt(22050), 0.75, 0, { render: { createWorker: make }, signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(make).not.toHaveBeenCalled();
  });

  it('rejects silly input with a message, not a crash', async () => {
    const { ctx } = newCtx();
    await expect(preparePlayback(ctx, { samples: new Float32Array(0), sampleRate: 44100, startSec: 0 }, 1, 0)).rejects.toThrow(/Add the clip file again/);
    await expect(preparePlayback(ctx, audioAt(22050), 0, 0)).rejects.toThrow(RangeError);
    await expect(preparePlayback(ctx, audioAt(22050), NaN, 0)).rejects.toThrow(RangeError);
    await expect(preparePlayback(ctx, audioAt(22050), 1, 99)).rejects.toThrow(RangeError);
  });

  it('a render error rejects and is not cached', async () => {
    const { ctx } = newCtx();
    const err = new FakeWorker();
    err.postMessage = (m: RenderRequest) => {
      setTimeout(() => err.onmessage?.({ data: { type: 'error', id: m.id, message: 'The guide could not be rendered: no' } } as MessageEvent<RenderResponse>), 1);
    };
    vi.useFakeTimers();
    const p = preparePlayback(ctx, audioAt(22050), 0.75, 0, { render: { createWorker: () => err } }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(((await p) as Error).message).toMatch(/could not be rendered/);
    expect(playbackCacheStats().entries).toBe(0);
  });
});

describe('createPhrasePlayer', () => {
  function setup(rate = 1, seconds = 2) {
    const { ctx, fake, env } = newCtx();
    const buffer = bufferFromSamples(ctx, tone(seconds, 48000, 440, 0.5), 48000);
    const player = createPhrasePlayer(ctx, { buffer, rate, semitones: 0 });
    return { ctx, fake, env, buffer, player };
  }
  const run = (e: FakeAudio, sec: number): void => e.advance(sec);

  it('plays the phrase once, moves the playhead, ends once and reports NaN afterwards', () => {
    const { env, player, fake } = setup(1, 1);
    const onEnded = vi.fn();
    expect(Number.isNaN(player.position())).toBe(true);
    player.play({ onEnded });
    run(env, 0.5);
    const p = player.position();
    expect(p).toBeGreaterThan(0.2);
    expect(p).toBeLessThan(0.55);
    run(env, 1);
    expect(onEnded).not.toHaveBeenCalled(); // onended is delivered on a later tick
    return Promise.resolve().then(() => {
      expect(onEnded).toHaveBeenCalledTimes(1);
      expect(Number.isNaN(player.position())).toBe(true);
      expect(energy(fake.renderedChannel('l'))).toBeGreaterThan(100);
    });
  });

  it('reports phrase seconds for a slowed buffer: the buffer is longer, the phrase is not', () => {
    const { env, player, buffer } = setup(0.5, 2); // 2 s of audio rendered at 50 %: a 1 s phrase
    expect(player.durationSec).toBeCloseTo(buffer.duration * 0.5, 6);
    expect(player.durationSec).toBeCloseTo(1, 6);
    player.play({});
    run(env, 1); // one real second is half a phrase second
    expect(player.position()).toBeGreaterThan(0.35);
    expect(player.position()).toBeLessThan(0.52);
  });

  it('from and to are phrase seconds: a 0.2 s phrase range of a 50 % buffer sounds for 0.4 s', async () => {
    const { env, player, fake } = setup(0.5, 2);
    const onEnded = vi.fn();
    player.play({ from: 0.3, to: 0.5, onEnded });
    run(env, 1);
    await Promise.resolve();
    expect(onEnded).toHaveBeenCalledTimes(1);
    const out = fake.renderedChannel('l');
    let first = -1;
    let last = -1;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]) > 0.01) {
        if (first < 0) first = i;
        last = i;
      }
    }
    expect((last - first) / 48000).toBeCloseTo(0.4, 1);
  });

  it('loops inside the range with the position staying in it, until stopped', async () => {
    const { env, player } = setup(1, 2);
    const onEnded = vi.fn();
    player.play({ from: 0.5, to: 1, loop: true, onEnded });
    for (let i = 0; i < 12; i++) {
      run(env, 0.17);
      const p = player.position();
      expect(p).toBeGreaterThanOrEqual(0.5);
      expect(p).toBeLessThan(1);
    }
    expect(onEnded).not.toHaveBeenCalled();
    player.stop();
    player.stop();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(Number.isNaN(player.position())).toBe(true);
  });

  it('a second play replaces the first (its onEnded fires once) and stop is idempotent', () => {
    const { player } = setup();
    const a = vi.fn();
    const b = vi.fn();
    player.play({ onEnded: a });
    player.play({ onEnded: b });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    player.stop();
    player.stop();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('pan puts a mono phrase in one ear; centre and stereo buffers play as they are', () => {
    for (const [pan, expectL, expectR] of [[-1, true, false], [1, false, true], [0, true, true]] as const) {
      const { env, player, fake } = setup(1, 0.5);
      player.play({ pan });
      run(env, 0.7);
      expect(energy(fake.renderedChannel('l')) > 1).toBe(expectL);
      expect(energy(fake.renderedChannel('r')) > 1).toBe(expectR);
      env.restore();
    }
    const { ctx, env, fake } = newCtx();
    const stereo = ctx.createBuffer(2, 24000, 48000);
    stereo.getChannelData(0).set(tone(0.5, 48000, 220, 0.5));
    const sp = createPhrasePlayer(ctx, stereo);
    sp.play({ pan: 1 }); // ignored: a stereo buffer already says which ear is which
    env.advance(0.7);
    expect(energy(fake.renderedChannel('l'))).toBeGreaterThan(1);
    expect(energy(fake.renderedChannel('r'))).toBeLessThan(1e-6);
  });

  it('works without a panner node by using a channel merger', () => {
    const { ctx, env, fake } = newCtx();
    (ctx as unknown as { createStereoPanner?: unknown }).createStereoPanner = undefined;
    const p = createPhrasePlayer(ctx, bufferFromSamples(ctx, tone(0.5, 48000), 48000));
    p.play({ pan: -1 });
    env.advance(0.7);
    expect(energy(fake.renderedChannel('l'))).toBeGreaterThan(1);
    expect(energy(fake.renderedChannel('r'))).toBeLessThan(1e-6);
  });

  it('gain scales the level and is clamped', () => {
    const levels: number[] = [];
    for (const gain of [0.5, 1, 50]) {
      const { env, player, fake } = setup(1, 0.5);
      player.play({ gain });
      run(env, 0.7);
      levels.push(peak(fake.renderedChannel('l')));
      env.restore();
    }
    expect(levels[1] / levels[0]).toBeCloseTo(2, 1);
    expect(levels[2] / levels[1]).toBeCloseTo(2, 1); // clamped at 2
  });

  it('disconnects its nodes when stopped and does nothing after dispose', async () => {
    const { player, fake } = setup();
    const onEnded = vi.fn();
    player.play({ onEnded });
    const nodes = fake.nodes.length;
    expect(nodes).toBeGreaterThan(1);
    player.dispose();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(fake.nodes.every((n) => n.connections.length === 0)).toBe(true);
    player.play({ onEnded });
    player.dispose();
    expect(fake.nodes.length).toBe(nodes);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('never throws on a closed context: it reports the end so the screen does not wait', async () => {
    const { ctx, fake, player } = setup();
    await fake.close();
    fake.createBufferSource = () => {
      throw new DOMException('closed', 'InvalidStateError');
    };
    const onEnded = vi.fn();
    expect(() => player.play({ onEnded })).not.toThrow();
    await Promise.resolve();
    expect(onEnded).toHaveBeenCalledTimes(1);
    void ctx;
  });

  it('accepts a plain AudioBuffer with an explicit rate', () => {
    const { ctx } = newCtx();
    const buf = bufferFromSamples(ctx, tone(2, 48000), 48000);
    expect(createPhrasePlayer(ctx, buf).durationSec).toBeCloseTo(2, 6);
    expect(createPhrasePlayer(ctx, buf, { rate: 0.6 }).durationSec).toBeCloseTo(1.2, 6);
  });

  it('plays the phrase from the start again after it ended', async () => {
    const { env, player } = setup(1, 0.3);
    const a = vi.fn();
    player.play({ onEnded: a });
    run(env, 0.5);
    await Promise.resolve();
    expect(a).toHaveBeenCalledTimes(1);
    player.play({});
    run(env, 0.1);
    expect(player.position()).toBeGreaterThan(0.03);
  });
});

void (null as unknown as FakeAudioBuffer);
