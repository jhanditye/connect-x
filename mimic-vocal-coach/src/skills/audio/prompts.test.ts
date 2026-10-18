import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cadenceChords, cadenceEvents, intervalEvents, lineEvents, noteEvents, parseSequence, PROMPT_TIMING } from '../theory';
import type { MusicalKey, ToneEvent } from '../types';
import { FakeClockCtx, fakeRecorder, startedTones } from './testKit';

const C4: MusicalKey = { tonicMidi: 60, mode: 'major' };
const hz = (midi: number, a4 = 440) => a4 * 2 ** ((midi - 69) / 12);

async function load() {
  return import('./index');
}

beforeEach(() => {
  vi.resetModules(); // tones.ts keeps one shared context per module instance
  vi.useFakeTimers();
  FakeClockCtx.instances = [];
  FakeClockCtx.startFrozen = false;
  vi.stubGlobal('AudioContext', FakeClockCtx);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('eventsToTones', () => {
  it('turns every note of every event into a tone at the singer’s A4, chords with headroom', async () => {
    const { eventsToTones, eventPeak } = await load();
    const ev = cadenceEvents(C4);
    const tones = eventsToTones(ev, 442);
    expect(tones).toHaveLength(4 + 4 + 5 + 4 + 1);
    expect(tones[0].hz).toBeCloseTo(hz(48, 442), 6);
    expect(tones[tones.length - 1]).toMatchObject({ hz: expect.closeTo(hz(60, 442), 6), peak: 0.8 });
    // A four-note chord at gain 0.6: 0.8 * 0.6 / sqrt(2) per note; a single note keeps 0.8.
    expect(eventPeak(ev[0])).toBeCloseTo((0.8 * 0.6) / Math.SQRT2, 6);
    expect(eventPeak({ midis: [60, 64], startSec: 0, durSec: 1, role: 'reference', gain: 0.8 })).toBeCloseTo(0.64, 6);
    // Guards: off-piano notes are clamped, broken events skipped.
    const odd: ToneEvent[] = [
      { midis: [5, 130, NaN], startSec: 0, durSec: 1, role: 'reference' },
      { midis: [60], startSec: NaN, durSec: 1, role: 'reference' },
      { midis: [60], startSec: 0, durSec: 0, role: 'reference' },
    ];
    expect(eventsToTones(odd, 440).map((t) => Math.round(t.hz as number))).toEqual([Math.round(hz(21)), Math.round(hz(108))]);
  });
});

describe('playEvents', () => {
  it('plays the cadence then the tonic on the audio clock, fires onEvent in order and ends', async () => {
    const { playEvents } = await load();
    const ev = cadenceEvents(C4);
    const seen: [string, number, number][] = [];
    const p = playEvents(ev, { a4Hz: 440, onEvent: (e, i) => seen.push([e.role, i, FakeClockCtx.instances[0].currentTime]) });
    const ctx = FakeClockCtx.instances[0];
    expect(ctx.state).toBe('running');
    // One oscillator per chord note, started at t0 (lead 0.08 s) + the event's start.
    const started = startedTones(ctx);
    expect(started).toHaveLength(18);
    expect(started.slice(0, 4).map((s) => s.at)).toEqual([0.08, 0.08, 0.08, 0.08]);
    expect(started[4].at).toBeCloseTo(0.08 + PROMPT_TIMING.chordSec, 3);
    expect(started[17]).toEqual({ at: expect.closeTo(0.08 + ev[4].startSec, 3), hz: expect.closeTo(hz(60), 3) });
    // Master volume (default 0.35) on the bus.
    expect(ctx.gains[0].gain.calls[0]).toEqual(['set', 0.35, 0]);
    expect(p.durationSec).toBeGreaterThan(ev[4].startSec + ev[4].durSec);
    expect(p.playing).toBe(true);

    let result: string | null = null;
    void p.done.then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(p.durationSec * 1000 - 100);
    expect(result).toBeNull();
    expect(seen.map((s) => s[0])).toEqual(['cadence', 'cadence', 'cadence', 'cadence', 'tonic']);
    expect(seen.map((s) => s[1])).toEqual([0, 1, 2, 3, 4]);
    // Each onEvent fired within one poll (20 ms) of its sound.
    seen.forEach(([, i, at]) => expect(at - (0.08 + ev[i].startSec)).toBeLessThan(0.03));
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBe('ended');
    expect(p.playing).toBe(false);
    expect(p.stalled).toBe(false);
  });

  it('plays a typed line at the line tempo, and at a slower tempo when asked', async () => {
    const { playEvents } = await load();
    const parsed = parseSequence('7 6 5 4 3 2');
    if (!parsed.ok) throw new Error(parsed.error);
    const midis = parsed.notes.map((n) => 60 + n.semitones);
    expect(midis).toEqual([71, 69, 67, 65, 64, 62]);
    playEvents(lineEvents({ midis }), { a4Hz: 440 });
    const step = PROMPT_TIMING.lineNoteSec + PROMPT_TIMING.lineGapSec;
    const a = startedTones(FakeClockCtx.instances[0]);
    expect(a.map((s) => Math.round(s.hz))).toEqual(midis.map((m) => Math.round(hz(m))));
    a.forEach((s, i) => expect(s.at).toBeCloseTo(0.08 + i * step, 3));
    const busesBefore = FakeClockCtx.instances[0].gains.length; // the second prompt's master bus is created first
    playEvents(lineEvents({ midis }, 1.0), { a4Hz: 440, volume: 0.6 });
    const b = startedTones(FakeClockCtx.instances[0]).slice(6);
    expect(b[1].at - b[0].at).toBeCloseTo(1.0 + PROMPT_TIMING.lineGapSec, 3);
    expect(FakeClockCtx.instances[0].gains[busesBefore].gain.calls[0][1]).toBe(0.6);
  });

  it('plays a harmonic interval as two notes together and a melodic one in turn', async () => {
    const { playEvents } = await load();
    playEvents(intervalEvents(57, 9, 'harmonic'), { a4Hz: 440 });
    playEvents(intervalEvents(69, 9, 'down'), { a4Hz: 440 });
    const s = startedTones(FakeClockCtx.instances[0]);
    expect(s[0].at).toBe(s[1].at);
    expect([Math.round(s[0].hz), Math.round(s[1].hz)]).toEqual([220, 370]);
    expect(Math.round(s[2].hz)).toBe(440);
    expect(Math.round(s[3].hz)).toBe(262);
    expect(s[3].at - s[2].at).toBeCloseTo(PROMPT_TIMING.intervalNoteSec + PROMPT_TIMING.intervalGapSec, 3);
  });

  it('stop() silences the bus at once, skips the rest and resolves "stopped"', async () => {
    const { playEvents } = await load();
    const onEvent = vi.fn();
    const p = playEvents(cadenceEvents(C4), { a4Hz: 440, onEvent });
    await vi.advanceTimersByTimeAsync(300);
    expect(onEvent).toHaveBeenCalledTimes(1);
    p.stop();
    p.stop();
    expect(await p.done).toBe('stopped');
    await vi.advanceTimersByTimeAsync(5000);
    expect(onEvent).toHaveBeenCalledTimes(1);
    const ctx = FakeClockCtx.instances[0];
    expect(ctx.gains[0].gain.calls.some(([k, v]) => k === 'lin' && v === 0)).toBe(true);
    expect(ctx.oscs.every((o) => o.stops.length >= 1)).toBe(true);
  });

  it('stopAllPrompts stops whatever is playing', async () => {
    const { playEvents, stopAllPrompts } = await load();
    const a = playEvents(noteEvents(60), { a4Hz: 440 });
    const b = playEvents(noteEvents(64), { a4Hz: 440 });
    stopAllPrompts();
    expect(await a.done).toBe('stopped');
    expect(await b.done).toBe('stopped');
  });

  it('a stalled audio clock (audio blocked) ends the prompt, flags it and silences the schedule', async () => {
    FakeClockCtx.startFrozen = true;
    const { playEvents } = await load();
    const p = playEvents(noteEvents(60), { a4Hz: 440 });
    let result: string | null = null;
    void p.done.then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1400);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBe('ended');
    expect(p.stalled).toBe(true);
    // The scheduled note was stopped so it cannot sound later, in the middle of a take.
    expect(FakeClockCtx.instances[0].oscs[0].stops.length).toBeGreaterThanOrEqual(2);
  });

  it('without Web Audio, or with nothing to play, it ends at once', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const { playEvents } = await load();
    const p = playEvents(noteEvents(60), { a4Hz: 440 });
    expect(p.durationSec).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p.done).toBe('ended');
    expect(p.stalled).toBe(true);
    const q = playEvents([], { a4Hz: 440 });
    await vi.advanceTimersByTimeAsync(1);
    expect(await q.done).toBe('ended');
    expect(q.stalled).toBe(false);
  });

  it('a throwing onEvent does not break the playback', async () => {
    const { playEvents } = await load();
    const p = playEvents(lineEvents({ midis: [60, 62] }), {
      a4Hz: 440,
      onEvent: () => {
        throw new Error('ui');
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p.done).toBe('ended');
  });
});

describe('volume and drone', () => {
  it('setPromptVolume changes the default master volume, clamped to 0..1', async () => {
    const { playEvents, setPromptVolume, getPromptVolume } = await load();
    setPromptVolume(2);
    expect(getPromptVolume()).toBe(1);
    setPromptVolume(0.2);
    playEvents(noteEvents(60), { a4Hz: 440 });
    expect(FakeClockCtx.instances[0].gains[0].gain.calls[0][1]).toBe(0.2);
  });

  it('startDroneFor holds the note at the singer’s A4 until stopped', async () => {
    const { startDroneFor } = await load();
    const d = startDroneFor(69, 442);
    const osc = FakeClockCtx.instances[0].oscs[0];
    expect(osc.frequency.calls[0][1]).toBeCloseTo(442);
    expect(osc.stops).toHaveLength(0);
    d.stop();
    expect(osc.stops).toHaveLength(1);
  });

  it('keeps a capture-compatible iPhone audio session while a take is open', async () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession: session });
    const { startDroneFor, noteCaptureOpen } = await load();
    startDroneFor(60, 440).stop();
    expect(session.type).toBe('playback'); // tones.ts: plays through the silent switch
    noteCaptureOpen(true);
    startDroneFor(60, 440).stop();
    expect(session.type).toBe('auto'); // put back so the open microphone keeps capturing
    noteCaptureOpen(false);
  });
});

describe('the cadence that sets the key', () => {
  it('is I-IV-V7-I in close voicing with smooth upper voices, major and minor', () => {
    for (const mode of ['major', 'natural-minor', 'harmonic-minor'] as const) {
      for (const tonic of [45, 52, 60, 67]) {
        const chords = cadenceChords({ tonicMidi: tonic, mode });
        expect(chords).toHaveLength(4);
        const uppers = chords.map((c) => c.slice(1));
        // Close voicing: the upper notes span at most an octave.
        uppers.forEach((u) => expect(Math.max(...u) - Math.min(...u)).toBeLessThanOrEqual(12));
        // Every upper note moves by at most 2 semitones to the nearest note of the next chord.
        for (let i = 0; i + 1 < uppers.length; i++) {
          for (const n of uppers[i]) expect(Math.min(...uppers[i + 1].map((m) => Math.abs(m - n)))).toBeLessThanOrEqual(2);
        }
        // V7 has the leading tone (raised 7th, also in minor) resolving up to the tonic.
        expect(chords[2]).toContain(tonic - 1);
        expect(chords[3]).toContain(tonic);
        // Tonic chord third: major 3rd in major, minor 3rd in minor.
        expect(chords[0]).toContain(tonic + (mode === 'major' ? 4 : 3));
        // Bass under everything.
        chords.forEach((c) => expect(c[0]).toBe(Math.min(...c)));
      }
    }
  });
});

describe('promptThenCapture', () => {
  it('opens the microphone only after the prompt has ended and rung out', async () => {
    const { promptThenCapture } = await load();
    const rec = fakeRecorder(new Float32Array(48000 * 10), 48000);
    const onPromptDone = vi.fn();
    const events = noteEvents(60);
    const pending = promptThenCapture(events, { a4Hz: 440, rule: { kind: 'manual', capSec: 5 }, recorderFactory: () => rec.recorder, onPromptDone });
    const ctx = FakeClockCtx.instances[0];
    // During the note and its release: no microphone.
    await vi.advanceTimersByTimeAsync((0.08 + PROMPT_TIMING.singleNoteSec + 0.1) * 1000);
    expect(rec.started).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(onPromptDone).toHaveBeenCalledWith({ stalled: false });
    const endAt = ctx.currentTime;
    expect(rec.started).toBe(false);
    await vi.advanceTimersByTimeAsync(PROMPT_TIMING.beforeCaptureSec * 1000 + 20);
    expect(rec.started).toBe(true);
    expect(ctx.currentTime - endAt).toBeGreaterThanOrEqual(PROMPT_TIMING.beforeCaptureSec - 0.03);
    const cap = await pending;
    expect(cap).not.toBeNull();
    cap!.cancel();
  });

  it('aborting after the microphone opened cancels the take', async () => {
    const { promptThenCapture } = await load();
    const rec = fakeRecorder(new Float32Array(48000 * 10), 48000);
    const ac = new AbortController();
    const pending = promptThenCapture(noteEvents(60, 0.3), { a4Hz: 440, rule: { kind: 'manual', capSec: 5 }, recorderFactory: () => rec.recorder, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(1500);
    const cap = await pending;
    expect(rec.started).toBe(true);
    ac.abort();
    expect(rec.cancelled).toBe(true);
    expect((await cap!.stop('button')).samples.length).toBe(0);
  });

  it('aborting during the prompt stops it and opens no microphone', async () => {
    const { promptThenCapture } = await load();
    const rec = fakeRecorder(new Float32Array(48000), 48000);
    const ac = new AbortController();
    const pending = promptThenCapture(cadenceEvents(C4), { a4Hz: 440, rule: { kind: 'manual', capSec: 5 }, recorderFactory: () => rec.recorder, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(500);
    ac.abort();
    expect(await pending).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rec.started).toBe(false);
  });
});
