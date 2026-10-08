// Importing a song with "Isolate the vocal first": prepareClip / isolatePrepared / commitClip with a FAKE separator injected (no
// onnxruntime, no model, no worker). The fake hands back the clean synthetic melody that the "song" (the melody over a band) was made
// from, which is exactly what a perfect separator would do; real separation quality is measured elsewhere.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeTake } from '../analysis/analyze';
import { analyzeMix } from '../analysis/mixMode';
import { isAbortError } from '../analysis/abort';
import { decodeAudioFile } from '../audio/decode';
import { SeparationError } from '../audio/separation/errors';
import type { IsolateInput, IsolateResult } from '../audio/separation/client';
import { buildLibraryExport, parseClipRecord, parseLibraryExport } from '../storage/library';
import { createMemoryClipStore } from '../storage/clips';
import { DEFAULT_SETTINGS } from '../storage/settings';
import { makeFakeClip } from '../testing/trainerFixtures';
import type { AppSettings } from '../types';
import { BAND_WARNING, ISOLATED_BAND_LEFT_WARNING, ISOLATED_VOCAL_WARNING, ISOLATE_NOT_FOR_MIX, MIX_REASON } from './importCopy';
import { KIT_RATE, soloLine, wavFile, withBand } from './importTestKit';
import {
  commitClip,
  isolatePart,
  isolatePrepared,
  MAX_ISOLATE_SEC,
  MODEL_NOT_KEPT_NOTICE,
  prepareClip,
  preparedKind,
  reanalyzeClip,
  relinkAudio,
  relinkIsolateRequest,
  findRelinkMatches,
  trimStartOf,
  type CommitEdits,
  type ImportDeps,
  type ImportProgress,
  type PreparedClip,
} from './import';

const SETTINGS: AppSettings = { ...DEFAULT_SETTINGS, a4Hz: 440 };
const MODEL = { name: 'Fake separator', version: '9' };

let voice: Float32Array;
let song: Float32Array;

beforeAll(() => {
  voice = soloLine({ count: 4 });
  song = withBand(voice);
});

const analyze: ImportDeps['analyze'] = async (s, sr, opts, onProgress) => (opts.mode === 'mix' ? analyzeMix(s, null, sr, opts, onProgress) : analyzeTake(s, sr, { ...opts, mode: undefined }, onProgress));

/** A separator that returns `voice` (cut to the input's length) after reporting download and patch progress. */
function fakeIsolate(over: { fail?: Error; hold?: boolean; vocals?: () => Float32Array } = {}) {
  const calls: IsolateInput[] = [];
  const fn = vi.fn(async (input: IsolateInput): Promise<IsolateResult> => {
    calls.push(input);
    input.onDownload?.({ loadedBytes: 0, totalBytes: 100, fraction: 0 });
    input.onDownload?.({ loadedBytes: 100, totalBytes: 100, fraction: 1 });
    input.onProgress?.({ phase: 'separating', fraction: 0.2, patch: 1, patches: 5, etaSec: 80 });
    if (over.hold) {
      await new Promise<void>((_, reject) => {
        const stop = () => reject(new DOMException('cancelled', 'AbortError'));
        if (input.signal?.aborted) stop(); // the cancel can land while the model is still downloading
        else input.signal?.addEventListener('abort', stop, { once: true });
      });
    }
    if (over.fail) throw over.fail;
    input.onProgress?.({ phase: 'separating', fraction: 0.9, patch: 5, patches: 5, etaSec: 0 });
    const vocals = over.vocals ? over.vocals() : voice.slice(0, input.samples.length);
    return { vocals, sampleRate: input.sampleRate, model: MODEL, patches: 5, elapsedMs: 10, downloaded: true, modelKept: true };
  });
  return { fn, calls };
}

const depsWith = (isolate: ImportDeps['isolate'], extra: Partial<ImportDeps> = {}): Partial<ImportDeps> => ({ analyze, isolate, ...extra });

function edits(p: PreparedClip, over: Partial<CommitEdits> = {}): CommitEdits {
  return { title: 'Song vocal', singerId: null, singerLabel: '', kind: preparedKind(p), phrases: p.phrases, contributeToSinger: false, ownedConfirmed: true, ...over };
}

describe('isolatePart', () => {
  it('defaults to the start, never takes more than the cap, and ignores nonsense', () => {
    expect(isolatePart({})).toEqual({ startSec: 0, lengthSec: MAX_ISOLATE_SEC });
    expect(isolatePart({ startSec: 30, maxSec: 60 })).toEqual({ startSec: 30, lengthSec: 60 });
    expect(isolatePart({ maxSec: 99999 }).lengthSec).toBe(MAX_ISOLATE_SEC);
    expect(isolatePart({ startSec: -5, maxSec: -1 })).toEqual({ startSec: 0, lengthSec: MAX_ISOLATE_SEC });
    expect(isolatePart({ startSec: Number.NaN })).toEqual({ startSec: 0, lengthSec: MAX_ISOLATE_SEC });
  });

  it('the cap is a constant that fits inside what the analysis reads (6 minutes, or less if the analysis limit is lower)', () => {
    expect(MAX_ISOLATE_SEC).toBeLessThanOrEqual(6 * 60);
    expect(MAX_ISOLATE_SEC).toBeGreaterThan(0);
  });
});

describe('prepareClip with isolation', () => {
  it('splits the song first and reads the vocal as a SOLO: tone and singer measurement are allowed, the clip carries the model', async () => {
    const sep = fakeIsolate();
    const events: ImportProgress[] = [];
    const p = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, (e) => events.push(e), { isolate: {}, deps: depsWith(sep.fn) });

    expect(p.isolation).toEqual({ model: 'Fake separator', version: '9', sourceStartSec: 0 });
    expect(p.kind).toBe('solo');
    expect(p.suggestedKind).toBe('solo');
    expect(p.analysis.mode).not.toBe('mix');
    expect(p.blockers).toEqual([]);
    expect(p.phrases.length).toBeGreaterThan(0);
    expect(Object.keys(p.views ?? {})).toEqual(['solo']);
    // The warning list says what this is, and does not tell the person to switch on "full song" for a vocal that was extracted.
    expect(p.warnings[0]).toBe(ISOLATED_VOCAL_WARNING);
    expect(p.warnings).not.toContain(BAND_WARNING);
    expect(p.warnings.join(' ')).not.toMatch(/full song/i);
    // The stored audio is the isolated vocal, not the song.
    expect(p.samples.length).toBe(voice.length);
    expect(Array.from(p.samples.slice(1000, 1010))).toEqual(Array.from(voice.slice(1000, 1010)));
    expect(p.sampleRate).toBe(KIT_RATE);
    expect(p.fingerprint).toMatch(/:/);
    expect(preparedKind(p)).toBe('solo');
  }, 60000);

  it('says so when the split left the band in: a specific warning, never the "switch on full song" advice', async () => {
    const leaky = fakeIsolate({ vocals: () => song.slice() }); // a separator that removed nothing
    const p = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(leaky.fn) });
    expect(p.warnings[0]).toBe(ISOLATED_VOCAL_WARNING);
    expect(p.warnings).toContain(ISOLATED_BAND_LEFT_WARNING);
    expect(p.warnings).not.toContain(BAND_WARNING);
    expect(p.kind).toBe('solo');
    // A clean vocal does not get it.
    const clean = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate().fn) });
    expect(clean.warnings).not.toContain(ISOLATED_BAND_LEFT_WARNING);
  }, 60000);

  it('asks for the decode at the separator\'s rate (44.1 kHz) only when the song is to be split', async () => {
    const asked: Array<number | undefined> = [];
    const spyDecode: ImportDeps['decode'] = (file, opts) => {
      asked.push(opts.sampleRate);
      return decodeAudioFile(file, opts);
    };
    await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate().fn, { decode: spyDecode }) });
    await prepareClip(wavFile(voice, KIT_RATE, 'Plain.wav'), SETTINGS, undefined, { deps: { analyze, decode: spyDecode } });
    expect(asked).toEqual([44100, undefined]);
  }, 60000);

  it('hands the song to the separator once (and gives up its memory), then analyses the vocal alone, solo only', async () => {
    const sep = fakeIsolate();
    const analyzed: { mode: string | undefined; length: number }[] = [];
    const spy: ImportDeps['analyze'] = (s, sr, opts, onProgress, signal) => {
      analyzed.push({ mode: opts.mode, length: s.length });
      return analyze(s, sr, opts, onProgress, signal);
    };
    await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(sep.fn, { analyze: spy }) });
    expect(sep.fn).toHaveBeenCalledTimes(1);
    expect(sep.calls[0].consume).toBe(true);
    expect(sep.calls[0].sampleRate).toBe(KIT_RATE);
    expect(sep.calls[0].samples.length).toBe(song.length);
    // No mix pass, no analysis of the song itself.
    expect(analyzed).toEqual([{ mode: 'solo', length: voice.length }]);
  }, 60000);

  it('reports download, then splitting with the time left, then analysing, all flagged so the screen uses the isolate plan', async () => {
    const events: ImportProgress[] = [];
    await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, (e) => events.push(e), { isolate: {}, deps: depsWith(fakeIsolate().fn) });
    expect(events.every((e) => e.isolating === true)).toBe(true);
    const phases = events.map((e) => e.phase);
    const first = (ph: ImportProgress['phase']) => phases.indexOf(ph);
    expect(first('decoding')).toBeLessThan(first('downloading-model'));
    expect(first('downloading-model')).toBeLessThan(first('isolating'));
    expect(first('isolating')).toBeLessThan(first('analysing'));
    expect(first('analysing')).toBeLessThan(first('segmenting'));
    expect(events.find((e) => e.phase === 'isolating' && e.etaSec === 80)).toBeTruthy();
  }, 60000);

  it('never says "downloading" when the model is already on the phone (the separator reports no download)', async () => {
    const events: ImportProgress[] = [];
    const kept: ImportDeps['isolate'] = async (input) => {
      input.onProgress?.({ phase: 'starting', fraction: 0, patch: 0, patches: 0, etaSec: null });
      return { vocals: voice.slice(0, input.samples.length), sampleRate: input.sampleRate, model: MODEL, patches: 5, elapsedMs: 1, downloaded: false, modelKept: true };
    };
    await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, (e) => events.push(e), { isolate: {}, deps: depsWith(kept) });
    expect(events.some((e) => e.phase === 'downloading-model')).toBe(false);
    expect(events.some((e) => e.phase === 'isolating')).toBe(true);
  }, 60000);

  it('changes nothing when the option is off: the separator is never touched and a song is still followed as a full song', async () => {
    const sep = fakeIsolate();
    const p = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: depsWith(sep.fn) });
    expect(sep.fn).not.toHaveBeenCalled();
    expect(p.isolation).toBeUndefined();
    expect(p.analysis.mode).toBe('mix');
    expect(p.warnings).toContain(MIX_REASON);
  }, 60000);

  it('takes only the chosen part of a long song: decodes just that far and keeps just that part', async () => {
    const decode = vi.fn(decodeAudioFile);
    const sep = fakeIsolate();
    const seconds = song.length / KIT_RATE;
    expect(seconds).toBeGreaterThan(14);
    const p = await prepareClip(wavFile(song, KIT_RATE, 'Long.wav'), SETTINGS, undefined, { isolate: { startSec: 4, maxSec: 10 }, deps: depsWith(sep.fn, { decode }) });
    expect(decode.mock.calls[0]?.[1]?.maxSeconds).toBe(14);
    expect(sep.calls[0].samples.length).toBe(10 * KIT_RATE);
    expect(p.isolation?.sourceStartSec).toBe(4);
    expect(p.durationSec).toBeCloseTo(10, 2);
    expect(p.notices.join(' ')).toMatch(/0:04 to 0:14 of Long\.wav/);
  }, 60000);

  it('says so when the chosen start is past the end of the file, and does not call the separator', async () => {
    const sep = fakeIsolate();
    await expect(prepareClip(wavFile(song, KIT_RATE, 'Short.wav'), SETTINGS, undefined, { isolate: { startSec: 600 }, deps: depsWith(sep.fn) })).rejects.toThrow(/past the end/);
    expect(sep.fn).not.toHaveBeenCalled();
  });

  it('cancel stops it: the promise rejects with an AbortError and nothing is returned or stored', async () => {
    const sep = fakeIsolate({ hold: true });
    const controller = new AbortController();
    const run = prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, (e) => e.phase === 'downloading-model' && controller.abort(), { isolate: {}, signal: controller.signal, deps: depsWith(sep.fn) });
    const err = await run.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it.each([
    ['the model is missing from this site', new SeparationError('model-missing', 'This copy of Mimic does not include the vocal-isolation model, so a song cannot be split here.')],
    ['the download failed', new SeparationError('download-failed', 'The vocal model could not be downloaded. Check your connection and try again.', true)],
    ['the download does not match the manifest', new SeparationError('hash-mismatch', 'The downloaded vocal model does not match what this site published.', true)],
    ['the engine ran out of memory', new SeparationError('run-failed', 'Splitting the song failed (out of memory).', true)],
  ])('reports a clear message when %s, and returns no clip', async (_what, error) => {
    const sep = fakeIsolate({ fail: error });
    const err = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(sep.fn) }).catch((e: unknown) => e);
    expect(err).toBe(error);
    expect((err as Error).message.length).toBeGreaterThan(20);
  }, 60000);

  it('a vocal that is silent blocks the clip with the usual too-little-singing reason instead of saving nothing', async () => {
    const sep = fakeIsolate({ vocals: () => new Float32Array(voice.length) });
    const p = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(sep.fn) });
    expect(p.blockers.length).toBe(1);
    expect(p.phrases).toEqual([]);
  }, 60000);
});

describe('isolatePrepared (the review\'s button)', () => {
  let mixPrepared: PreparedClip;
  beforeAll(async () => {
    mixPrepared = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: { analyze } });
  }, 60000);

  it('replaces a full-song reading with the isolated vocal read as a solo, from the samples already in hand', async () => {
    expect(mixPrepared.analysis.mode).toBe('mix');
    const sep = fakeIsolate();
    const out = await isolatePrepared(mixPrepared, undefined, { deps: depsWith(sep.fn) });
    expect(out.isolation).toEqual({ model: 'Fake separator', version: '9', sourceStartSec: 0 });
    expect(out.kind).toBe('solo');
    expect(out.analysis.mode).not.toBe('mix');
    expect(out.stem).toBeUndefined();
    expect(Object.keys(out.views ?? {})).toEqual(['solo']);
    expect(out.warnings[0]).toBe(ISOLATED_VOCAL_WARNING);
    expect(out.file).toEqual(mixPrepared.file);
    expect(out.fingerprint).toBe(mixPrepared.fingerprint);
    // The review keeps its own copy until the vocal arrives, so a failure or a cancel leaves it whole: the separator was not given the memory.
    expect(sep.calls[0].consume).toBe(false);
    expect(mixPrepared.samples.length).toBe(song.length);
    expect(mixPrepared.analysis.mode).toBe('mix');
  }, 60000);

  it('leaves the clip untouched when the split fails or is cancelled', async () => {
    const before = { ...mixPrepared };
    await expect(isolatePrepared(mixPrepared, undefined, { deps: depsWith(fakeIsolate({ fail: new SeparationError('run-failed', 'x', true) }).fn) })).rejects.toBeInstanceOf(SeparationError);
    const controller = new AbortController();
    const held = isolatePrepared(mixPrepared, (p) => p.phase === 'downloading-model' && controller.abort(), { signal: controller.signal, deps: depsWith(fakeIsolate({ hold: true }).fn) });
    expect(isAbortError(await held.catch((e: unknown) => e))).toBe(true);
    expect(mixPrepared).toEqual(before);
  }, 60000);

  it('is a no-op for a clip that is already isolated', async () => {
    const once = await isolatePrepared(mixPrepared, undefined, { deps: depsWith(fakeIsolate().fn) });
    const sep = fakeIsolate();
    expect(await isolatePrepared(once, undefined, { deps: depsWith(sep.fn) })).toBe(once);
    expect(sep.fn).not.toHaveBeenCalled();
  }, 60000);

  it('cannot be read as a full song again (that would analyse the isolated vocal as if it were a band)', async () => {
    const once = await isolatePrepared(mixPrepared, undefined, { deps: depsWith(fakeIsolate().fn) });
    await expect(reanalyzeClip(once, 'mix', undefined, { deps: { analyze } })).rejects.toThrow(ISOLATE_NOT_FOR_MIX);
  }, 60000);
});

describe('storing an isolated clip', () => {
  let isolated: PreparedClip;
  beforeAll(async () => {
    isolated = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: { startSec: 0 }, deps: depsWith(fakeIsolate().fn) });
  }, 60000);

  it('stores the vocal as the clip audio and marks the clip with the model, name and version; the library backup carries the mark and no audio', async () => {
    const store = createMemoryClipStore();
    const { clip } = await commitClip(isolated, edits(isolated, { title: 'Song (vocal)' }), store);
    expect(clip.kind).toBe('solo');
    expect(clip.analysisKind).toBe('solo');
    expect(clip.isolation).toEqual({ model: 'Fake separator', version: '9', sourceStartSec: 0 });
    expect(clip.audio.vocal).toBeNull();
    expect(clip.audio.mix.frames).toBeGreaterThan(0);
    expect(await store.getClip(clip.id)).toEqual(clip);

    const exported = buildLibraryExport([clip], [], {});
    const text = JSON.stringify(exported);
    expect(text).toContain('Fake separator');
    expect(text).not.toMatch(/"(pcm|samples|data)"/);
    expect(text.length).toBeLessThan(200_000); // no audio, only numbers
    const parsed = parseLibraryExport(JSON.parse(text));
    expect(parsed.ok && parsed.value.clips[0].isolation).toEqual(clip.isolation);
  }, 60000);

  it('refuses to save an isolated clip as a full song', async () => {
    await expect(commitClip(isolated, edits(isolated, { kind: 'mix' }), createMemoryClipStore())).rejects.toThrow(ISOLATE_NOT_FOR_MIX);
  });

  it('an ordinary clip has no isolation field at all, and an old stored clip without it still loads', () => {
    const plain = makeFakeClip();
    expect('isolation' in plain).toBe(false);
    const roundTrip = parseClipRecord(JSON.parse(JSON.stringify(plain)));
    expect(roundTrip).not.toBeNull();
    expect(roundTrip && 'isolation' in roundTrip).toBe(false);
  });

  it('a damaged isolation mark is dropped and the clip still loads as an ordinary solo clip', () => {
    const base = JSON.parse(JSON.stringify(makeFakeClip()));
    for (const bad of [null, 'yes', {}, { model: 'x' }, { model: '', version: '1' }, { model: 'x', version: 4 }]) {
      const clip = parseClipRecord({ ...base, isolation: bad });
      expect(clip, JSON.stringify(bad)).not.toBeNull();
      expect(clip && 'isolation' in clip).toBe(false);
    }
    const ok = parseClipRecord({ ...base, isolation: { model: 'M', version: '2', sourceStartSec: -3 } });
    expect(ok?.isolation).toEqual({ model: 'M', version: '2', sourceStartSec: 0 });
  });

  it('giving an isolated clip its audio back needs the same part of the song isolated again, never the whole song', async () => {
    const clip = makeFakeClip({ audioMissing: true, isolation: { model: 'M', version: '1', sourceStartSec: 30 }, fingerprint: isolated.fingerprint });
    const whole = { ...isolated, isolation: undefined };
    await expect(relinkAudio(clip, whole, createMemoryClipStore())).rejects.toThrow(/isolated vocal/);
    await expect(relinkAudio(clip, { ...isolated, isolation: { model: 'M', version: '1', sourceStartSec: 0 } }, createMemoryClipStore())).rejects.toThrow(/from 0:30/);
  });
});

describe('giving a trimmed isolated clip its audio back through the window the Add clips screen asks for', () => {
  const file = () => wavFile(song, KIT_RATE, 'Song.wav');

  /** A stored clip as a library import leaves it: record and history, no audio. */
  async function lostFrom(prepared: PreparedClip) {
    const origin = createMemoryClipStore();
    // Trimmed to 0.2 s .. 10 s of a 22.4 s song, as a person trims off a long intro and outro.
    const { clip } = await commitClip(prepared, edits(prepared, { trim: { startSec: 0.2, endSec: 10 } }), origin);
    return { ...clip, audioMissing: true };
  }

  it('asks for a window that is shorter than the song, because the clip is trimmed', async () => {
    const first = await prepareClip(file(), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate().fn) });
    const clip = await lostFrom(first);
    expect(trimStartOf(clip.fingerprint)).toBeGreaterThan(0);
    expect(clip.durationSec).toBeLessThan(10);
    const request = relinkIsolateRequest(clip);
    expect(request).toEqual({ startSec: 0, maxSec: Math.ceil(trimStartOf(clip.fingerprint) + clip.durationSec + 2) });
    expect(request?.maxSec).toBeLessThan(song.length / KIT_RATE); // the original split covered the whole song
    expect(relinkIsolateRequest({ ...clip, isolation: undefined })).toBeNull();
    expect(relinkIsolateRequest({ ...clip, isolation: { model: 'M', version: '1', sourceStartSec: 30 } })?.startSec).toBe(30);
  }, 60000);

  it('recognises the same file although the shorter split decoded a shorter length, and re-attaches the audio', async () => {
    const first = await prepareClip(file(), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate().fn) });
    const clip = await lostFrom(first);
    const request = relinkIsolateRequest(clip);
    const again = await prepareClip(file(), SETTINGS, undefined, { isolate: request ?? undefined, deps: depsWith(fakeIsolate().fn) });
    // The two fingerprints are of the same bytes but of different decoded lengths.
    expect(again.fingerprint.split(':')[0]).toBe(first.fingerprint.split(':')[0]);
    expect(again.fingerprint.split(':')[1]).not.toBe(first.fingerprint.split(':')[1]);
    expect(findRelinkMatches([clip], again)).toHaveLength(1);
    const store = createMemoryClipStore();
    const relinked = await relinkAudio(clip, again, store);
    expect(relinked.audioMissing).toBe(false);
    expect(relinked.phrases).toEqual(clip.phrases);
    expect(relinked.isolation).toEqual(clip.isolation);
  }, 60000);

  it('does the same for a clip isolated from the review (its fingerprint is of the whole decoded file)', async () => {
    const mix = await prepareClip(file(), SETTINGS, undefined, { deps: { analyze } });
    const isolatedFromReview = await isolatePrepared(mix, undefined, { deps: depsWith(fakeIsolate().fn) });
    const clip = await lostFrom(isolatedFromReview);
    const again = await prepareClip(file(), SETTINGS, undefined, { isolate: relinkIsolateRequest(clip) ?? undefined, deps: depsWith(fakeIsolate().fn) });
    expect(findRelinkMatches([clip], again)).toHaveLength(1);
    expect((await relinkAudio(clip, again, createMemoryClipStore())).audioMissing).toBe(false);
  }, 60000);

  it('still refuses a different file, even for an isolated clip', async () => {
    const first = await prepareClip(file(), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate().fn) });
    const clip = await lostFrom(first);
    const other = await prepareClip(wavFile(withBand(soloLine({ count: 3 })), KIT_RATE, 'Other.wav'), SETTINGS, undefined, { isolate: relinkIsolateRequest(clip) ?? undefined, deps: depsWith(fakeIsolate().fn) });
    expect(findRelinkMatches([clip], other)).toHaveLength(0);
    await expect(relinkAudio(clip, other, createMemoryClipStore())).rejects.toThrow(/does not look like the file/);
  }, 60000);
});

describe('guarding a long split', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeStorage() {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it('keeps the screen awake for the whole split and lets go when it ends, however it ends', async () => {
    const events: string[] = [];
    const keepAwake = () => {
      events.push('lock');
      return { release: () => void events.push('release') };
    };
    const sep = fakeIsolate();
    const inner = sep.fn;
    const deps = depsWith(
      (input) => {
        events.push('split');
        return inner(input);
      },
      { keepAwake },
    );
    await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps });
    expect(events).toEqual(['lock', 'split', 'release']);

    events.length = 0;
    const failing = depsWith(fakeIsolate({ fail: new SeparationError('run-failed', 'x', true) }).fn, { keepAwake });
    await expect(prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: failing })).rejects.toBeInstanceOf(SeparationError);
    expect(events).toEqual(['lock', 'release']);

    events.length = 0;
    const mix = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: { analyze, keepAwake } });
    expect(events).toEqual([]); // an ordinary import takes no lock
    await isolatePrepared(mix, undefined, { deps: depsWith(fakeIsolate().fn, { keepAwake }) });
    expect(events).toEqual(['lock', 'release']); // the review's button too
  }, 60000);

  it('a refused wake lock does not stop the split', async () => {
    const keepAwake = () => {
      throw new Error('refused');
    };
    const p = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate().fn, { keepAwake }) });
    expect(p.isolation).toBeDefined();
  }, 60000);

  it('leaves a note while it runs and takes it away when it ends (done, failed or cancelled), so a cut-off page can be recognised', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const during: Array<string | null> = [];
    const watching: ImportDeps['isolate'] = async (input) => {
      during.push(storage.getItem('mimic.isolateInProgress.v1'));
      return fakeIsolate().fn(input);
    };
    await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: { maxSec: 60 }, deps: depsWith(watching) });
    expect(JSON.parse(during[0] ?? 'null')).toMatchObject({ fileName: 'Song.wav', seconds: 60 });
    expect(storage.data.size).toBe(0);

    await expect(prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate({ fail: new SeparationError('run-failed', 'x', true) }).fn) })).rejects.toBeInstanceOf(SeparationError);
    expect(storage.data.size).toBe(0);

    const controller = new AbortController();
    const held = prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, (p) => p.phase === 'downloading-model' && controller.abort(), { isolate: {}, signal: controller.signal, deps: depsWith(fakeIsolate({ hold: true }).fn) });
    expect(isAbortError(await held.catch((e: unknown) => e))).toBe(true);
    expect(storage.data.size).toBe(0);
  }, 60000);

  it('says so when the browser would not keep the model, and stays quiet when it did', async () => {
    const notKept = (): ImportDeps['isolate'] => async (input) => ({ ...(await fakeIsolate().fn(input)), modelKept: false });
    const a = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(notKept()) });
    expect(a.notices).toContain(MODEL_NOT_KEPT_NOTICE);
    const b = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { isolate: {}, deps: depsWith(fakeIsolate().fn) });
    expect(b.notices).not.toContain(MODEL_NOT_KEPT_NOTICE);
    const mix = await prepareClip(wavFile(song, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: { analyze } });
    const c = await isolatePrepared(mix, undefined, { deps: depsWith(notKept()) });
    expect(c.notices).toContain(MODEL_NOT_KEPT_NOTICE);
    expect(mix.notices).not.toContain(MODEL_NOT_KEPT_NOTICE);
  }, 60000);
});
