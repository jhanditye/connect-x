import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeTake } from '../analysis/analyze';
import { floatToInt16 } from '../audio/pcm';
import { loadPhraseAudio, PhraseAudioError } from './phraseAnalysis';
import { createPracticeEngine } from './practiceEngine';
import type { PreparedPlayback } from '../audio/player';
import { FakeBufferSource } from '../testing/fakeAudio';
import { META } from '../storage/clips';
import { isBusy } from '../pwa/register';
import type { AttemptRecord, PhraseRecord, VoiceAnalysis } from '../types';
import type { PracticeSnapshot } from './engine';
import { COPY } from './practiceSession';
import { BUILTIN, CLIP_ID, makeHarness, PHRASE_ID, refAnalysisOf, refAudio, WIRED, type Harness, type HarnessOptions } from './practiceTestKit';
import { detuneConst, HUMAN, humanize, PH_A, PH_SHORT, shiftKey, sliceNotes, SR, tempo } from './score/testkit';
import { masteryProgress } from './srs';
import { attemptLite } from '../storage/library';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

/** A careful human copy of the reference phrase (about 12 cents of pitch error, 30 ms of timing error). */
const person = (seed = 5) => humanize(PH_A, HUMAN.pro, seed);

/** A short phrase (four notes, about three seconds) for the tests of how the engine behaves rather than how it scores: each take is much quicker. */
const quickPerson = (seed = 5) => humanize(PH_SHORT, HUMAN.pro, seed);
async function quick(o: HarnessOptions = {}): Promise<Harness> {
  h = await makeHarness({ notes: PH_SHORT, ...o });
  return h;
}

async function open(o: HarnessOptions = {}): Promise<Harness> {
  h = await makeHarness(o);
  return h;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Md = { listenerCount(): number };

/** Everything the engine opened is closed: contexts, microphone tracks, listeners, object URLs and timers. */
async function expectReleased(x: Harness): Promise<void> {
  await vi.advanceTimersByTimeAsync(20);
  expect(x.env.contexts.every((c) => c.state === 'closed')).toBe(true);
  expect(x.env.streams.every((s) => s.tracks.every((t) => t.readyState === 'ended' && t.listenerCount() === 0))).toBe(true);
  expect((x.env as unknown as { mediaDevices: Md }).mediaDevices.listenerCount()).toBe(0);
  expect(x.env.contexts.every((c) => c.listenerCount() === 0)).toBe(true);
  expect(x.env.liveObjectUrls.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

const flagsOf = (s: PracticeSnapshot): string[] => (s.result?.comparison.notes ?? []).flatMap((n) => n.flags).filter((f) => f !== 'ok');

describe('opening a phrase', () => {
  it('starts preparing, loads the reference and the route, and picks the mode from the route', async () => {
    const x = await open({ noOpen: true });
    expect(x.snap().state).toBe('preparing');
    expect(x.snap().reference).toBeNull();
    await x.until(() => x.snap().state === 'idle', 5);
    const s = x.snap();
    expect(s.reference?.notes.length).toBeGreaterThan(5);
    expect(s.route).toMatchObject({ kind: 'wired', headphonesLikely: true });
    expect(s.options).toEqual({ rate: 1, guideShift: 0, mode: 'sing-along', countInBeats: 3, loop: null });
    expect(x.engine.clip.id).toBe(CLIP_ID);
    expect(x.engine.phrase.id).toBe(PHRASE_ID);
    expect(x.env.contexts).toHaveLength(0); // no audio context until a tap
    expect(x.env.getUserMediaCalls).toHaveLength(0);
  });

  it('listen-then-sing is the start mode without headphones', async () => {
    const x = await open({ audio: { devices: BUILTIN } });
    expect(x.snap().route).toMatchObject({ kind: 'builtin', headphonesLikely: false });
    expect(x.snap().options.mode).toBe('turn-taking');
  });

  it('the slowest speed the phrase was left at, and the count-in preference, are the starting options', async () => {
    const x = await open({ phrase: { rate: 0.75 }, prefs: { countInBeats: 4 } });
    expect(x.snap().options).toMatchObject({ rate: 0.75, countInBeats: 4 });
  });

  it('a phrase that cannot be loaded is an error that names the next step, and Sing tries again', async () => {
    let fail = true;
    const loadAudio = vi.fn(async (...args: Parameters<typeof import('./phraseAnalysis').loadPhraseAudio>) => {
      if (fail) throw new PhraseAudioError('The audio for this phrase could not be read. Add the file for this clip again, or reload the app.', 'missing');
      return (await import('./phraseAnalysis')).loadPhraseAudio(...args);
    });
    const x = await open({ deps: { loadAudio }, noOpen: true });
    await x.until(() => x.snap().state === 'error', 5);
    expect(x.snap().message).toMatch(/Add the file for this clip again/);
    expect(x.snap().reference).toBeNull();
    fail = false;
    await x.take({ notes: person() });
    expect(x.snap().state).toBe('result');
    expect(loadAudio).toHaveBeenCalledTimes(2);
  });

  it('an analysis failure at open is an error with the reason and the next step', async () => {
    const x = await open({ noOpen: true, deps: { analyzePhrase: async () => Promise.reject(new Error('worker crashed')) } });
    await x.until(() => x.snap().state === 'error', 5);
    expect(x.snap().message).toMatch(/worker crashed/);
    expect(x.snap().message).toMatch(/open the phrase again/);
  });

  it('a clip with an isolated vocal is analysed from the vocal and played from the mix', async () => {
    const x = await open({ noOpen: true });
    x.engine.dispose();
    const stem = await x.store.writeAudio(CLIP_ID, 'vocal', floatToInt16(refAudio()), SR);
    const clip = { ...x.clip, audio: { ...x.clip.audio, vocal: stem } };
    const sources: (string | undefined)[] = [];
    const asked: string[] = [];
    const engine = createPracticeEngine(
      { ...x.session, clip },
      {
        loadAudio: async (store, c, p, source) => (asked.push(source), loadPhraseAudio(store, c, p, source)),
        analyzePhrase: async (_c, _p, audio) => (sources.push(audio.source), refAnalysisOf()),
      },
    );
    await x.until(() => engine.getSnapshot().state === 'idle', 5);
    expect(asked).toEqual(['mix', 'vocal']);
    expect(sources).toEqual(['vocal']);
    engine.dispose();
  });
});

describe('snapshot rules (useSyncExternalStore)', () => {
  it('the snapshot object only changes when something did, listeners hear every change, unsubscribe works', async () => {
    const x = await open();
    const a = x.snap();
    expect(x.engine.getSnapshot()).toBe(a);
    const heard = vi.fn();
    const off = x.engine.subscribe(heard);
    x.engine.setOptions({ rate: 1, mode: 'sing-along' }); // already so
    x.engine.stop(); // nothing to stop
    expect(x.snap()).toBe(a);
    expect(heard).not.toHaveBeenCalled();
    x.engine.setOptions({ rate: 0.75 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(x.snap()).not.toBe(a);
    expect(x.snap().options.rate).toBe(0.75);
    expect(a.options.rate).toBe(1); // the old snapshot was not mutated
    off();
    x.engine.setOptions({ rate: 0.6 });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('options are clamped and cleaned: speed 0.5..1, whole-semitone key within 12, 2..4 beats, loops inside the phrase', async () => {
    const x = await open();
    x.engine.setOptions({ rate: 0.1, guideShift: 30.4, countInBeats: 9 });
    expect(x.snap().options).toMatchObject({ rate: 0.5, guideShift: 12, countInBeats: 4 });
    x.engine.setOptions({ rate: 7, guideShift: -3.6, countInBeats: 1 });
    expect(x.snap().options).toMatchObject({ rate: 1, guideShift: -4, countInBeats: 2 });
    x.engine.setOptions({ rate: Number.NaN, guideShift: Number.POSITIVE_INFINITY });
    expect(x.snap().options).toMatchObject({ rate: 1, guideShift: -4 });
    const dur = refAudio().length / SR;
    x.engine.setOptions({ loop: { from: -2, to: dur + 5 } });
    expect(x.snap().options.loop).toEqual({ from: 0, to: dur });
    x.engine.setOptions({ loop: { from: 1, to: 1.02 } });
    expect(x.snap().options.loop).toBeNull();
    x.engine.setOptions({ loop: { from: 1, to: 2 } });
    x.engine.setOptions({ loop: null });
    expect(x.snap().options.loop).toBeNull();
  });
});

describe('a take', () => {
  it('a careful copy scores high with nothing to fix but coverage, is saved with the facts of the take, and counts in', async () => {
    const x = await open();
    const seen: PracticeSnapshot[] = [];
    x.engine.subscribe(() => seen.push(x.snap()));
    const s = await x.take({ notes: person() });
    const r = s.result!;
    expect(s.state).toBe('result');
    expect(r.comparison.score.status).toBe('ok');
    expect(r.comparison.scores.overall).toBeGreaterThanOrEqual(95);
    expect(r.fixes.filter((f) => f.category !== 'coverage')).toEqual([]);
    expect(r.saved).toBe(true);
    expect(r.notice).toBeNull();
    expect(r.keyMode).toBe('locked');
    // the visible states, in order, and the count-in numbers
    expect(x.states.slice(-5)).toEqual(['preparing', 'countin', 'singing', 'processing', 'result']);
    const counts = seen.filter((p) => p.state === 'countin').map((p) => p.countIn);
    expect([...new Set(counts)]).toEqual([3, 2, 1]);
    expect(Math.max(...seen.filter((p) => p.state === 'singing').map((p) => p.level))).toBeGreaterThan(0.2);
    // stored
    const stored = await x.attempts();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: r.attempt.id, clipId: CLIP_ID, phraseId: PHRASE_ID, mode: 'sing-along', keyMode: 'locked', rate: 1, route: 'wired', trust: r.attempt.trust, hasAudio: false, analysisVersion: 1 });
    expect(stored[0].scores.overall).toBe(r.comparison.scores.overall);
    expect(stored[0].notes).toHaveLength(r.comparison.notes.length);
    expect(stored[0].style).toBeTruthy();
    expect(x.session.recordAttempt).toHaveBeenCalledTimes(1);
    expect(x.session.recordAttempt.mock.calls[0][1]).toBeUndefined(); // 'keep my recordings' is off
    // the screen's phrase is refreshed by the provider; the engine remembers the key for the next comparison
    expect((await x.store.getClip(CLIP_ID))?.phrases[0].stats.attempts).toBe(1);
    expect((await x.store.getClip(CLIP_ID))?.phrases[0].keyHint).toBe(0);
  });

  it('a +40 cent detune lowers the pitch score only, and says which notes are sharp', async () => {
    const x = await open();
    const base = (await x.take({ notes: person() })).result!;
    const off = (await x.take({ notes: detuneConst(person(), 40) })).result!;
    const a = base.comparison.scores;
    const b = off.comparison.scores;
    expect(b.pitch).toBeLessThan(a.pitch - 15);
    expect(Math.abs(b.timing! - a.timing!)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.tone! - a.tone!)).toBeLessThanOrEqual(3);
    expect(Math.abs(b.expression! - a.expression!)).toBeLessThanOrEqual(3);
    expect(off.fixes.map((f) => f.category)).toContain('pitch');
    expect(off.fixes[0].id).toBe('pitch-sharp');
    expect(off.saved).toBe(true);
  });

  it('an octave-lower copy is not penalised', async () => {
    const x = await open();
    const r = (await x.take({ notes: person(), key: -12 })).result!;
    expect(r.comparison.transposeSemitones).toBe(-12);
    expect(r.comparison.scores.overall).toBeGreaterThanOrEqual(95);
    expect(flagsOf(x.snap())).toEqual([]);
    expect(r.fixes.filter((f) => f.category !== 'coverage')).toEqual([]);
    expect(r.attempt.transposeSemitones).toBe(-12);
  });

  it('a singer who comes in 200 ms late has a sync offset, not an onset error', async () => {
    const x = await open();
    const r = (await x.take({ notes: person(), delaySec: 0.2 })).result!;
    expect(r.comparison.syncOffsetMs).toBeGreaterThan(150);
    expect(r.comparison.syncOffsetMs).toBeLessThan(250);
    expect(r.comparison.scores.timing).toBeGreaterThanOrEqual(90);
    expect(r.comparison.scores.overall).toBeGreaterThanOrEqual(95);
    expect(flagsOf(x.snap())).not.toContain('late');
    expect(r.fixes.map((f) => f.category)).not.toContain('timing');
  });

  it('a partial attempt is shown honestly: low coverage, a coverage fix, and it does not count toward mastery', async () => {
    const x = await open();
    const r = (await x.take({ notes: sliceNotes(person(), 0, 5) })).result!;
    expect(r.comparison.coverage).toBeLessThan(0.6);
    expect(r.comparison.scores.overall).toBeLessThan(65);
    expect(r.fixes.map((f) => f.category)).toContain('coverage');
    expect(r.saved).toBe(true);
    const stored = await x.attempts();
    expect(masteryProgress(stored.map(attemptLite))).toMatchObject({ hits: 0, considered: 0 }); // not a full-speed attempt
  });

  it('a take on a transposed guide is judged in the guide\'s key', async () => {
    const x = await open();
    x.engine.setOptions({ guideShift: 0 });
    const r = (await x.take({ notes: person(), key: 0 })).result!;
    expect(r.comparison.transposeSemitones).toBe(0);
  });

  it('the singer\'s last key is only a hint: an octave change still scores', async () => {
    const x = await open({ phrase: { keyHint: 0 } });
    const r = (await x.take({ notes: person(), key: -12 })).result!;
    expect(r.comparison.transposeSemitones).toBe(-12);
    expect(r.comparison.scores.overall).toBeGreaterThanOrEqual(95);
  });

  it('listen then sing: the guide that leaks into the microphone is cut off, so the take is not polluted', async () => {
    const x = await open({ audio: { devices: BUILTIN, leak: 0.4 } });
    expect(x.snap().options.mode).toBe('turn-taking');
    const seen: string[] = [];
    x.engine.subscribe(() => seen.push(x.snap().state));
    const s = await x.take({ notes: person(), delaySec: 0.3 });
    const r = s.result!;
    expect(r.attempt.mode).toBe('turn-taking');
    expect(r.keyMode).toBe('free');
    expect(r.comparison.score.status).toBe('ok');
    expect(r.comparison.scores.overall).toBeGreaterThanOrEqual(90);
    expect(r.comparison.syncOffsetMs).toBeNull();
    // count-in, the guide (listening), then the singer's turn
    expect([...new Set(seen)]).toEqual(['preparing', 'countin', 'listening', 'singing', 'processing', 'result']);
  });

  it('keeps the microphone open between attempts: one permission prompt, one context', async () => {
    const x = await open();
    await x.take({ notes: person(1) });
    await x.take({ notes: person(2) });
    expect(x.env.getUserMediaCalls).toHaveLength(1);
    expect(x.env.contexts).toHaveLength(1);
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(1);
  });

  it('position() is the playhead in phrase seconds while the guide plays in a sing-along take, NaN otherwise', async () => {
    const x = await open();
    x.plan({ notes: person() });
    expect(x.engine.position()).toBeNaN();
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'countin', 5);
    expect(x.engine.position()).toBeNaN(); // clicks, no guide yet
    await x.until(() => x.snap().state === 'singing', 8);
    await x.run(1);
    const pos = x.engine.position();
    expect(pos).toBeGreaterThan(0.5);
    expect(pos).toBeLessThan(2);
    await x.drive(p);
    expect(x.engine.position()).toBeNaN();
  });

  it('live pitch while singing is in the displayed key, folded to the guide\'s octave', async () => {
    const x = await open();
    x.plan({ notes: person(), key: -12 });
    const lives: number[] = [];
    x.engine.subscribe(() => {
      const m = x.snap().liveMidi;
      if (x.snap().state === 'singing' && m !== null) lives.push(m);
    });
    await x.drive(x.engine.sing());
    expect(lives.length).toBeGreaterThan(10);
    const ref = x.snap().reference!.pitch.medianMidi!;
    // an octave below the original on the microphone, but drawn next to the original's own notes
    expect(lives.every((m) => Math.abs(m - ref) < 8)).toBe(true);
  });
});

describe('gating: what is not counted', () => {
  it('a take with nothing sung is shown as not scored, says why, and is not saved', async () => {
    const x = await open();
    const r = (await x.take({ silent: true })).result!;
    expect(r.comparison.score.status).toBe('low-evidence');
    expect(r.saved).toBe(false);
    expect(r.notice).toBe(COPY.nothingHeard);
    expect(r.fixes).toEqual([]);
    expect(x.session.recordAttempt).not.toHaveBeenCalled();
    expect(await x.attempts()).toEqual([]);
  });

  it('singing along in another key says so, in the scorer\'s words: move the guide to your key or choose Listen then sing', async () => {
    const x = await open();
    expect(x.snap().options.mode).toBe('sing-along');
    const r = (await x.take({ notes: person(), key: -5 })).result!;
    expect(r.comparison.score.status).toBe('no-match');
    expect(r.comparison.score.diagnostics.noMatchWhy).toBe('locked-key');
    expect(r.saved).toBe(false);
    expect(r.notice).toMatch(/5 semitones below the original key/);
    expect(r.notice).toMatch(/Move the guide to your key/);
    expect(r.notice).toMatch(/Listen then sing/);
    expect(r.notice).not.toBe(COPY.noMatch);
    expect(r.notice).not.toMatch(/microphone|reference/);
    expect(await x.attempts()).toEqual([]);
  });

  it('a different melody does not match: not counted, with the next step', async () => {
    const x = await open();
    const r = (await x.take({ notes: sliceNotes(shiftKey(PH_A, 3), 4, 8) })).result!;
    expect(r.comparison.score.status).toBe('no-match');
    expect(r.saved).toBe(false);
    expect(r.notice).toBe(COPY.noMatch);
    expect(await x.attempts()).toEqual([]);
  });

  it('a copy that is too perfect to be a person is treated as the playback: not saved, trust invalid, no fixes', async () => {
    const x = await open();
    const r = (await x.take({})).result!; // the exact notes of the reference, no human error at all
    expect(r.comparison.score.trust.level).toBe('invalid');
    expect(r.comparison.bleedSuspect).toBe(true);
    expect(r.saved).toBe(false);
    expect(r.notice).toBe(COPY.bleedSuspect);
    expect(r.fixes).toEqual([]);
    expect(r.attempt.trust).toBe('invalid');
    expect(await x.attempts()).toEqual([]);
    expect(x.session.recordAttempt).not.toHaveBeenCalled();
  });

  it('a speaker playing into a microphone that hears no one: the playback is not scored as the singer', async () => {
    const x = await open({ audio: { leak: 1 } });
    const r = (await x.take({ silent: true })).result!;
    expect(r.saved).toBe(false);
    expect(r.comparison.score.trust.level).toBe('invalid');
    expect(r.notice).toBe(COPY.bleedSuspect);
    expect(await x.attempts()).toEqual([]);
  });

  it('a leak on headphones that probably do not seal is doubted but counted', async () => {
    const x = await open({ audio: { leak: 0.05, latencySec: 0.03 } });
    const r = (await x.take({ notes: person() })).result!;
    expect(r.saved).toBe(true);
    expect(r.notice).toBe(COPY.leakCaution);
    expect(r.comparison.score.trust.level).toBe('caution');
    expect(r.attempt.trust).toBe('caution');
  });

  it('a leak on a route without headphones (sing-along chosen anyway) is not counted', async () => {
    const x = await open({ audio: { devices: BUILTIN, leak: 0.2, latencySec: 0.03 } });
    x.engine.setOptions({ mode: 'sing-along' });
    await x.take({ notes: person() }); // refused: no headphones
    expect(x.snap().state).toBe('idle');
    x.engine.setOptions({ mode: 'sing-along' }); // the confirm tap
    const r = (await x.take({ notes: person() })).result!;
    expect(r.attempt.mode).toBe('sing-along');
    expect(r.saved).toBe(false);
    expect(r.notice).toBe(COPY.speakerBleed);
    expect(r.comparison.score.trust.level).toBe('invalid');
    expect(r.fixes).toEqual([]);
    expect(await x.attempts()).toEqual([]);
  });

  it('an unclear key (a different key than last time and little of the phrase matched) is counted but flagged', async () => {
    const x = await open({ phrase: { keyHint: 7 } });
    const r = (await x.take({ notes: sliceNotes(person(), 0, 5) })).result!;
    expect(r.comparison.transposeSemitones).toBe(0);
    expect(r.comparison.coverage).toBeLessThan(0.7);
    expect(r.notice).toMatch(/could not tell which key/);
    expect(r.notice).toMatch(/Try again/);
    expect(r.saved).toBe(true);
  });

  it('a save that fails is reported and the result is still shown, not counted', async () => {
    const x = await open({ recordAttempt: vi.fn(async () => Promise.reject(new Error('the library is closed'))) });
    const r = (await x.take({ notes: person() })).result!;
    expect(x.snap().state).toBe('result');
    expect(r.saved).toBe(false);
    expect(r.notice).toMatch(/could not be saved \(the library is closed\)/);
    expect(r.notice).toMatch(/Export a backup/);
  });

  it('what the provider says about the save (no room for the recording) is passed on, and the attempt has no audio', async () => {
    const x = await open({
      prefs: { keepRecordings: true },
      recordAttempt: vi.fn(async (_a: AttemptRecord, _rec?: { pcm: Int16Array; sampleRate: number }) => ({ saved: true, phrase: {} as PhraseRecord, notice: 'There is not enough room to keep the recording.' })),
    });
    const r = (await x.take({ notes: person() })).result!;
    expect(r.saved).toBe(true);
    expect(r.notice).toBe('There is not enough room to keep the recording.');
    expect(r.attempt.hasAudio).toBe(false);
  });
});

describe('persistence and mastery', () => {
  it('the attempts are stored and the phrase is mastered after three good full-speed attempts', async () => {
    const x = await open();
    const rung = async () => (await x.store.getClip(CLIP_ID))!.phrases[0].srs.rung;
    await x.take({ notes: person(1) });
    await x.take({ notes: person(2) });
    expect(await rung()).toBe(0);
    expect(masteryProgress((await x.attempts()).map(attemptLite))).toMatchObject({ hits: 2, needed: 3 });
    await x.take({ notes: person(3) });
    const clip = (await x.store.getClip(CLIP_ID))!;
    expect(clip.phrases[0].srs.rung).toBe(1);
    expect(clip.phrases[0].srs.masteredAt).not.toBeNull();
    expect(clip.phrases[0].stats).toMatchObject({ attempts: 3, fullSpeedAttempts: 3 });
    expect((await x.attempts()).map((a) => a.scores.overall).every((n) => n >= 85)).toBe(true);
  });

  it('slow practice and gated takes do not count toward mastery', async () => {
    const x = await open({ phrase: { rate: 0.75 } });
    expect(x.snap().options.rate).toBe(0.75);
    // the guide is rendered at 0.75 here (real stretch off the main thread in Node): use the 1.0 speed for the cheap path
    x.engine.setOptions({ rate: 1 });
    await x.take({ notes: person(1) });
    await x.take({ silent: true });
    await x.take({ notes: sliceNotes(person(2), 0, 5) });
    const lite = (await x.attempts()).map(attemptLite);
    expect(lite).toHaveLength(2); // the silent take was never saved
    expect(masteryProgress(lite).hits).toBe(1);
    expect((await x.store.getClip(CLIP_ID))!.phrases[0].srs.rung).toBe(0);
  });

  it('keep my recordings ON: the take is saved with the attempt and plays back from the store', async () => {
    const x = await open({ prefs: { keepRecordings: true } });
    const r = (await x.take({ notes: person() })).result!;
    const rec = x.session.recordAttempt.mock.calls[0][1] as { pcm: Int16Array; sampleRate: number };
    expect(rec.sampleRate).toBe(SR);
    expect(rec.pcm.length).toBeGreaterThan(SR * 8); // the phrase, without the count-in
    expect(r.attempt.hasAudio).toBe(true);
    const stored = await x.store.readAttemptAudio(r.attempt.id);
    expect(stored?.pcm.length).toBe(rec.pcm.length);
    expect((await x.attempts())[0].hasAudio).toBe(true);
  });

  it('keep my recordings OFF: no audio is passed on or stored', async () => {
    const x = await open({ prefs: { keepRecordings: false } });
    const r = (await x.take({ notes: person() })).result!;
    expect(x.session.recordAttempt.mock.calls[0][1]).toBeUndefined();
    expect(r.attempt.hasAudio).toBe(false);
    expect(await x.store.readAttemptAudio(r.attempt.id)).toBeNull();
  });

  it('the preference is read when the take is saved, so switching it on after opening works', async () => {
    const x = await open();
    await x.take({ notes: person(1) });
    expect(x.session.recordAttempt.mock.calls[0][1]).toBeUndefined();
    x.prefs.keepRecordings = true;
    await x.take({ notes: person(2) });
    expect(x.session.recordAttempt.mock.calls[1][1]).toBeDefined();
  });

  it('the click probe\'s round trip is remembered for the route, blended with what was learned before', async () => {
    const x = await open({ audio: { leak: 0.05, latencySec: 0.12 } });
    await x.take({ notes: person(1) });
    await vi.advanceTimersByTimeAsync(5);
    expect(x.session.setCalibration).toHaveBeenCalledTimes(1);
    const first = x.session.setCalibration.mock.calls[0];
    expect(first[0]).toBe('wired');
    expect(first[1]).toBeGreaterThan(100);
    expect(first[1]).toBeLessThan(140);
    expect(await x.store.getMeta<Record<string, number>>(META.calibration)).toEqual({ wired: first[1] });
    x.env.setLatency(0.14);
    await x.take({ notes: person(2) });
    await vi.advanceTimersByTimeAsync(5);
    const second = x.session.setCalibration.mock.calls[1][1] as number;
    expect(second).toBeGreaterThan(first[1]); // moved toward the new reading
    expect(second).toBeLessThan(140);
  });

  it('no leak, no latency reading: nothing is written to the calibration', async () => {
    const x = await open();
    await x.take({ notes: person() });
    await vi.advanceTimersByTimeAsync(5);
    expect(x.session.setCalibration).not.toHaveBeenCalled();
  });
});

describe('route and mode', () => {
  it('sing-along without headphones falls back to listen-then-sing with a message, and no take runs', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    x.engine.setOptions({ mode: 'sing-along' });
    await x.drive(x.engine.sing());
    const s = x.snap();
    // Not an "interrupted take": nothing started, so the screen is at rest with the message; no microphone was opened for it.
    expect(s.state).toBe('idle');
    expect(s.message).toBe(COPY.noSpeaker);
    expect(s.options.mode).toBe('turn-taking');
    expect(s.result).toBeNull();
    expect(x.states).not.toContain('countin');
    expect(x.states).not.toContain('interrupted');
    expect(x.env.getUserMediaCalls).toHaveLength(0); // the route names were known, so the refusal needed no microphone
    expect(x.env.contexts).toHaveLength(0);
    expect(s.micOpen).toBe(false);
    // the next Sing is a normal listen-then-sing take
    const r = (await x.take({ notes: quickPerson(), delaySec: 0.3 })).result!;
    expect(r.attempt.mode).toBe('turn-taking');
  });

  it('when the browser hides the microphone names until it is allowed, the refusal opens it once, says so, and lets it go again', async () => {
    const x = await quick({ audio: { devices: [{ deviceId: 'iphone', label: '', kind: 'audioinput', groupId: 'g2' }] } });
    expect(x.snap().route?.labelsHidden).toBe(true);
    x.engine.setOptions({ mode: 'sing-along' });
    await x.drive(x.engine.sing());
    const s = x.snap();
    expect(s.state).toBe('idle');
    expect(s.message).toBe(COPY.noSpeaker);
    expect(s.options.mode).toBe('turn-taking');
    expect(x.env.getUserMediaCalls).toHaveLength(1); // only a microphone can say what is plugged in
    await vi.advanceTimersByTimeAsync(20);
    expect(x.env.streams.filter((st) => st.live)).toHaveLength(0); // and it is not left on (no orange dot for a take that never started)
    expect(x.ctx().state).toBe('closed');
    expect(s.micOpen).toBe(false);
  });

  it('the singer\'s yes is kept in the snapshot, so the screen does not ask again after choosing sing-along a second time', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    expect(x.snap().speakerConfirmed).toBe(false);
    x.engine.setOptions({ mode: 'sing-along' });
    await x.drive(x.engine.sing()); // refused
    expect(x.snap().speakerConfirmed).toBe(false);
    x.engine.setOptions({ mode: 'sing-along' }); // the confirm tap
    expect(x.snap().speakerConfirmed).toBe(true);
    x.env.changeDevices(WIRED);
    await x.run(0.2);
    expect(x.snap().speakerConfirmed).toBe(false); // it belonged to the old route
  });

  it('choosing sing-along again after the warning is the confirm tap', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    x.engine.setOptions({ mode: 'sing-along' });
    await x.drive(x.engine.sing());
    x.engine.setOptions({ mode: 'sing-along' });
    const r = (await x.take({ notes: quickPerson() })).result!;
    expect(r.attempt.mode).toBe('sing-along');
    expect(x.states).toContain('countin');
  });

  it('"I have headphones on" in the screen\'s own question is the confirm: the take runs in sing-along at once', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    x.engine.setOptions({ mode: 'sing-along' });
    x.plan({ notes: quickPerson() });
    await x.drive(x.engine.sing({ speakerConfirmed: true }));
    const r = x.snap().result!;
    expect(r.attempt.mode).toBe('sing-along');
    expect(x.snap().message).toBeNull();
    expect(x.states).toContain('countin');
  });

  it('speakerConfirmed does nothing in listen-then-sing, and a later plain Sing after a route change is refused again', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    await x.drive(x.engine.sing({ speakerConfirmed: true })); // turn-taking: nothing to confirm
    x.engine.setOptions({ mode: 'sing-along' });
    x.env.changeDevices(WIRED);
    await x.run(0.2);
    x.env.changeDevices(BUILTIN);
    await x.run(0.2);
    await x.drive(x.engine.sing());
    expect(x.snap().message).toBe(COPY.noSpeaker);
  });

  it('the confirm tap belongs to the route: after headphones come and go, sing-along without them is refused again', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    x.engine.setOptions({ mode: 'sing-along' });
    await x.drive(x.engine.sing()); // refused
    x.engine.setOptions({ mode: 'sing-along' }); // confirmed
    await x.take({ notes: quickPerson() });
    expect(x.snap().options.mode).toBe('sing-along');
    x.env.changeDevices(WIRED);
    await x.run(0.2);
    expect(x.snap().route?.headphonesLikely).toBe(true);
    x.env.changeDevices(BUILTIN);
    await x.run(0.2);
    expect(x.snap().route?.headphonesLikely).toBe(false);
    await x.drive(x.engine.sing());
    expect(x.snap().state).toBe('result'); // the earlier result stays on screen, with the message
    expect(x.snap().message).toBe(COPY.noSpeaker);
  });

  it('listen then sing: the playhead follows the guide in the listening part and is hidden for the singer\'s turn', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    x.plan({ notes: quickPerson(), delaySec: 0.3 });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'listening', 10);
    await x.run(1);
    expect(x.engine.position()).toBeGreaterThan(0.5);
    await x.until(() => x.snap().state === 'singing', 10);
    await x.run(0.3);
    expect(x.engine.position()).toBeNaN();
    await x.drive(p);
  });

  it('the route is refreshed when headphones are plugged in or out', async () => {
    const x = await quick({ audio: { devices: BUILTIN } });
    await x.drive(x.engine.listen());
    expect(x.snap().route?.headphonesLikely).toBe(false);
    x.env.changeDevices(WIRED);
    await x.run(0.1);
    expect(x.snap().route).toMatchObject({ kind: 'wired', headphonesLikely: true });
  });

  it('the first Sing of a visit prepares the microphone inside the tap, before any await', async () => {
    const x = await quick();
    const p = x.engine.sing();
    // nothing has been awaited yet: the context exists and the microphone was requested synchronously
    expect(x.env.contexts).toHaveLength(1);
    expect(x.env.getUserMediaCalls).toHaveLength(1);
    expect(x.env.sessionTypes[0]).toBe('play-and-record');
    x.engine.stop();
    await x.drive(p);
  });
});

describe('microphone problems', () => {
  it('permission denied: an error that says what to do, Listen still works, nothing is saved', async () => {
    const x = await open({ audio: { micError: 'NotAllowedError' } });
    await x.drive(x.engine.sing());
    const s = x.snap();
    expect(s.state).toBe('error');
    expect(s.message).toMatch(/Microphone access was blocked/);
    expect(s.message).toMatch(/Allow it in your browser/);
    expect(s.message).toMatch(/Listen/);
    expect(s.result).toBeNull();
    expect(await x.attempts()).toEqual([]);
    await x.drive(x.engine.listen());
    expect(x.snap().state).toBe('idle');
    expect(x.snap().message).toBeNull();
  });

  it('no microphone at all', async () => {
    const x = await open({ audio: { devices: [], micError: 'NotFoundError' } });
    await x.drive(x.engine.sing());
    expect(x.snap().state).toBe('error');
    expect(x.snap().message).toMatch(/No microphone was found/);
  });
});

describe('interruptions', () => {
  async function interruptedAt(cause: (x: Harness) => void): Promise<Harness> {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    await x.run(0.5);
    cause(x);
    await x.drive(p);
    return x;
  }

  const cases: [string, (x: Harness) => void, RegExp][] = [
    ['a call or alarm (audio session)', (x) => x.env.interruptAudio(), /call, alarm or another app.*tap Sing to try again/],
    ['the app going to the background', (x) => x.env.hidePage(), /background.*Keep Mimic open.*tap Sing/],
    ['the microphone ending', (x) => x.env.endMic(), /microphone stopped.*tap Sing.*ask for it again/],
    ['the headphones changing', (x) => x.env.changeDevices(BUILTIN), /headphones or microphone changed.*tap Sing/],
  ];
  for (const [name, cause, message] of cases) {
    it(`${name} cancels the take with a message that names the next step, and nothing is scored`, async () => {
      const x = await interruptedAt(cause);
      const s = x.snap();
      expect(s.state).toBe('interrupted');
      expect(s.message).toMatch(message);
      expect(s.result).toBeNull();
      expect(s.liveMidi).toBeNull();
      expect(s.countIn).toBeNull();
      expect(x.states).not.toContain('processing');
      expect(x.session.recordAttempt).not.toHaveBeenCalled();
      expect(await x.attempts()).toEqual([]);
    });
  }

  it('after an interruption the next Sing works again (a dead microphone is opened again)', async () => {
    const x = await interruptedAt((y) => y.env.endMic());
    const r = (await x.take({ notes: quickPerson() })).result!;
    expect(x.snap().state).toBe('result');
    expect(r.saved).toBe(true);
    expect(x.env.getUserMediaCalls).toHaveLength(2);
  });

  it('the app going to the background while the phrase plays stops it and says how to go on; the result stays', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson() });
    const result = x.snap().result;
    const p = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    x.env.hidePage();
    await x.drive(p);
    const s = x.snap();
    expect(s.state).toBe('interrupted');
    expect(s.message).toMatch(/the playback stopped.*tap Listen to hear it again/);
    expect(s.result).toBe(result);
  });

  it('a microphone problem while only listening is ignored', async () => {
    const x = await quick();
    await x.drive(x.engine.listen()); // opens the context without a microphone
    const p = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    x.env.endMic();
    await x.run(0.2);
    expect(x.snap().state).toBe('listening');
    x.engine.stop();
    await x.drive(p);
  });

  it('a recording with a gap is not scored', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    x.env.glitch(0.2);
    await x.drive(p);
    const s = x.snap();
    expect(s.state).toBe('interrupted');
    expect(s.message).toBe(COPY.gap);
    expect(await x.attempts()).toEqual([]);
  });
});

describe('an app update waits for a take', () => {
  it('the page is busy from the count-in until the result is shown, then free; listening alone does not hold an update back', async () => {
    const x = await quick();
    expect(isBusy()).toBe(false);
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'countin', 5);
    expect(isBusy()).toBe(true);
    await x.until(() => x.snap().state === 'singing', 10);
    expect(isBusy()).toBe(true);
    await x.drive(p);
    expect(x.snap().state).toBe('result');
    expect(isBusy()).toBe(false);
    const l = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    expect(isBusy()).toBe(false);
    x.engine.stop();
    await x.drive(l);
  });

  it('is free again after a cancel, while the take is being analysed and cancelled, and when the screen closes in the middle of a take', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    expect(isBusy()).toBe(true);
    x.engine.stop();
    expect(isBusy()).toBe(false);
    await x.drive(p);
    const q = x.engine.sing();
    await x.until(() => x.snap().state === 'countin', 5);
    expect(isBusy()).toBe(true);
    x.engine.dispose();
    expect(isBusy()).toBe(false);
    await x.drive(q).catch(() => undefined);
    expect(isBusy()).toBe(false);
  });
});

describe('stop()', () => {
  it('cancels a take in the count-in and in the middle of singing: nothing is scored, the microphone stays open for the next try', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'countin', 5);
    x.engine.stop();
    expect(x.snap().state).toBe('idle');
    expect(x.snap().message).toBe(COPY.cancelled); // a cancelled take says so: the screen never looks as if nothing happened
    await x.drive(p);
    expect(x.snap().state).toBe('idle');
    expect(x.snap().result).toBeNull();

    const q = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    await x.run(1);
    expect(x.snap().message).toBeNull(); // the next take cleared the message
    x.engine.stop();
    expect(x.snap().state).toBe('idle');
    expect(x.snap().message).toBe(COPY.cancelled);
    expect(x.snap().countIn).toBeNull();
    expect(x.snap().level).toBe(0);
    await x.drive(q);
    expect(x.session.recordAttempt).not.toHaveBeenCalled();
    expect(await x.attempts()).toEqual([]);
    expect(x.states).not.toContain('processing');
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(1);
    // nothing keeps playing after the cancel
    const before = x.ctx().sources.size;
    await x.run(0.3);
    expect(x.ctx().sources.size).toBeLessThanOrEqual(before);

    const r = (await x.take({ notes: quickPerson() })).result!; // and it still works
    expect(r.saved).toBe(true);
  });

  it('during the analysis it cancels as well: a late result never shows and is never saved', async () => {
    const gate = deferred<void>();
    let signal: AbortSignal | undefined;
    const x = await quick({
      deps: {
        analyzeAttempt: async (s, sr, o, sig) => {
          signal = sig;
          await gate.promise;
          return analyzeTake(s, sr, o);
        },
      },
    });
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'processing', 20);
    expect(signal?.aborted).toBe(false);
    x.engine.stop();
    expect(signal?.aborted).toBe(true); // a worker that supports it stops the analysis instead of finishing for nobody
    expect(x.snap().state).toBe('idle');
    await x.drive(p);
    gate.resolve();
    await x.run(0.5);
    expect(x.snap().state).toBe('idle');
    expect(x.snap().result).toBeNull();
    expect(await x.attempts()).toEqual([]);
  });

  it('stops the phrase while it plays and returns to the result when there is one', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson() });
    const result = x.snap().result;
    const p = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    x.engine.stop();
    expect(x.snap().state).toBe('result');
    expect(x.snap().result).toBe(result);
    await x.drive(p);
  });
});

describe('finish() (the Done button)', () => {
  const guideSec = refAudio(PH_SHORT).length / SR;

  it('ends the take that is being recorded and scores what was sung, instead of throwing it away', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    await x.run(guideSec - 0.1); // the phrase is sung; the half second of tail is not waited for
    x.engine.finish?.();
    await x.drive(p);
    const s = x.snap();
    expect(x.states).toContain('processing');
    expect(s.state).toBe('result');
    expect(s.message).toBeNull();
    expect(s.result?.comparison.score.status).toBe('ok');
    expect(s.result?.saved).toBe(true);
    expect(await x.attempts()).toHaveLength(1);
  });

  it('a Done tapped almost at once is shown honestly as not scored (nothing heard), and is not counted', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    await x.run(0.3);
    x.engine.finish?.();
    await x.drive(p);
    const r = x.snap().result!;
    expect(r.comparison.score.status).not.toBe('ok');
    expect(r.saved).toBe(false);
    expect(r.notice).toBeTruthy();
    expect(await x.attempts()).toEqual([]);
  });

  it('in the count-in there is nothing to score: it cancels, with the message', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'countin', 5);
    x.engine.finish?.();
    expect(x.snap().state).toBe('idle');
    expect(x.snap().message).toBe(COPY.cancelled);
    await x.drive(p);
    expect(x.snap().result).toBeNull();
  });

  it('twice in a row scores once, and Cancel after Done still wins before the analysis is saved', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    await x.run(guideSec - 0.1);
    x.engine.finish?.();
    x.engine.finish?.();
    await x.drive(p);
    expect(await x.attempts()).toHaveLength(1);
    // and with a cancel right behind the Done
    const q = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    await x.run(guideSec - 0.1);
    x.engine.finish?.();
    x.engine.stop();
    await x.drive(q);
    expect(await x.attempts()).toHaveLength(1);
    expect(x.snap().message).toBe(COPY.cancelled);
  });

  it('does nothing harmful when nothing runs, and stops a guide that is playing', async () => {
    const x = await quick();
    x.engine.finish?.();
    expect(x.snap().state).toBe('idle');
    expect(x.snap().message).toBeNull();
    const p = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    x.engine.finish?.();
    expect(x.snap().state).toBe('idle');
    expect(x.snap().message).toBeNull(); // stopping the guide is not a cancelled take
    await x.drive(p);
  });
});

describe('a context that cannot start (a call, Siri, another app)', () => {
  it('Listen says so after a few seconds instead of showing "playing" in silence, and the next tap tries again', async () => {
    const x = await quick({ audio: { resumeNeverSettles: true } });
    await x.drive(x.engine.listen(), 20);
    const s = x.snap();
    expect(s.state).toBe('interrupted');
    expect(s.message).toBe(COPY.audioBusy);
    expect(s.message).toMatch(/tap Listen again/);
    expect(x.states).not.toContain('listening');
  });

  it('hearing the take back says so as well, and the result stays on screen', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson() });
    const result = x.snap().result;
    x.ctx().setState('interrupted');
    x.ctx().resume = () => new Promise(() => undefined);
    await x.drive(x.engine.playAttempt('you'), 20);
    expect(x.snap().state).toBe('interrupted');
    expect(x.snap().message).toBe(COPY.audioBusy);
    expect(x.snap().result).toBe(result);
  });

  it('a context that starts running within the wait just plays', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson() });
    x.ctx().setState('suspended');
    x.ctx().resume = () => new Promise(() => undefined);
    const p = x.engine.playAttempt('you');
    await x.run(1);
    x.ctx().setState('running');
    await x.drive(p, 20);
    expect(x.snap().state).toBe('result');
    expect(x.snap().message).toBeNull();
  });

  it('leaving the screen while it waits leaves no timer or listener behind', async () => {
    const x = await quick({ audio: { resumeNeverSettles: true } });
    const p = x.engine.listen();
    await x.run(2);
    x.engine.dispose();
    await x.drive(p, 20);
    await expectReleased(x);
  });
});

describe('double taps', () => {
  it('two Sing taps in the same moment start one take', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const a = x.engine.sing();
    const b = x.engine.sing();
    await x.drive(Promise.all([a, b]));
    expect(x.env.getUserMediaCalls).toHaveLength(1);
    expect(x.states.filter((s) => s === 'result')).toHaveLength(1);
    expect(await x.attempts()).toHaveLength(1);
  });

  it('Sing during the count-in, during the take and during the analysis does nothing; so does Listen', async () => {
    const gate = deferred<void>();
    const x = await quick({ deps: { analyzeAttempt: async (s, sr, o) => (await gate.promise, analyzeTake(s, sr, o)) } });
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    for (const state of ['countin', 'singing', 'processing'] as const) {
      await x.until(() => x.snap().state === state, 20);
      const before = x.snap();
      await x.engine.sing();
      await x.engine.listen();
      expect(x.snap().state).toBe(state);
      expect(x.snap().options).toBe(before.options);
    }
    gate.resolve();
    await x.drive(p);
    expect(await x.attempts()).toHaveLength(1);
    expect(x.env.getUserMediaCalls).toHaveLength(1);
  });

  it('Listen twice restarts the phrase instead of layering a second one', async () => {
    const x = await quick();
    const a = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    const b = x.engine.listen();
    await x.drive(Promise.all([a, b]));
    expect(x.snap().state).toBe('idle');
    // at most one phrase source is still alive, and none after the end
    expect([...x.ctx().sources].filter((s) => s instanceof FakeBufferSource && !s.ended)).toHaveLength(0);
  });
});

describe('listening', () => {
  it('plays the phrase without the microphone, reports the playhead, and ends by itself', async () => {
    const x = await quick();
    const p = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    expect(x.env.getUserMediaCalls).toHaveLength(0);
    expect(x.env.sessionTypes).toEqual(['playback']);
    await x.run(1);
    const pos = x.engine.position();
    expect(pos).toBeGreaterThan(0.5);
    expect(pos).toBeLessThan(2);
    await x.drive(p);
    expect(x.snap().state).toBe('idle');
    expect(x.engine.position()).toBeNaN();
  });

  it('a loop plays until stopped, inside the chosen region', async () => {
    const x = await quick();
    x.engine.setOptions({ loop: { from: 1, to: 2 } });
    const p = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    await x.run(5);
    expect(x.snap().state).toBe('listening');
    const pos = x.engine.position();
    expect(pos).toBeGreaterThanOrEqual(1);
    expect(pos).toBeLessThanOrEqual(2);
    x.engine.stop();
    await x.drive(p);
    expect(x.snap().state).toBe('idle');
  });

  it('Listen after a result keeps the result on screen', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson() });
    const result = x.snap().result;
    await x.drive(x.engine.listen());
    expect(x.snap().state).toBe('result');
    expect(x.snap().result).toBe(result);
  });
});

describe('hearing the take back', () => {
  async function afterTake(): Promise<Harness> {
    const x = await quick();
    await x.take({ notes: quickPerson(), delaySec: 0.1 });
    return x;
  }
  const stereoSources = (x: Harness) => x.ctx().nodes.filter((n): n is FakeBufferSource => n instanceof FakeBufferSource && n.buffer?.numberOfChannels === 2);

  it('[You] plays the take (peak-normalised, mono) and returns to the result', async () => {
    const x = await afterTake();
    const result = x.snap().result;
    const p = x.engine.playAttempt('you');
    await x.until(() => x.snap().state === 'listening', 5);
    expect(x.engine.position()).toBeNaN(); // the take is not on the phrase's time axis
    await x.drive(p);
    expect(x.snap().state).toBe('result');
    expect(x.snap().result).toBe(result);
    const youBuffers = x.ctx().nodes.filter((n): n is FakeBufferSource => n instanceof FakeBufferSource && n.started && n.buffer?.numberOfChannels === 1 && (n.buffer?.duration ?? 0) > 3);
    expect(youBuffers.length).toBeGreaterThan(0);
  });

  it('[Both] plays the guide on the left and the take on the right, lined up', async () => {
    const x = await afterTake();
    const p = x.engine.playAttempt('both');
    await x.until(() => x.snap().state === 'listening', 5);
    const both = stereoSources(x);
    expect(both).toHaveLength(1);
    const [l, r] = [both[0].buffer!.getChannelData(0), both[0].buffer!.getChannelData(1)];
    expect(l.some((v) => Math.abs(v) > 0.1)).toBe(true);
    expect(r.some((v) => Math.abs(v) > 0.1)).toBe(true);
    expect(x.engine.position()).toBeGreaterThanOrEqual(0);
    await x.drive(p);
    expect(x.snap().state).toBe('result');
  });

  it('[Original] plays the guide at the chosen speed and key', async () => {
    const x = await afterTake();
    await x.drive(x.engine.playAttempt('original'));
    expect(x.snap().state).toBe('result');
  });

  it('with no take to hear it does nothing', async () => {
    const x = await quick();
    await x.engine.playAttempt('you');
    await x.engine.playAttempt('both');
    expect(x.snap().state).toBe('idle');
    expect(x.env.contexts).toHaveLength(0);
  });
});

describe('speed and key (the guide)', () => {
  interface Call {
    rate: number;
    semitones: number;
    signal: AbortSignal | undefined;
    prepared: PreparedPlayback;
    resolve(): void;
    reject(e: unknown): void;
  }
  function guides() {
    const calls: Call[] = [];
    const prepareGuide: NonNullable<HarnessOptions['deps']>['prepareGuide'] = (ctx, audio, rate, semitones, opts) =>
      new Promise((resolve, reject) => {
        const buffer = ctx.createBuffer(1, Math.round((audio.samples.length / audio.sampleRate / rate) * ctx.sampleRate), ctx.sampleRate);
        const prepared: PreparedPlayback = { buffer, rate, semitones };
        calls.push({ rate, semitones, signal: opts?.signal, prepared, resolve: () => resolve(prepared), reject });
      });
    return { calls, prepareGuide };
  }
  const startedWith = (x: Harness, prepared: PreparedPlayback): boolean => x.ctx().nodes.some((n) => n instanceof FakeBufferSource && n.started && n.buffer === (prepared.buffer as unknown));

  it('a speed or key change is debounced, re-prepares the guide, and a stale preparation is dropped', async () => {
    const g = guides();
    const x = await open({ deps: { prepareGuide: g.prepareGuide } });
    const first = x.engine.listen();
    await x.until(() => g.calls.length === 1, 5);
    g.calls[0].resolve();
    await x.drive(first);
    expect(g.calls).toHaveLength(1);

    x.engine.setOptions({ rate: 0.75 });
    await vi.advanceTimersByTimeAsync(100);
    expect(g.calls).toHaveLength(1); // still waiting: the singer may tap another chip
    x.engine.setOptions({ rate: 0.6 });
    await vi.advanceTimersByTimeAsync(300);
    expect(g.calls).toHaveLength(2);
    expect(g.calls[1]).toMatchObject({ rate: 0.6, semitones: 0 });
    expect(g.calls[1].signal?.aborted).toBe(false);

    x.engine.setOptions({ guideShift: -5 }); // while the 0.6 guide is still being rendered
    expect(g.calls[1].signal?.aborted).toBe(true); // the stale render is cancelled at once
    await vi.advanceTimersByTimeAsync(300);
    expect(g.calls).toHaveLength(3);
    expect(g.calls[2]).toMatchObject({ rate: 0.6, semitones: -5 });

    g.calls[1].resolve(); // the stale one finishes anyway
    g.calls[2].resolve();
    await vi.advanceTimersByTimeAsync(5);

    const p = x.engine.listen();
    await x.until(() => x.snap().state === 'listening', 5);
    expect(g.calls).toHaveLength(3); // the prepared guide is used as it is
    expect(startedWith(x, g.calls[2].prepared)).toBe(true);
    expect(startedWith(x, g.calls[1].prepared)).toBe(false);
    x.engine.stop();
    await x.drive(p);
  });

  it('a take is sung against the guide at the chosen speed and key, and the stored attempt says so', async () => {
    const g = guides();
    const x = await open({ deps: { prepareGuide: g.prepareGuide } });
    x.engine.setOptions({ rate: 0.75 });
    x.plan({ notes: person() });
    const p = x.engine.sing();
    await x.until(() => g.calls.length === 1, 5);
    expect(g.calls[0]).toMatchObject({ rate: 0.75, semitones: 0 });
    expect(x.snap().state).toBe('preparing');
    g.calls[0].resolve();
    await x.until(() => x.snap().state === 'singing', 20);
    expect(startedWith(x, g.calls[0].prepared)).toBe(true);
    x.engine.stop();
    await x.drive(p);
  });

  it('a guide that cannot be rendered is an error with the way out', async () => {
    const g = guides();
    const x = await open({ deps: { prepareGuide: g.prepareGuide } });
    x.engine.setOptions({ guideShift: -7 });
    const p = x.engine.listen();
    await x.until(() => g.calls.length === 1, 5);
    g.calls[0].reject(new Error('the stretch worker stopped'));
    await x.drive(p);
    expect(x.snap().state).toBe('error');
    expect(x.snap().message).toMatch(/the stretch worker stopped/);
    expect(x.snap().message).toMatch(/100% speed and the original key/);
  });

  it('changing the speed during a take does not disturb it and applies to the next one', async () => {
    const x = await open();
    x.plan({ notes: person() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    x.engine.setOptions({ rate: 0.75 });
    await x.drive(p);
    expect(x.snap().result?.attempt.rate).toBe(1);
    expect(x.snap().options.rate).toBe(0.75);
  });
});

describe('a take on a slowed or transposed guide (the real stretch)', () => {
  it('a transposed guide in sing-along is a locked key: the singer is judged in the guide\'s key', async () => {
    const x = await quick();
    x.engine.setOptions({ guideShift: -5 });
    const ok = (await x.take({ notes: quickPerson(), key: -5 })).result!;
    expect(ok.keyMode).toBe('locked');
    expect(ok.comparison.transposeSemitones).toBe(-5);
    expect(ok.comparison.scores.overall).toBeGreaterThanOrEqual(85);
    expect(ok.saved).toBe(true);
    expect(ok.comparison.notes.flatMap((n) => n.flags)).not.toContain('wrong-note');
    expect(ok.attempt.transposeSemitones).toBe(-5);
    // singing the original key against a guide in another key is not what the singer was asked to do
    const off = (await x.take({ notes: quickPerson(), key: 0 })).result!;
    expect(off.comparison.scores.overall).toBeLessThan(ok.comparison.scores.overall - 15);
  });

  it('a slowed guide: the take is sung at 75% and stored with that rate (which does not count as a full-speed attempt)', async () => {
    const x = await quick();
    x.engine.setOptions({ rate: 0.75 });
    const r = (await x.take({ notes: tempo(quickPerson(), 1 / 0.75) })).result!;
    expect(r.attempt.rate).toBe(0.75);
    expect(r.comparison.score.status).toBe('ok');
    expect(r.comparison.scores.overall).toBeGreaterThanOrEqual(80);
    expect(r.comparison.tempoRatio).toBeGreaterThan(0.9);
    expect(r.comparison.tempoRatio).toBeLessThan(1.1);
    expect(masteryProgress((await x.attempts()).map(attemptLite)).considered).toBe(0);
  });
});

describe('slow practice on a whole phrase', () => {
  it('a perfect copy sung at half speed (the 50% chip) is scored, not rejected as a different phrase', async () => {
    const x = await open();
    x.engine.setOptions({ rate: 0.5 });
    const r = (await x.take({ notes: tempo(person(), 2) })).result!;
    expect(r.attempt.rate).toBe(0.5);
    expect(r.comparison.score.status).toBe('ok');
    expect(r.comparison.scores.overall).toBeGreaterThanOrEqual(80);
    expect(r.notice).toBeNull();
  }, 60_000);
});

describe('dispose', () => {
  it('releases the microphone, closes the context, and clears every timer after a take', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson() });
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(1);
    const heard = vi.fn();
    x.engine.subscribe(heard);
    x.engine.dispose();
    expect(x.snap().state).toBe('closed');
    expect(heard).toHaveBeenCalledTimes(1);
    await expectReleased(x);
    // idempotent, and every method is a no-op afterwards
    x.engine.dispose();
    x.engine.setOptions({ rate: 0.5 });
    x.engine.stop();
    await x.engine.listen();
    await x.engine.sing();
    await x.engine.playAttempt('you');
    expect(x.engine.position()).toBeNaN();
    expect(x.snap().state).toBe('closed');
    expect(x.snap().options.rate).toBe(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(x.env.getUserMediaCalls).toHaveLength(1);
    expect(x.env.contexts).toHaveLength(1);
    const late = vi.fn();
    x.engine.subscribe(late)();
    expect(late).not.toHaveBeenCalled();
  });

  type Setup = (x: Harness, hold: (p: Promise<unknown>) => void) => Promise<void> | void;
  const states: [string, HarnessOptions, Setup][] = [
    ['preparing (the phrase is still loading)', { noOpen: true, deps: { analyzePhrase: () => new Promise<VoiceAnalysis>(() => undefined) } }, () => undefined],
    ['idle', {}, () => undefined],
    ['listening', {}, (x, hold) => hold(x.engine.listen())],
    ['the count-in', {}, (x, hold) => (x.plan({ notes: quickPerson() }), hold(x.engine.sing()))],
    ['singing', {}, (x, hold) => (x.plan({ notes: quickPerson() }), hold(x.engine.sing()))],
    ['processing', { deps: { analyzeAttempt: () => new Promise<VoiceAnalysis>(() => undefined) } }, (x, hold) => (x.plan({ notes: quickPerson() }), hold(x.engine.sing()))],
    ['a result', {}, async (x) => void (await x.take({ notes: quickPerson() }))],
    [
      'hearing the take back',
      {},
      async (x, hold) => {
        await x.take({ notes: quickPerson() });
        hold(x.engine.playAttempt('both'));
      },
    ],
    ['interrupted', {}, (x, hold) => (x.plan({ notes: quickPerson() }), hold(x.engine.sing()))],
    ['an error', { audio: { micError: 'NotAllowedError' } }, async (x) => void (await x.drive(x.engine.sing()))],
    ['asking for the microphone', { audio: { micGate: new Promise<void>(() => undefined) } }, (x, hold) => hold(x.engine.sing())],
  ];
  const until: Record<string, (x: Harness) => boolean> = {
    listening: (x) => x.snap().state === 'listening',
    'the count-in': (x) => x.snap().state === 'countin',
    singing: (x) => x.snap().state === 'singing',
    processing: (x) => x.snap().state === 'processing',
    'hearing the take back': (x) => x.snap().state === 'listening',
    interrupted: (x) => x.snap().state === 'singing',
    'asking for the microphone': (x) => x.snap().state === 'preparing' && x.env.getUserMediaCalls.length === 1,
  };
  for (const [name, options, setup] of states) {
    it(`during ${name}: everything is released, pending calls end, nothing is saved or shown afterwards`, async () => {
      const x = await quick(options);
      let pending: Promise<unknown> | null = null;
      await setup(x, (p) => {
        pending = p;
      });
      const wait = Object.entries(until).find(([k]) => name.startsWith(k))?.[1];
      if (wait) await x.until(() => wait(x), 30);
      if (name === 'interrupted') {
        x.env.endMic();
        await x.run(0.3);
      }
      const attemptsBefore = (await x.attempts()).length;
      const shown = x.snap().result;
      const heard = vi.fn();
      x.engine.subscribe(heard);
      x.engine.dispose();
      expect(x.snap().state).toBe('closed');
      if (pending) await x.drive((pending as Promise<unknown>).then(() => undefined));
      await expectReleased(x);
      expect((await x.attempts()).length).toBe(attemptsBefore);
      expect(x.snap().result).toBe(shown);
      expect(heard.mock.calls.length).toBeLessThanOrEqual(1);
      expect(x.snap().state).toBe('closed');
      x.engine.dispose();
    });
  }

  it('an analysis that finishes after dispose is ignored: nothing saved, nothing shown', async () => {
    const gate = deferred<void>();
    const x = await quick({ deps: { analyzeAttempt: async (s, sr, o) => (await gate.promise, analyzeTake(s, sr, o)) } });
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'processing', 20);
    x.engine.dispose();
    gate.resolve();
    await x.drive(p);
    await x.run(0.5);
    expect(x.snap().state).toBe('closed');
    expect(x.snap().result).toBeNull();
    expect(await x.attempts()).toEqual([]);
    await expectReleased(x);
  });

  it('a microphone permission that is granted after dispose is closed again', async () => {
    const gate = deferred<void>();
    const x = await quick({ audio: { micGate: gate.promise } });
    const p = x.engine.sing();
    await x.run(0.1);
    x.engine.dispose();
    gate.resolve();
    await x.drive(p);
    await x.run(0.2);
    await expectReleased(x);
  });
});

describe('releasing the microphone when idle', () => {
  it('closes the microphone and the context after 30 s without a tap, and the next tap opens them again', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson(1) });
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(1);
    expect(x.snap().micOpen).toBe(true); // the screen shows "microphone on" while it is
    await vi.advanceTimersByTimeAsync(29_000);
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(0);
    expect(x.snap().micOpen).toBe(false);
    expect(x.ctx().state).toBe('closed');
    expect(x.snap().state).toBe('result'); // what is on screen does not change
    const r = (await x.take({ notes: quickPerson(2) })).result!;
    expect(r.saved).toBe(true);
    expect(x.env.contexts).toHaveLength(2);
    expect(x.env.getUserMediaCalls).toHaveLength(2);
    // [You] still plays the last take on the new context
    await x.drive(x.engine.playAttempt('you'));
    expect(x.snap().state).toBe('result');
  });

  it('a running take or a tap resets the idle clock', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson(1) });
    await vi.advanceTimersByTimeAsync(25_000);
    await x.drive(x.engine.listen());
    await vi.advanceTimersByTimeAsync(25_000);
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(0);
  });

  it('releaseMicrophone() (the "Turn off" button) lets it go at once, and the next Sing opens it again', async () => {
    const x = await quick();
    await x.take({ notes: quickPerson(1) });
    expect(x.snap().micOpen).toBe(true);
    x.engine.releaseMicrophone?.();
    expect(x.snap().micOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(0);
    expect(x.ctx().state).toBe('closed');
    expect(x.snap().state).toBe('result'); // what is on screen does not change
    expect(vi.getTimerCount()).toBe(0); // and no idle timer is left to fire
    const r = (await x.take({ notes: quickPerson(2) })).result!;
    expect(r.saved).toBe(true);
    expect(x.env.getUserMediaCalls).toHaveLength(2);
  });

  it('releaseMicrophone() does nothing while a take runs', async () => {
    const x = await quick();
    x.plan({ notes: quickPerson() });
    const p = x.engine.sing();
    await x.until(() => x.snap().state === 'singing', 10);
    x.engine.releaseMicrophone?.();
    expect(x.env.streams.filter((s) => s.live)).toHaveLength(1);
    expect(x.snap().micOpen).toBe(true);
    await x.drive(p);
  });
});

describe('without a worker or an audio API', () => {
  it('a browser with no Web Audio says so instead of hanging', async () => {
    const x = await open();
    const g = globalThis as unknown as { AudioContext?: unknown };
    const saved = g.AudioContext;
    g.AudioContext = undefined;
    try {
      await x.drive(x.engine.listen());
    } finally {
      g.AudioContext = saved;
    }
    expect(x.snap().state).toBe('error');
    expect(x.snap().message).toMatch(/no Web Audio/);
  });
});

