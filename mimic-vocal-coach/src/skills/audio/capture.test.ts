import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecorderError } from '../../audio/recorder';
import { concat, silence, sine, synthMelody, whiteNoise } from '../../testing/synth';
import type { LiveReading, StopReason } from '../types';
import { AUTO_STOP_RULES, createLiveSmoother, readLive, startSkillCapture } from './capture';
import { fakeRecorder } from './testKit';

const SR = 48000;
// The SPEC's synthetic singer: vibrato 5.5 Hz ±40 cents, jitter 0.5 %, a little breath.
const VOICE = { sampleRate: SR, vibrato: { rateHz: 5.5, extentCents: 40 }, jitter: 0.005, breathNoise: 0.1, vowel: 'a' as const, amplitude: 0.25, seed: 7 };

const note = (midi: number, durSec: number, seed = 7) => synthMelody([{ midi, durSec }], { ...VOICE, seed, attackSec: 0.03, releaseSec: 0.04 });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe('readLive and the smoother', () => {
  it('reads level and pitch from the analyser at the singer’s A4', () => {
    const tone = sine(220, 0.2, SR, 0.3);
    const rec = fakeRecorder(tone, SR);
    void rec.recorder.start();
    vi.advanceTimersByTime(100);
    const buf = new Float32Array(2048);
    const r = readLive(rec.recorder.analyser!, buf, 440, 0.1);
    expect(r.t).toBe(0.1);
    expect(r.hz).toBeCloseTo(220, 0);
    expect(r.midi! - 57).toBeLessThan(0.05);
    expect(r.rmsDb).toBeCloseTo(20 * Math.log10(0.3 / Math.SQRT2), 0);
    expect(r.periodicity).toBeGreaterThan(0.9);
    // At A4 = 442 the same 220 Hz reads about 8 cents flat of A3.
    expect((readLive(rec.recorder.analyser!, buf, 442, 0.1).midi! - 57) * 100).toBeCloseTo(-7.85, 0);
    vi.advanceTimersByTime(400); // past the end of the signal: zeros
    const quiet = readLive(rec.recorder.analyser!, buf, 440, 0.5);
    expect(quiet.midi).toBeNull();
    expect(quiet.periodicity).toBe(0);
  });

  it('removes one- and two-frame octave flicks and leaves unvoiced readings alone', () => {
    const s = createLiveSmoother(440);
    const at = (t: number, midi: number | null): LiveReading => ({ t, hz: null, midi, rmsDb: -30, periodicity: 0.9 });
    const out = [s(at(0, 57)), s(at(0.03, 57.1)), s(at(0.06, 69.05)), s(at(0.09, 57.05)), s(at(0.12, null))];
    expect(out[2].midi).toBeCloseTo(57.1, 6);
    expect(out[2].hz).toBeCloseTo(440 * 2 ** ((57.1 - 69) / 12), 6);
    expect(out[3].midi).toBeCloseTo(57.05, 6);
    expect(out[4].midi).toBeNull();
    const two = [57, 57.1, 57.05, 69.1, 69.0, 57.0].map((m, i) => s(at(0.15 + i * 0.03, m)).midi!);
    two.forEach((m) => expect(Math.abs(m - 57)).toBeLessThan(0.2));
    // A real octave leap comes through after three readings.
    const leap = [69, 69.05, 69.1].map((m, i) => s(at(0.33 + i * 0.03, m)).midi!);
    expect(leap[2]).toBeGreaterThan(68.5);
  });
});

describe('startSkillCapture on a synthetic singer', () => {
  it('pitch test: stops itself once a steady note has been held 1.5 s', async () => {
    const take = concat(silence(0.5, SR), note(57, 4));
    const rec = fakeRecorder(take, SR);
    const readings: LiveReading[] = [];
    const onAutoStop = vi.fn();
    const cap = await startSkillCapture({ rule: AUTO_STOP_RULES.pitchTest(), a4Hz: 440, recorderFactory: () => rec.recorder, onReading: (r) => readings.push(r), onAutoStop });
    expect(cap.analyser).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1800);
    expect(onAutoStop).not.toHaveBeenCalled();
    expect(cap.heldSec).toBeGreaterThan(0.8);
    await vi.advanceTimersByTimeAsync(700);
    expect(onAutoStop).toHaveBeenCalledWith('auto-held');
    const res = await cap.stop('button');
    expect(res.stoppedBy).toBe('auto-held'); // the first reason wins
    expect(res.interrupted).toBeNull();
    expect(res.sampleRate).toBe(SR);
    // Stopped about 0.5 s (silence) + onset + 1.5 s held.
    const sec = res.samples.length / SR;
    expect(sec).toBeGreaterThan(2.0);
    expect(sec).toBeLessThan(2.4);
    expect(cap.analyser).toBeNull();
    // About 33 readings a second, and the live pitch sits on A3 (vibrato averaged by the median).
    expect(res.log.length).toBeGreaterThan(sec * 28);
    expect(readings.length).toBe(res.log.length);
    const voiced = res.log.filter((r) => r.midi !== null).map((r) => r.midi!);
    expect(voiced.length).toBeGreaterThan(40);
    expect(Math.abs(median(voiced) - 57) * 100).toBeLessThan(10);
    expect(res.log.slice(0, 10).every((r) => r.midi === null)).toBe(true);
  });

  it('sequence "7 6 5 4 3 2": counts six notes and stops 1.2 s after the last one', async () => {
    const midis = [71, 69, 67, 65, 64, 62]; // C major, as the prompt plays it
    const parts = [silence(0.6, SR)];
    midis.forEach((m, i) => parts.push(note(m - 12, 0.55, 11 + i), silence(0.07, SR))); // sung an octave lower: fine
    const lineEnd = parts.reduce((s, p) => s + p.length, 0) / SR;
    const take = concat(...parts, silence(4, SR));
    const rec = fakeRecorder(take, SR);
    let stopReason: StopReason | null = null;
    const cap = await startSkillCapture({ rule: AUTO_STOP_RULES.sequence(6), a4Hz: 440, recorderFactory: () => rec.recorder, onAutoStop: (r) => (stopReason = r) });
    await vi.advanceTimersByTimeAsync((lineEnd + 0.9) * 1000);
    expect(stopReason).toBeNull();
    expect(cap.notesHeard).toBe(6);
    await vi.advanceTimersByTimeAsync(600);
    expect(stopReason).toBe('auto-silence');
    const res = await cap.stop('button');
    expect(res.stoppedBy).toBe('auto-silence');
    expect(res.notesHeard).toBe(6);
    expect(res.samples.length / SR).toBeGreaterThan(lineEnd + 1.1);
    expect(res.samples.length / SR).toBeLessThan(lineEnd + 1.5);
  });

  it('a legato line on one breath (80 ms glides) is counted note for note', async () => {
    const midis = [62, 71, 69, 67]; // "2 7- 6- 5-" style leap then steps
    const sung = synthMelody(
      midis.map((m) => ({ midi: m - 12, durSec: 0.6 })),
      { ...VOICE, glideSec: 0.08, attackSec: 0.03, releaseSec: 0.05 },
    );
    const take = concat(silence(0.5, SR), sung, silence(3, SR));
    const rec = fakeRecorder(take, SR);
    const cap = await startSkillCapture({ rule: AUTO_STOP_RULES.sequence(4), a4Hz: 440, recorderFactory: () => rec.recorder });
    await vi.advanceTimersByTimeAsync((0.5 + 2.4 + 1.5) * 1000);
    const res = await cap.stop('button');
    expect(res.notesHeard).toBe(4);
    expect(res.stoppedBy).toBe('auto-silence');
  });

  it('hiss: stops 0.8 s after the hiss ends; room noise first', async () => {
    const take = concat(whiteNoise(0.6, 0.0005, SR, 1), whiteNoise(3, 0.03, SR, 2), whiteNoise(3, 0.0005, SR, 3));
    const rec = fakeRecorder(take, SR);
    const cap = await startSkillCapture({ rule: AUTO_STOP_RULES.hiss(), a4Hz: 440, recorderFactory: () => rec.recorder });
    await vi.advanceTimersByTimeAsync(6000);
    const res = await cap.stop('button');
    expect(res.stoppedBy).toBe('auto-silence');
    // The analyser frame lags the end of the hiss by up to one frame (43 ms) and a poll.
    expect(res.samples.length / SR).toBeGreaterThan(3.6 + 0.8 - 0.05);
    expect(res.samples.length / SR).toBeLessThan(3.6 + 0.8 + 0.15);
  });
});

describe('startSkillCapture controls and errors', () => {
  const quietTake = () => fakeRecorder(silence(30, SR), SR);

  it('manual stop by key: the reason is kept, a second stop returns the same result', async () => {
    const rec = quietTake();
    const cap = await startSkillCapture({ rule: AUTO_STOP_RULES.match(), a4Hz: 440, recorderFactory: () => rec.recorder });
    await vi.advanceTimersByTimeAsync(1000);
    expect(cap.elapsedSec).toBeCloseTo(1, 1);
    const a = cap.stop('key');
    const b = cap.stop('button');
    expect(a).toBe(b);
    const res = await a;
    expect(res.stoppedBy).toBe('key');
    expect(res.samples.length / SR).toBeCloseTo(1, 1);
    expect(rec.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cap.elapsedSec).toBeCloseTo(1, 1); // frozen once stopped
  });

  it('the cap ends a manual take', async () => {
    const rec = quietTake();
    const onAutoStop = vi.fn();
    const cap = await startSkillCapture({ rule: { kind: 'manual', capSec: 3 }, a4Hz: 440, recorderFactory: () => rec.recorder, onAutoStop });
    await vi.advanceTimersByTimeAsync(3100);
    expect(onAutoStop).toHaveBeenCalledWith('cap');
    expect((await cap.stop('button')).stoppedBy).toBe('cap');
  });

  it('cancel drops the take and stops reading', async () => {
    const rec = quietTake();
    const onReading = vi.fn();
    const cap = await startSkillCapture({ rule: AUTO_STOP_RULES.match(), a4Hz: 440, recorderFactory: () => rec.recorder, onReading });
    await vi.advanceTimersByTimeAsync(300);
    cap.cancel();
    const n = onReading.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onReading.mock.calls.length).toBe(n);
    expect(rec.cancelled).toBe(true);
    expect((await cap.stop('button')).samples.length).toBe(0);
  });

  it('an interruption ends the take as "interrupted"; "no-audio" is only reported', async () => {
    const rec = quietTake();
    const reasons: string[] = [];
    const onAutoStop = vi.fn();
    const cap = await startSkillCapture({ rule: AUTO_STOP_RULES.match(), a4Hz: 440, recorderFactory: () => rec.recorder, onInterruption: (r) => reasons.push(r), onAutoStop });
    await vi.advanceTimersByTimeAsync(200);
    rec.interrupt('no-audio');
    await vi.advanceTimersByTimeAsync(200);
    expect(onAutoStop).not.toHaveBeenCalled();
    rec.interrupt('hidden');
    expect(onAutoStop).toHaveBeenCalledWith('interrupted');
    const res = await cap.stop('button');
    expect(res.stoppedBy).toBe('interrupted');
    expect(res.interrupted).toBe('no-audio'); // the first reason, as the recorder reports it
    expect(reasons).toEqual(['no-audio', 'hidden']);
  });

  it('a microphone that will not open rejects with the recorder’s own error and wording', async () => {
    const denied = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    const rec = fakeRecorder(silence(1, SR), SR, { startError: denied });
    const err = await startSkillCapture({ rule: AUTO_STOP_RULES.match(), a4Hz: 440, recorderFactory: () => rec.recorder }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).kind).toBe('denied');
    expect((err as RecorderError).message).toMatch(/Microphone access was blocked/);
  });

  it('a throwing onReading does not break the take', async () => {
    const rec = quietTake();
    const cap = await startSkillCapture({
      rule: { kind: 'manual', capSec: 1 },
      a4Hz: 440,
      recorderFactory: () => rec.recorder,
      onReading: () => {
        throw new Error('ui');
      },
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect((await cap.stop('button')).stoppedBy).toBe('cap');
  });
});
