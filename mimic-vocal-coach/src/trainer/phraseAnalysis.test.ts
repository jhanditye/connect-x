import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeInWorker } from '../analysis/client';
import { floatToInt16 } from '../audio/pcm';
import { createMemoryClipStore } from '../storage/clips';
import { sine } from '../testing/synth';
import { makeFakeClip } from '../testing/trainerFixtures';
import { makeFakeAnalysis } from '../testing/fixtures';
import type { AnalysisOptions, ClipRecord, PhraseRecord, VoiceAnalysis } from '../types';
import {
  analyzePhraseCached,
  clearPhraseAnalysisCache,
  loadPhraseAudio,
  PHRASE_CACHE_SIZE,
  PhraseAudioError,
  phraseAnalysisOptions,
  TRAINER_ANALYSIS_VERSION,
} from './phraseAnalysis';

vi.mock('../analysis/client', () => ({ analyzeInWorker: vi.fn() }));

const analyze = vi.mocked(analyzeInWorker);
const OPTS: AnalysisOptions = { voiceType: 'tenor', a4Hz: 440 };

let n = 0;
/** An analysis that remembers which call produced it. */
const fresh = (): VoiceAnalysis => ({ ...makeFakeAnalysis(), durationSec: ++n });

beforeEach(() => {
  analyze.mockReset();
  analyze.mockImplementation(async () => fresh());
  clearPhraseAnalysisCache();
});

const clip = (over: Partial<ClipRecord> = {}): ClipRecord => makeFakeClip(over);
const phraseOf = (c: ClipRecord, i = 0): PhraseRecord => c.phrases[i];
const audioOf = (len = 4410, source: 'mix' | 'vocal' = 'mix') => ({ samples: new Float32Array(len), sampleRate: 44100, startSec: 0, source });

describe('loadPhraseAudio', () => {
  async function storeWith(rate = 8000, seconds = 25) {
    const store = createMemoryClipStore();
    const c = makeFakeClip({ id: 'c1' });
    const info = await store.writeAudio('c1', 'mix', floatToInt16(sine(220, seconds, rate, 0.5)), rate);
    const clipRec = { ...c, audio: { mix: info, vocal: null }, audioMissing: false };
    await store.putClip(clipRec);
    return { store, clip: clipRec, rate };
  }

  it('reads exactly the phrase window across chunk edges and says where it starts', async () => {
    const { store, clip: c, rate } = await storeWith();
    const phrase = { ...phraseOf(c, 1), start: 8.3, end: 12.6 }; // crosses the 10 s chunk edge
    const audio = await loadPhraseAudio(store, c, phrase, 'mix');
    expect(audio.sampleRate).toBe(rate);
    expect(audio.source).toBe('mix');
    expect(audio.startSec).toBeCloseTo(8.3, 3);
    expect(audio.samples.length).toBeCloseTo((12.6 - 8.3) * rate, -1);
    // The tone is continuous across the chunk edge: no sample jumps by more than the sine's own steepest step (0.5 x 2 pi x 220 / 8000 = 0.086).
    let jump = 0;
    for (let i = 1; i < audio.samples.length; i++) jump = Math.max(jump, Math.abs(audio.samples[i] - audio.samples[i - 1]));
    expect(jump).toBeLessThan(0.1);
  });

  it('falls back from the vocal stem to the mix when the clip has none, and uses the stem when it has one', async () => {
    const { store, clip: c } = await storeWith();
    expect((await loadPhraseAudio(store, c, phraseOf(c), 'vocal')).source).toBe('mix');
    const vocalInfo = await store.writeAudio('c1', 'vocal', floatToInt16(sine(330, 25, 16000, 0.5)), 16000);
    const withStem = { ...c, audio: { mix: c.audio.mix, vocal: vocalInfo } };
    const a = await loadPhraseAudio(store, withStem, phraseOf(c), 'vocal');
    expect(a.source).toBe('vocal');
    expect(a.sampleRate).toBe(16000);
    expect((await loadPhraseAudio(store, withStem, phraseOf(c), 'mix')).sampleRate).toBe(8000);
  });

  it('rejects with a message that names the fix when the audio is missing or unreadable', async () => {
    const { store, clip: c } = await storeWith();
    const missing = await loadPhraseAudio(store, { ...c, audioMissing: true }, phraseOf(c), 'mix').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PhraseAudioError);
    expect((missing as PhraseAudioError).reason).toBe('missing');
    expect((missing as Error).message).toMatch(/Add the file again/);

    const gone = await loadPhraseAudio(createMemoryClipStore(), c, phraseOf(c), 'mix').catch((e: unknown) => e);
    expect((gone as PhraseAudioError).reason).toBe('missing');

    const beyond = await loadPhraseAudio(store, c, { ...phraseOf(c), start: 400, end: 405 }, 'mix').catch((e: unknown) => e);
    expect(beyond).toBeInstanceOf(PhraseAudioError);
    expect((beyond as PhraseAudioError).reason).toBe('unreadable');
    expect((beyond as Error).message).toMatch(/Edit the clip/);
  });
});

describe('phraseAnalysisOptions', () => {
  it('forces mix mode for a mix-melody clip analysed from the mix, never for a stem', () => {
    expect(phraseAnalysisOptions({ analysisKind: 'mix-melody' }, { source: 'mix' }, OPTS).mode).toBe('mix');
    expect(phraseAnalysisOptions({ analysisKind: 'mix-melody' }, { source: undefined }, { ...OPTS, mode: 'solo' }).mode).toBe('mix');
    expect(phraseAnalysisOptions({ analysisKind: 'mix-melody' }, { source: 'vocal' }, OPTS).mode).toBeUndefined();
    expect(phraseAnalysisOptions({ analysisKind: 'solo' }, { source: 'mix' }, { ...OPTS, mode: 'mix' }).mode).toBeUndefined();
  });
});

describe('analyzePhraseCached', () => {
  it('analyses once and serves the same object from the cache afterwards', async () => {
    const c = clip();
    const a1 = await analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS);
    const a2 = await analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS);
    expect(a2).toBe(a1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][1]).toBe(44100);
    expect(analyze.mock.calls[0][2]).toEqual({ voiceType: 'tenor', a4Hz: 440 });
  });

  it('keys on the phrase window, voice type, tuning, mode and analysis version', async () => {
    const c = clip();
    const p = phraseOf(c);
    await analyzePhraseCached(c, p, audioOf(), OPTS);
    await analyzePhraseCached(c, { ...p, end: p.end + 0.5 }, audioOf(), OPTS);
    await analyzePhraseCached(c, p, audioOf(), { voiceType: 'alto', a4Hz: 440 });
    await analyzePhraseCached(c, p, audioOf(), { voiceType: 'tenor', a4Hz: 432 });
    await analyzePhraseCached(c, phraseOf(c, 1), audioOf(), OPTS);
    expect(analyze).toHaveBeenCalledTimes(5);
    expect(TRAINER_ANALYSIS_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('analyses a mix-melody clip in mix mode and a stem in solo mode', async () => {
    const mixClip = clip({ analysisKind: 'mix-melody' });
    await analyzePhraseCached(mixClip, phraseOf(mixClip), audioOf(), OPTS);
    expect(analyze.mock.calls[0][2]).toMatchObject({ mode: 'mix' });
    await analyzePhraseCached(mixClip, phraseOf(mixClip), audioOf(4410, 'vocal'), OPTS);
    expect(analyze.mock.calls[1][2]).not.toHaveProperty('mode');
  });

  it('keeps the six most recently used analyses and drops the oldest', async () => {
    const c = clip();
    const calls = () => analyze.mock.calls.length;
    for (let i = 0; i < PHRASE_CACHE_SIZE; i++) await analyzePhraseCached(c, phraseOf(c, i), audioOf(), OPTS);
    expect(calls()).toBe(PHRASE_CACHE_SIZE);
    // Touch phrase 0 so phrase 1 becomes the oldest, then add a seventh.
    await analyzePhraseCached(c, phraseOf(c, 0), audioOf(), OPTS);
    await analyzePhraseCached(c, phraseOf(c, PHRASE_CACHE_SIZE), audioOf(), OPTS);
    expect(calls()).toBe(PHRASE_CACHE_SIZE + 1);
    await analyzePhraseCached(c, phraseOf(c, 0), audioOf(), OPTS); // still cached
    expect(calls()).toBe(PHRASE_CACHE_SIZE + 1);
    await analyzePhraseCached(c, phraseOf(c, 1), audioOf(), OPTS); // evicted
    expect(calls()).toBe(PHRASE_CACHE_SIZE + 2);
  });

  it('shares one analysis between callers that ask while it is running', async () => {
    let release!: (a: VoiceAnalysis) => void;
    analyze.mockImplementation(() => new Promise<VoiceAnalysis>((r) => (release = r)));
    const c = clip();
    const p1 = analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS);
    const p2 = analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS);
    expect(analyze).toHaveBeenCalledTimes(1);
    const result = fresh();
    release(result);
    expect(await p1).toBe(result);
    expect(await p2).toBe(result);
  });

  it('rejects with an AbortError when cancelled and stops the worker when nobody else is waiting', async () => {
    let signalSeen: AbortSignal | undefined;
    analyze.mockImplementation((_s, _r, _o, _p, signal) => {
      signalSeen = signal;
      return new Promise<VoiceAnalysis>((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }))));
    });
    const c = clip();
    const ctl = new AbortController();
    const waiting = analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS, ctl.signal);
    expect(signalSeen?.aborted).toBe(false);
    ctl.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(signalSeen?.aborted).toBe(true);

    // Nothing is cached or kept in flight for it: the next caller analyses afresh.
    analyze.mockImplementation(async () => fresh());
    const result = await analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(analyze).toHaveBeenCalledTimes(2);

    const early = new AbortController();
    early.abort();
    await expect(analyzePhraseCached(c, phraseOf(c, 2), audioOf(), OPTS, early.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared analysis running while another caller still waits for it', async () => {
    let release!: (a: VoiceAnalysis) => void;
    let signalSeen: AbortSignal | undefined;
    analyze.mockImplementation((_s, _r, _o, _p, signal) => {
      signalSeen = signal;
      return new Promise<VoiceAnalysis>((r) => (release = r));
    });
    const c = clip();
    const a = new AbortController();
    const b = new AbortController();
    const first = analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS, a.signal);
    const second = analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS, b.signal);
    const third = analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS); // no signal: never cancelled
    expect(analyze).toHaveBeenCalledTimes(1);
    a.abort();
    b.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(signalSeen?.aborted).toBe(false);
    const result = fresh();
    release(result);
    expect(await third).toBe(result);
  });

  it('propagates a failed analysis without caching it', async () => {
    analyze.mockRejectedValueOnce(new Error('The analysis failed: boom'));
    const c = clip();
    await expect(analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS)).rejects.toThrow(/boom/);
    const ok = await analyzePhraseCached(c, phraseOf(c), audioOf(), OPTS);
    expect(ok.durationSec).toBeGreaterThan(0);
    expect(analyze).toHaveBeenCalledTimes(2);
  });
});
