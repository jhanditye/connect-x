import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeAudio, runFor, type FakeAudio, type FakeAudioContext, type FakeAudioOptions } from '../testing/fakeAudio';
import { probeClicks } from '../trainer/latency';
import { classifyRoute, createDuplexSession, MAX_DROPPED_SEC, PRE_ROLL_SEC, takeIsUsable, type DuplexSession, type InterruptReason, type TakeOptions, type TakeResult } from './duplex';
import { RecorderError } from './recorder';

let env: FakeAudio;
const sessions: DuplexSession[] = [];

function setup(options: FakeAudioOptions = {}, hooks: Parameters<typeof createDuplexSession>[0] = {}): { env: FakeAudio; s: DuplexSession } {
  env = installFakeAudio(options);
  const s = createDuplexSession(hooks);
  sessions.push(s);
  return { env, s };
}

const tick = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);
const run = (sec: number): Promise<void> => runFor(env, sec, tick);
const ctxOf = (s: DuplexSession): FakeAudioContext => s.context as unknown as FakeAudioContext;

/** A guide buffer of `dur` seconds with 1 kHz bursts of 0.1 s at the given offsets. */
function guide(s: DuplexSession, dur: number, bursts: number[] = [0.4]): AudioBuffer {
  const c = s.context;
  const buf = c.createBuffer(1, Math.round(dur * c.sampleRate), c.sampleRate);
  const d = buf.getChannelData(0);
  for (const t0 of bursts) for (let i = 0; i < 0.1 * c.sampleRate; i++) d[Math.round(t0 * c.sampleRate) + i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / c.sampleRate);
  return buf;
}

const TAKE: TakeOptions = { mode: 'sing-along', countInBeats: 3, bpm: 100, tailSec: 0.5, gain: 1 };

/** Start times (s) of loud stretches in x: where the envelope crosses `thr` after being below `low`. */
function onsets(x: Float32Array, sr: number, thr = 0.03, low = 0.005): number[] {
  const w = Math.round(0.002 * sr);
  const out: number[] = [];
  let armed = true;
  for (let i = 0; i + w <= x.length; i += w) {
    let e = 0;
    for (let k = 0; k < w; k++) e += x[i + k] * x[i + k];
    const v = Math.sqrt(e / w);
    if (v > thr && armed) {
      out.push(i / sr);
      armed = false;
    }
    if (v < low) armed = true;
  }
  return out;
}

async function take(s: DuplexSession, buf: AudioBuffer, opts: Partial<TakeOptions> = {}, extra?: { stopAfter?: number }): Promise<TakeResult> {
  const t = s.runTake(buf, { ...TAKE, ...opts });
  if (extra?.stopAfter !== undefined) {
    await run(extra.stopAfter);
    t.stop();
  }
  let result: TakeResult | null = null;
  void t.done.then((r) => (result = r));
  for (let i = 0; i < 4000 && !result; i++) await run(0.05);
  if (!result) throw new Error('the take never finished');
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  env?.restore();
  vi.useRealTimers();
});

describe('classifyRoute', () => {
  it('reads iPhone, wired and Bluetooth labels', () => {
    expect(classifyRoute('iPhone Microphone')).toBe('builtin');
    expect(classifyRoute("Raj's AirPods Pro")).toBe('bluetooth');
    expect(classifyRoute('Headset Microphone')).toBe('wired');
    expect(classifyRoute('')).toBe('unknown');
  });
});

describe('prepare', () => {
  it('listen-only: playback session, one context, no microphone, a route for the screen', async () => {
    const { env, s } = setup();
    const route = await s.prepare({ mic: false });
    expect(env.sessionTypes[0]).toBe('playback');
    expect(env.contexts).toHaveLength(1);
    expect(ctxOf(s).state).toBe('running');
    expect(env.getUserMediaCalls).toHaveLength(0);
    expect(route).toMatchObject({ kind: 'builtin', headphonesLikely: false, sampleRate: 48000, inputLabel: 'iPhone Microphone' });
    expect(s.analyser).toBeNull();
  });

  it('with the microphone: play-and-record before the permission prompt, raw mono constraints, worklet stamped capture', async () => {
    const { env, s } = setup();
    const route = await s.prepare({ mic: true });
    expect(env.sessionTypes[0]).toBe('play-and-record');
    expect(env.getUserMediaCalls[0]).toEqual({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    expect(route.inputLabel).toBe('iPhone Microphone');
    expect(route.inputSampleRate).toBe(48000);
    expect(s.analyser).not.toBeNull();
    expect(s.route).toEqual(route);
    expect(env.liveObjectUrls.size).toBe(0); // the worklet Blob URL is revoked once the module is loaded
  });

  it('listen first, microphone on the first Sing tap: same context, session type switched', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: false });
    await s.prepare({ mic: true });
    expect(env.contexts).toHaveLength(1);
    expect(env.sessionTypes).toEqual(['playback', 'play-and-record', 'play-and-record']);
    expect(env.getUserMediaCalls).toHaveLength(1);
    await s.prepare({ mic: true });
    expect(env.getUserMediaCalls).toHaveLength(1); // already open: no second prompt
  });

  it('a microphone that died while idle is opened again by the next prepare', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    env.endMic();
    expect(env.streams).toHaveLength(1);
    await s.prepare({ mic: true });
    expect(env.streams).toHaveLength(2);
    expect(env.streams[1].getTracks()[0].readyState).toBe('live');
    const r = await take(s, guide(s, 1));
    expect(r.endedBy).toBe('finished');
    expect(r.samples.length).toBeGreaterThan(48000 * 3);
  });

  it('two prepares at once open the microphone once', async () => {
    const { env, s } = setup();
    const [a, b] = await Promise.all([s.prepare({ mic: true }), s.prepare({ mic: true })]);
    expect(env.getUserMediaCalls).toHaveLength(1);
    expect(a.inputLabel).toBe(b.inputLabel);
  });

  it('a chosen microphone is asked for by exact id; switching stops the old stream', async () => {
    const { env, s } = setup({
      devices: [
        { deviceId: 'iphone-mic', label: 'iPhone Microphone', kind: 'audioinput', groupId: 'a' },
        { deviceId: 'pods', label: 'AirPods Pro', kind: 'audioinput', groupId: 'b' },
      ],
    });
    await s.prepare({ mic: true, deviceId: 'iphone-mic' });
    expect(env.getUserMediaCalls[0].audio).toMatchObject({ deviceId: { exact: 'iphone-mic' } });
    const route = await s.prepare({ mic: true, deviceId: 'pods' });
    expect(route.kind).toBe('bluetooth');
    expect(route.headphonesLikely).toBe(true);
    expect(env.streams).toHaveLength(2);
    expect(env.streams[0].getTracks()[0].readyState).toBe('ended');
    expect(env.streams[1].getTracks()[0].readyState).toBe('live');
  });

  it('a microphone that is no longer there falls back to the default one', async () => {
    const { env, s } = setup();
    const route = await s.prepare({ mic: true, deviceId: 'gone' });
    expect(env.getUserMediaCalls).toHaveLength(2);
    expect(route.inputLabel).toBe('iPhone Microphone');
  });

  it('denied, missing and busy microphones reject with a RecorderError, leave nothing open and keep listening usable', async () => {
    for (const [name, kind] of [
      ['NotAllowedError', 'denied'],
      ['NotFoundError', 'no-device'],
      ['NotReadableError', 'no-device'],
    ] as const) {
      const { env, s } = setup({ micError: name });
      const err = await s.prepare({ mic: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RecorderError);
      expect((err as RecorderError).kind).toBe(kind);
      expect((err as RecorderError).message.length).toBeGreaterThan(20);
      expect(s.analyser).toBeNull();
      // The guide can still be played without the microphone.
      await s.prepare({ mic: false });
      const c = ctxOf(s);
      const handle = s.listen(guide(s, 1), {});
      handle.stop();
      await s.close();
      expect(c.state).toBe('closed');
      env.restore();
      sessions.length = 0;
    }
  });

  it('an unsupported or insecure page says so', async () => {
    const { env, s } = setup();
    Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true, writable: true });
    const err = await s.prepare({ mic: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).message).toMatch(/secure/);
    expect(env.getUserMediaCalls).toHaveLength(0);
  });

  it('a browser with no Web Audio rejects with an unsupported error', async () => {
    const { s } = setup();
    Object.defineProperty(globalThis, 'AudioContext', { value: undefined, configurable: true, writable: true });
    const err = await s.prepare({ mic: false }).catch((e: unknown) => e);
    expect((err as RecorderError).kind).toBe('unsupported');
  });

  it('does not wait for ever on a resume() that never settles', async () => {
    const { s } = setup({ resumeNeverSettles: true });
    let route: unknown = null;
    void s.prepare({ mic: false }).then((r) => (route = r));
    await tick(1700);
    expect(route).not.toBeNull();
  });

  it('works when the browser has no navigator.audioSession', async () => {
    const { env, s } = setup({ audioSession: false });
    await s.prepare({ mic: true });
    expect(env.sessionTypes).toEqual([]);
    await s.close();
  });

  it('labels hidden before permission are reported as such', async () => {
    const { s } = setup({ devices: [{ deviceId: 'x', label: '', kind: 'audioinput' }] });
    const route = await s.prepare({ mic: false });
    expect(route.labelsHidden).toBe(true);
    expect(route.kind).toBe('unknown');
  });

  it('the AudioWorklet being blocked falls back to counting frames: the take records, the clock is marked approximate', async () => {
    const { env, s } = setup({ workletFails: true });
    await s.prepare({ mic: true });
    expect(env.liveObjectUrls.size).toBe(0);
    const r = await take(s, guide(s, 1.5));
    expect(r.clockExact).toBe(false);
    expect(r.samples.length).toBeGreaterThan(48000 * 3);
    expect(r.droppedFrames).toBe(0);
    expect(r.clickTimesInCaptureSec).toHaveLength(3);
  });

  it('a browser with no AudioWorklet at all uses the same fallback', async () => {
    const { s } = setup({ worklet: false });
    await s.prepare({ mic: true });
    const r = await take(s, guide(s, 1));
    expect(r.clockExact).toBe(false);
    expect(r.samples.length).toBeGreaterThan(48000 * 2.5);
  });
});

describe('runTake: the stamped clock', () => {
  it('puts the clicks and the guide where the schedule says, through a 110 ms loopback', async () => {
    const { env, s } = setup({ latencySec: 0.11, leak: 0.3 });
    await s.prepare({ mic: true });
    await run(1.2); // the microphone has been open for a while: older audio must not leak into the take
    const buf = guide(s, 2, [0.5, 1.2]);
    const r = await take(s, buf);
    expect([r.endedBy, r.interruptedBy]).toEqual(['finished', null]);
    expect(r.droppedFrames).toBe(0);
    expect(r.clockExact).toBe(true);
    const sr = r.sampleRate;
    expect(sr).toBe(48000);
    // 450 ms of room tone, then three clicks 0.6 s apart (100 bpm), then the guide.
    expect(r.clickTimesInCaptureSec.map((t) => +t.toFixed(4))).toEqual([PRE_ROLL_SEC, PRE_ROLL_SEC + 0.6, PRE_ROLL_SEC + 1.2]);
    expect(r.refStartInCaptureSec).toBeCloseTo(PRE_ROLL_SEC + 1.8, 4);
    expect(r.guideEndInCaptureSec).toBeCloseTo(PRE_ROLL_SEC + 1.8 + 2, 4);
    // The take starts at the take: nothing from the idle second before it, and it ends tail seconds after the guide.
    expect(r.samples.length / sr).toBeGreaterThan(PRE_ROLL_SEC + 1.8 + 2);
    expect(r.samples.length / sr).toBeLessThan(PRE_ROLL_SEC + 1.8 + 2 + 0.5 + 0.2);
    // Find the guide's bursts and the clicks in the recording (a speaker leak at 0.3).
    const found = onsets(r.samples, sr, 0.03, 0.01);
    const expectGuide = [r.refStartInCaptureSec! + 0.5 + 0.11, r.refStartInCaptureSec! + 1.2 + 0.11];
    for (const want of expectGuide) expect(found.some((t) => Math.abs(t - want) < 0.006)).toBe(true);
    // The probe reads the 110 ms round trip off the clicks and sees the bleed.
    const probe = probeClicks(r.samples, sr, r.clickTimesInCaptureSec);
    expect(probe.bleed).toBe(true);
    expect(Math.abs((probe.roundTripMs ?? 999) - 110)).toBeLessThan(5);
    // Nothing is left scheduled or connected once the take is over.
    await run(0.2);
    expect(ctxOf(s).sources.size).toBe(0);
    const oscillators = ctxOf(s).nodes.filter((n) => n.constructor.name === 'FakeOscillator');
    expect(oscillators).toHaveLength(3);
    expect(oscillators.every((n) => n.connections.length === 0)).toBe(true);
    void env;
  });

  it('sealed headphones: no click in the microphone, no bleed', async () => {
    const { s } = setup({ latencySec: 0.06, leak: 0 });
    await s.prepare({ mic: true });
    const r = await take(s, guide(s, 1.5));
    const probe = probeClicks(r.samples, r.sampleRate, r.clickTimesInCaptureSec);
    expect(probe.bleed).toBe(false);
  });

  it('records the singer: a voice at a known time lands at the matching offset', async () => {
    const voiceStart = 3.9; // seconds on the context clock
    const { s } = setup({
      voice: (frame, n, sr) => {
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const t = (frame + i) / sr;
          if (t >= voiceStart && t < voiceStart + 0.3) out[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t);
        }
        return out;
      },
    });
    await s.prepare({ mic: true });
    await run(0.5);
    const startedAt = ctxOf(s).currentTime;
    const r = await take(s, guide(s, 2));
    const found = onsets(r.samples, r.sampleRate, 0.05, 0.01);
    expect(found).toHaveLength(1);
    expect(found[0]).toBeCloseTo(voiceStart - startedAt, 2);
  });

  it('turn-taking has no schedule for the guide but says where it ends; the turn lasts the guide plus 1.5 s', async () => {
    const { s } = setup();
    await s.prepare({ mic: true });
    const r = await take(s, guide(s, 1.5), { mode: 'turn-taking', countInBeats: 2 });
    expect(r.refStartInCaptureSec).toBeNull();
    expect(r.guideEndInCaptureSec).toBeCloseTo(PRE_ROLL_SEC + 1.2 + 1.5, 4);
    // The turn defaults to the guide's length plus 1.5 s.
    expect(r.samples.length / r.sampleRate).toBeGreaterThan(PRE_ROLL_SEC + 1.2 + 1.5 + 3);
    expect(r.samples.length / r.sampleRate).toBeLessThan(PRE_ROLL_SEC + 1.2 + 1.5 + 3 + 0.3);
  });

  it('turnSec sets the length of the singer turn', async () => {
    const { s } = setup();
    await s.prepare({ mic: true });
    const r = await take(s, guide(s, 1), { mode: 'turn-taking', countInBeats: 0, turnSec: 4 });
    expect(r.samples.length / r.sampleRate).toBeGreaterThan(PRE_ROLL_SEC + 1 + 4);
    expect(r.clickTimesInCaptureSec).toEqual([]);
  });

  it('the capture gap from an audio-thread glitch is counted and padded, so the clock stays right', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    const t = s.runTake(guide(s, 1), TAKE);
    let result: TakeResult | null = null;
    void t.done.then((r) => (result = r));
    await run(1);
    env.glitch(0.1); // 38 render quanta (4864 frames) are lost
    for (let i = 0; i < 400 && !result; i++) await run(0.05);
    const r = result as TakeResult | null;
    expect(r).not.toBeNull();
    expect(r!.droppedFrames).toBe(38 * 128);
    expect(r!.samples.length / r!.sampleRate).toBeGreaterThan(PRE_ROLL_SEC + 1.8 + 1 + 0.5);
  });

  it('keeps the microphone audio bounded while idle and starts the take clean', async () => {
    const { s } = setup();
    await s.prepare({ mic: true });
    await run(12);
    expect(s.bufferedFrames).toBeLessThan(48000 * 2);
    expect(s.bufferedFrames).toBeGreaterThan(0);
  });

  it('a second take after the first starts clean and with the same timing', async () => {
    const { s } = setup({ latencySec: 0.05, leak: 0.3 });
    await s.prepare({ mic: true });
    const a = await take(s, guide(s, 1));
    const b = await take(s, guide(s, 1));
    expect(b.clickTimesInCaptureSec).toEqual(a.clickTimesInCaptureSec);
    expect(Math.abs(b.samples.length - a.samples.length)).toBeLessThan(48000 * 0.2);
    expect(b.droppedFrames).toBe(0);
  });

  it('refuses a take without a microphone, a second take at once, and listening during a take', async () => {
    const { s } = setup();
    await s.prepare({ mic: false });
    expect(() => s.runTake(guide(s, 1), TAKE)).toThrow(/prepare/);
    await s.prepare({ mic: true });
    const t = s.runTake(guide(s, 1), TAKE);
    expect(() => s.runTake(guide(s, 1), TAKE)).toThrow(/already running/);
    expect(() => s.listen(guide(s, 1), {})).toThrow(/take is running/);
    t.stop();
    await run(0.5);
    await t.done;
    const h = s.listen(guide(s, 1), {});
    h.stop();
  });

  it('an explicit click pattern replaces the beat grid: the guide starts one beat after the last click', async () => {
    const { s } = setup();
    await s.prepare({ mic: true });
    const r = await take(s, guide(s, 0.5), { bpm: 120, clickOffsetsSec: [1.2, 0, NaN, 0.43, -3] });
    // Sorted, non-finite ones dropped, negative ones moved to zero.
    expect(r.clickTimesInCaptureSec.map((t) => +(t - PRE_ROLL_SEC).toFixed(3))).toEqual([0, 0, 0.43, 1.2]);
    expect(r.refStartInCaptureSec).toBeCloseTo(PRE_ROLL_SEC + 1.2 + 0.5, 3);
    const many = await take(s, guide(s, 0.3), { clickOffsetsSec: Array.from({ length: 20 }, (_, i) => i * 0.3) });
    expect(many.clickTimesInCaptureSec).toHaveLength(8);
  });

  it('clamps silly options instead of scheduling nonsense', async () => {
    const { s } = setup();
    await s.prepare({ mic: true });
    const r = await take(s, guide(s, 0.5), { countInBeats: 99, bpm: 5000, gain: 50 });
    expect(r.clickTimesInCaptureSec).toHaveLength(8);
    const beat = 60 / 240;
    expect(r.clickTimesInCaptureSec[1] - r.clickTimesInCaptureSec[0]).toBeCloseTo(beat, 3);
  });
});

describe('takeIsUsable', () => {
  const base = { endedBy: 'finished' as const, samples: new Float32Array(100), sampleRate: 48000, droppedFrames: 0 };
  it('accepts a clean take, a stopped one, and a glitch shorter than 20 ms', () => {
    expect(takeIsUsable(base)).toBe(true);
    expect(takeIsUsable({ ...base, endedBy: 'stopped' })).toBe(true);
    expect(takeIsUsable({ ...base, droppedFrames: 128 })).toBe(true);
    expect(takeIsUsable({ ...base, droppedFrames: MAX_DROPPED_SEC * 48000 })).toBe(true);
  });
  it('refuses interrupted takes, empty takes and long gaps', () => {
    expect(takeIsUsable({ ...base, endedBy: 'interrupted' })).toBe(false);
    expect(takeIsUsable({ ...base, samples: new Float32Array(0) })).toBe(false);
    expect(takeIsUsable({ ...base, droppedFrames: MAX_DROPPED_SEC * 48000 + 1 })).toBe(false);
  });
});

describe('stopping and interruptions', () => {
  it('stop() during the count-in ends the take as stopped and nothing keeps playing', async () => {
    const { env, s } = setup({ latencySec: 0.02, leak: 0.5 });
    await s.prepare({ mic: true });
    const stopAt = ctxOf(s).currentTime + 0.1;
    const r = await take(s, guide(s, 1, [0.1]), {}, { stopAfter: 0.1 });
    expect(r.endedBy).toBe('stopped');
    expect(r.interruptedBy).toBeNull();
    await run(4);
    // After the stop nothing more was rendered: no clicks, no guide.
    const out = ctxOf(s).renderedChannel('l');
    const from = Math.round((stopAt + 0.1) * 48000);
    const rest = out.subarray(from);
    expect(rest.length).toBeGreaterThan(48000);
    let peak = 0;
    for (const v of rest) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBe(0);
    void env;
  });

  it.each<[string, (e: FakeAudio) => void, InterruptReason]>([
    ['the app goes to the background', (e) => e.hidePage(), 'hidden'],
    ['the microphone ends', (e) => e.endMic(), 'mic-ended'],
    ['the microphone is muted (a call)', (e) => e.muteMic(), 'mic-ended'],
    ['the audio session is interrupted', (e) => e.interruptAudio(), 'audio-session'],
    // (navigator.audioSession.state / statechange are off in shipping WebKit: interruptions are read from the AudioContext, as above.)
    ['a headphone is unplugged', (e) => e.changeDevices([{ deviceId: 'x', label: 'iPhone Microphone', kind: 'audioinput' }]), 'device-change'],
  ])('%s: the take ends as interrupted with the reason, once', async (_name, trigger, reason) => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    const seen: InterruptReason[] = [];
    s.onInterrupted((r) => seen.push(r));
    const t = s.runTake(guide(s, 2), TAKE);
    await run(1);
    trigger(env);
    let result: TakeResult | null = null;
    void t.done.then((r) => (result = r));
    for (let i = 0; i < 100 && !result; i++) await run(0.05);
    const r = result as TakeResult | null;
    expect(r?.endedBy).toBe('interrupted');
    expect(r?.interruptedBy).toBe(reason);
    expect(seen).toContain(reason);
    // The session is usable again for the next attempt.
    if (reason === 'audio-session' || reason === 'hidden') env.showPage();
    await s.resume();
    expect(ctxOf(s).state).toBe('running');
  });

  it('a running context that goes silent is not an interruption by itself; the first suspended-to-running change is not either', async () => {
    const { s } = setup();
    const seen: InterruptReason[] = [];
    s.onInterrupted((r) => seen.push(r));
    await s.prepare({ mic: true });
    await run(0.5);
    expect(seen).toEqual([]);
  });

  it('a stalled audio clock (no event, the clock just stops) ends the take', async () => {
    const { s } = setup();
    await s.prepare({ mic: true });
    const t = s.runTake(guide(s, 2), TAKE);
    await run(0.3);
    ctxOf(s).state = 'suspended'; // stops rendering without telling anyone
    let result: TakeResult | null = null;
    void t.done.then((r) => (result = r));
    await tick(2000);
    const r = result as TakeResult | null;
    expect(r?.endedBy).toBe('interrupted');
    expect(r?.interruptedBy).toBe('audio-session');
  });

  it('nothing arriving from the microphone for two seconds ends the take as no-audio', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    env.stallWorklet(true);
    const t = s.runTake(guide(s, 3), TAKE);
    let result: TakeResult | null = null;
    void t.done.then((r) => (result = r));
    await run(2.2);
    for (let i = 0; i < 20 && !result; i++) await run(0.05);
    const r = result as TakeResult | null;
    expect(r?.endedBy).toBe('interrupted');
    expect(r?.interruptedBy).toBe('no-audio');
  });

  it('a listener that throws does not stop the others or the take from ending', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    const ok = vi.fn();
    s.onInterrupted(() => {
      throw new Error('bad listener');
    });
    s.onInterrupted(ok);
    const t = s.runTake(guide(s, 2), TAKE);
    await run(0.3);
    env.hidePage();
    await run(0.5);
    const r = await t.done;
    expect(r.endedBy).toBe('interrupted');
    expect(ok).toHaveBeenCalledWith('hidden');
  });

  it('onInterrupted returns an unsubscribe', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    const cb = vi.fn();
    const off = s.onInterrupted(cb);
    off();
    env.hidePage();
    expect(cb).not.toHaveBeenCalled();
  });

  it('an unmuted microphone asks the context to resume', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    const c = ctxOf(s);
    const before = c.resumeCalls;
    env.muteMic();
    env.unmuteMic();
    expect(c.resumeCalls).toBe(before + 1);
  });

  it('a device change is announced to a listen-only session too, and cleaned up on close', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: false });
    const seen: InterruptReason[] = [];
    s.onInterrupted((r) => seen.push(r));
    env.changeDevices([{ deviceId: 'x', label: 'Headset Microphone', kind: 'audioinput' }]);
    expect(seen).toEqual(['device-change']);
    await s.close();
    expect((env as unknown as { mediaDevices: { listenerCount(): number } }).mediaDevices.listenerCount()).toBe(0);
  });

  it('refreshRoute sees a headphone arrive after a device change', async () => {
    const { env, s } = setup();
    const first = await s.prepare({ mic: true });
    expect(first.headphonesLikely).toBe(false);
    env.changeDevices([
      { deviceId: 'iphone-mic', label: 'iPhone Microphone', kind: 'audioinput', groupId: 'g1' },
      { deviceId: 'pods', label: 'AirPods', kind: 'audioinput', groupId: 'g2' },
    ]);
    const next = await s.refreshRoute();
    expect(next?.headphonesLikely).toBe(true);
    expect(next?.inputs).toHaveLength(2);
  });
});

describe('listen', () => {
  it('plays the guide, reports a moving position and ends once', async () => {
    const { s } = setup();
    await s.prepare({ mic: false });
    const ended = vi.fn();
    const h = s.listen(guide(s, 1), { onEnded: ended });
    await run(0.3);
    const p1 = h.position();
    await run(0.3);
    const p2 = h.position();
    expect(p2).toBeGreaterThan(p1);
    expect(p1).toBeGreaterThan(0.05);
    expect(p2).toBeLessThanOrEqual(1);
    await run(1);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(Number.isNaN(h.position())).toBe(true);
    h.stop();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('plays only the asked range', async () => {
    const { s } = setup();
    await s.prepare({ mic: false });
    const buf = guide(s, 2, [0.5, 1.5]);
    const ended = vi.fn();
    s.listen(buf, { from: 1, to: 1.9, onEnded: ended });
    await run(1.2);
    expect(ended).toHaveBeenCalledTimes(1);
    const out = ctxOf(s).renderedChannel('l');
    const found = onsets(out, 48000, 0.05, 0.01);
    expect(found).toHaveLength(1); // only the burst at 1.5 s of the guide, not the one at 0.5 s
  });

  it('loops inside the range and keeps the position inside it', async () => {
    const { s } = setup();
    await s.prepare({ mic: false });
    const ended = vi.fn();
    const h = s.listen(guide(s, 2), { from: 0.5, to: 1, loop: true, onEnded: ended });
    for (let i = 0; i < 8; i++) {
      await run(0.2);
      const p = h.position();
      expect(p).toBeGreaterThanOrEqual(0.5);
      expect(p).toBeLessThan(1);
    }
    expect(ended).not.toHaveBeenCalled();
    h.stop();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a new listen stops the old one (its onEnded fires), and stop() is idempotent', async () => {
    const { s } = setup();
    await s.prepare({ mic: false });
    const first = vi.fn();
    const second = vi.fn();
    const a = s.listen(guide(s, 5), { onEnded: first });
    const b = s.listen(guide(s, 5), { onEnded: second });
    expect(first).toHaveBeenCalledTimes(1);
    a.stop();
    expect(first).toHaveBeenCalledTimes(1);
    b.stop();
    b.stop();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('refuses before prepare and after close', async () => {
    const { s } = setup();
    expect(() => s.context).toThrow(/prepare/);
    await s.prepare({ mic: false });
    const buf = guide(s, 1);
    await s.close();
    expect(() => s.listen(buf, {})).toThrow();
  });
});

describe('close', () => {
  it('cleans up everything it opened, once, and resets the audio session', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: true });
    const c = ctxOf(s);
    const track = env.streams[0].getTracks()[0];
    expect(track.listenerCount()).toBeGreaterThan(0);
    await s.close();
    await s.close();
    expect(c.closeCalls).toBe(1);
    expect(c.state).toBe('closed');
    expect(track.readyState).toBe('ended');
    expect(track.listenerCount()).toBe(0);
    expect(c.listenerCount()).toBe(0);
    expect(env.liveObjectUrls.size).toBe(0);
    expect(env.sessionTypes.at(-1)).toBe('auto');
    expect((env as unknown as { mediaDevices: { listenerCount(): number } }).mediaDevices.listenerCount()).toBe(0);
    // No page event reaches a closed session.
    const cb = vi.fn();
    s.onInterrupted(cb);
    env.hidePage();
    env.changeDevices([]);
    expect(cb).not.toHaveBeenCalled();
    await expect(s.prepare({ mic: true })).rejects.toThrow(/closed/);
    expect(s.analyser).toBeNull();
  });

  it('listen-only sessions reset the audio session too', async () => {
    const { env, s } = setup();
    await s.prepare({ mic: false });
    await s.close();
    expect(env.sessionTypes).toEqual(['playback', 'auto']);
  });

  it('closing during a take stops it, resolves it and stops the scheduled clicks', async () => {
    const { s } = setup();
    await s.prepare({ mic: true });
    const t = s.runTake(guide(s, 2), TAKE);
    let result: TakeResult | null = null;
    void t.done.then((r) => (result = r));
    await run(0.2);
    const closing = s.close();
    for (let i = 0; i < 20; i++) await run(0.05);
    await closing;
    expect((result as TakeResult | null)?.endedBy).toBe('stopped');
  });

  it('closing while the permission sheet is still up stops the stream that arrives late and rejects the prepare', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const { env, s } = setup({ micGate: gate });
    const p = s.prepare({ mic: true }).catch((e: unknown) => e);
    const c = ctxOf(s);
    await tick(10);
    const closing = s.close();
    open();
    await tick(10);
    await closing;
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(env.streams[0].getTracks()[0].readyState).toBe('ended');
    expect(c.state).toBe('closed');
  });
});
