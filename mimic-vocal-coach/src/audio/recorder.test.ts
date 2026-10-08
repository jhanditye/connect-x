import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, joinChunks, microphoneUnavailableReason, RecorderError, toRecorderError } from './recorder';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('joinChunks', () => {
  it('concatenates in order and respects the cap', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([4, 5]);
    expect(Array.from(joinChunks([a, b]))).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(joinChunks([a, b], 4))).toEqual([1, 2, 3, 4]);
    expect(joinChunks([]).length).toBe(0);
  });
});

describe('toRecorderError', () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  it('maps permission failures to denied', () => {
    expect(toRecorderError(named('NotAllowedError')).kind).toBe('denied');
    const sec = toRecorderError(named('SecurityError'));
    expect(sec.kind).toBe('denied');
    expect(sec.message).toMatch(/frame/);
  });

  it('maps missing or busy hardware to no-device', () => {
    expect(toRecorderError(named('NotFoundError')).kind).toBe('no-device');
    expect(toRecorderError(named('OverconstrainedError')).kind).toBe('no-device');
    const busy = toRecorderError(named('NotReadableError'));
    expect(busy.kind).toBe('no-device');
    expect(busy.message).toMatch(/busy/);
  });

  it('maps anything else to unsupported and passes RecorderErrors through', () => {
    expect(toRecorderError(new TypeError('weird')).kind).toBe('unsupported');
    const e = new RecorderError('denied', 'x');
    expect(toRecorderError(e)).toBe(e);
  });
});

describe('microphoneUnavailableReason', () => {
  it('flags insecure contexts', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(microphoneUnavailableReason()).toMatch(/secure/);
  });

  it('flags a missing getUserMedia', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', {});
    expect(microphoneUnavailableReason()).toMatch(/does not give web pages microphone access/);
  });

  it('flags frames whose permissions policy blocks the microphone', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve() } });
    vi.stubGlobal('document', { permissionsPolicy: { allowsFeature: (f: string) => f !== 'microphone' } });
    expect(microphoneUnavailableReason()).toMatch(/frame/);
  });

  it('returns null when recording might work', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve() } });
    vi.stubGlobal('document', {});
    expect(microphoneUnavailableReason()).toBeNull();
  });
});

/** Minimal Web Audio + getUserMedia fakes: no AudioWorklet, so the ScriptProcessor path is used. */
function installFakeAudio(opts: { track?: Record<string, unknown>; navigatorExtras?: Record<string, unknown> } = {}) {
  const listeners = new Map<string, () => void>();
  const track = {
    stop: vi.fn(),
    label: '',
    getSettings: () => ({}),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    ...opts.track,
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => stream);
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  let processor: { onaudioprocess: ((e: unknown) => void) | null } & ReturnType<typeof node>;
  const close = vi.fn(async () => undefined);
  class FakeContext {
    sampleRate = 48000;
    state = 'running';
    destination = node();
    close = close;
    resume = vi.fn(async () => undefined);
    createMediaStreamSource = vi.fn(() => node());
    createAnalyser = vi.fn(() => ({ ...node(), fftSize: 0, smoothingTimeConstant: 1 }));
    createGain = vi.fn(() => ({ ...node(), gain: { value: 1 } }));
    createScriptProcessor = vi.fn(() => {
      processor = { ...node(), onaudioprocess: null };
      return processor;
    });
  }
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, ...opts.navigatorExtras });
  vi.stubGlobal('document', {});
  vi.stubGlobal('AudioContext', FakeContext);
  const feed = (samples: number[]) =>
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => Float32Array.from(samples) } });
  return { track, getUserMedia, close, feed, fire: (type: string) => listeners.get(type)?.() };
}

describe('createRecorder', () => {
  it('asks for raw, unprocessed mono audio', async () => {
    const fake = installFakeAudio();
    const rec = createRecorder();
    await rec.start();
    expect(fake.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    expect(rec.analyser).not.toBeNull();
    rec.cancel();
  });

  it('captures samples and releases the microphone and context on stop', async () => {
    const fake = installFakeAudio();
    const rec = createRecorder();
    await rec.start();
    fake.feed([0.1, 0.2]);
    fake.feed([0.3]);
    const out = await rec.stop();
    expect(out.sampleRate).toBe(48000);
    expect(Array.from(out.samples)).toEqual([0.1, 0.2, 0.3].map((v) => Math.fround(v)));
    expect(fake.track.stop).toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalled();
    expect(rec.analyser).toBeNull();
  });

  it('cancel releases everything too', async () => {
    const fake = installFakeAudio();
    const rec = createRecorder();
    await rec.start();
    rec.cancel();
    expect(fake.track.stop).toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalled();
  });

  it('throws a RecorderError when permission is refused', async () => {
    const fake = installFakeAudio();
    fake.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    const err = await createRecorder()
      .start()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).kind).toBe('denied');
    // The context was created up front (for iOS) and must not leak when permission is refused.
    expect(fake.close).toHaveBeenCalled();
  });

  it('throws unsupported without getUserMedia', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', {});
    const err = await createRecorder()
      .start()
      .catch((e: unknown) => e);
    expect((err as RecorderError).kind).toBe('unsupported');
  });
});

describe('createRecorder on iPhone', () => {
  it('reports the microphone in use and flags a Bluetooth voice profile as low bandwidth', async () => {
    installFakeAudio({ track: { label: 'Jamie’s AirPods Pro', getSettings: () => ({ sampleRate: 16000 }) } });
    const rec = createRecorder();
    expect(rec.info).toBeNull();
    await rec.start();
    expect(rec.info).toMatchObject({ inputLabel: 'Jamie’s AirPods Pro', inputSampleRate: 16000, contextSampleRate: 48000, bluetooth: true, lowBandwidth: true });
    rec.cancel();
  });

  it('does not flag the built-in microphone', async () => {
    installFakeAudio({ track: { label: 'iPhone Microphone', getSettings: () => ({ sampleRate: 48000 }) } });
    const rec = createRecorder();
    await rec.start();
    expect(rec.info).toMatchObject({ bluetooth: false, lowBandwidth: false });
    rec.cancel();
  });

  it('tells the page when the system mutes the microphone and reports it from stop()', async () => {
    const fake = installFakeAudio();
    const rec = createRecorder();
    const seen: string[] = [];
    rec.onInterruption = (r) => seen.push(r);
    await rec.start();
    fake.feed([0.1]);
    fake.fire('mute');
    expect(seen).toEqual(['muted']);
    const out = await rec.stop();
    expect(out.interrupted).toBe('muted');
  });

  it('reports a take that ended abruptly and a clean take as not interrupted', async () => {
    const fake = installFakeAudio();
    const rec = createRecorder();
    const seen: string[] = [];
    rec.onInterruption = (r) => seen.push(r);
    await rec.start();
    fake.fire('ended');
    expect(seen).toEqual(['ended']);
    rec.cancel();

    installFakeAudio();
    const clean = createRecorder();
    await clean.start();
    expect((await clean.stop()).interrupted).toBeNull();
  });

  it('measures the clock in captured audio, not wall time', async () => {
    const fake = installFakeAudio();
    const rec = createRecorder();
    await rec.start();
    expect(rec.capturedSec).toBe(0);
    fake.feed(new Array(4800).fill(0));
    expect(rec.capturedSec).toBeCloseTo(0.1, 6);
    rec.cancel();
  });

  it('puts a leftover "playback" audio session back to auto so the microphone can capture', async () => {
    const audioSession = { type: 'playback' };
    installFakeAudio({ navigatorExtras: { audioSession } });
    const rec = createRecorder();
    await rec.start();
    expect(audioSession.type).toBe('auto');
    rec.cancel();
  });

  it('records with the microphone chosen in Settings and falls back to the default when it is gone', async () => {
    const store = new Map<string, string>([['mimic.micDeviceId', 'built-in-mic']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: vi.fn(), removeItem: vi.fn() });
    const fake = installFakeAudio();
    fake.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'OverconstrainedError' }));
    const rec = createRecorder();
    await rec.start();
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    expect(fake.getUserMedia).toHaveBeenNthCalledWith(1, { audio: { ...raw, deviceId: { exact: 'built-in-mic' } } });
    expect(fake.getUserMedia).toHaveBeenNthCalledWith(2, { audio: raw });
    rec.cancel();
  });
});
