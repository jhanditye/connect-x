import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeAudio, type FakeAudio, type FakeAudioContext } from '../../testing/fakeAudio';
import { createSamplePlayer, RESUME_WAIT_MS } from './samplePlayer';

let env: FakeAudio | null = null;
afterEach(() => {
  env?.restore();
  env = null;
  vi.useRealTimers();
});

const samples = new Float32Array(4800).fill(0.1);
const ctxOf = (): FakeAudioContext => (env as FakeAudio).contexts[0];

describe('the import preview player', () => {
  it('plays from a suspended context (the first tap starts it) and reports the playhead', async () => {
    env = installFakeAudio({ sampleRate: 48000 });
    const player = createSamplePlayer();
    expect(await player.play(samples, 48000, { fromSec: 2 })).toBe(true);
    expect(player.playing).toBe(true);
    expect(player.position()).toBeCloseTo(2, 1);
    player.dispose();
  });

  it('an interrupted context (a call, Siri, the background) is resumed inside the tap, and plays once it runs', async () => {
    env = installFakeAudio({ sampleRate: 48000, startSuspended: false });
    const player = createSamplePlayer();
    expect(await player.play(samples, 48000)).toBe(true);
    ctxOf().setState('interrupted');
    const before = ctxOf().resumeCalls;
    expect(await player.play(samples, 48000)).toBe(true);
    expect(ctxOf().resumeCalls).toBe(before + 1);
    expect(ctxOf().state).toBe('running');
    player.dispose();
  });

  it('a context that stays interrupted gives up after a moment and says it could not play, instead of "playing" in silence', async () => {
    vi.useFakeTimers();
    env = installFakeAudio({ sampleRate: 48000, startSuspended: false });
    const player = createSamplePlayer();
    const first = player.play(samples, 48000);
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBe(true);
    ctxOf().setState('interrupted');
    ctxOf().resume = () => new Promise<void>(() => undefined); // the call is still going on
    const second = player.play(samples, 48000);
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS + 50);
    expect(await second).toBe(false);
    expect(player.playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    player.dispose();
  });

  it('a tap that is replaced while it waits for the context does nothing', async () => {
    vi.useFakeTimers();
    env = installFakeAudio({ sampleRate: 48000, startSuspended: true, resumeNeverSettles: true });
    const player = createSamplePlayer();
    const slow = player.play(samples, 48000);
    player.stop();
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS + 50);
    expect(await slow).toBe(false);
    expect(player.playing).toBe(false);
    player.dispose();
  });

  it('the microphone is not blocked afterwards: the audio session goes back to auto when the preview closes', async () => {
    env = installFakeAudio({ sampleRate: 48000 });
    const player = createSamplePlayer();
    await player.play(samples, 48000);
    expect(env.sessionTypes).toContain('playback');
    player.dispose();
    expect(env.sessionTypes.at(-1)).toBe('auto');
  });
});
