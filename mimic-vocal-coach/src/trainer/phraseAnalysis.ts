// Loading one phrase's audio from the store and analysing it (cached). The practice screen opens a phrase by loading its
// window (a few seconds of Int16 PCM from one or two 10 s chunks) and analysing that window once; the analysis of the
// reference phrase is what every attempt is compared with, so it is cached rather than redone for each take.

import { analyzeInWorker } from '../analysis/client';
import type { ClipStore } from '../storage/clips';
import type { AnalysisOptions, ClipRecord, PhraseRecord, VoiceAnalysis } from '../types';

/**
 * Bump when the analysis changes in a way that moves stored numbers. Stored in ClipAnalysisSummary.analysisVersion and
 * AttemptRecord.analysisVersion; the phrase cache is keyed on it.
 */
export const TRAINER_ANALYSIS_VERSION = 1;

export interface PhraseAudio {
  samples: Float32Array;
  sampleRate: number;
  /** Seconds of the clip that sample 0 corresponds to. */
  startSec: number;
  /** Which stored audio the samples came from ('vocal' only when the clip has a stem). */
  source?: 'mix' | 'vocal';
}

/** Why a phrase's audio could not be loaded; `missing` means the clip needs its file added again. */
export class PhraseAudioError extends Error {
  readonly reason: 'missing' | 'unreadable';
  constructor(message: string, reason: 'missing' | 'unreadable') {
    super(message);
    this.name = 'PhraseAudioError';
    this.reason = reason;
  }
}

/** Mono float samples of the phrase window from `source` ('vocal' falls back to 'mix' when the clip has no stem). */
export async function loadPhraseAudio(store: ClipStore, clip: ClipRecord, phrase: PhraseRecord, source: 'mix' | 'vocal'): Promise<PhraseAudio> {
  if (clip.audioMissing) {
    throw new PhraseAudioError('The audio for this clip is not on this device. Add the file again to practise it.', 'missing');
  }
  const info = source === 'vocal' && clip.audio.vocal ? clip.audio.vocal : clip.audio.mix;
  let samples: Float32Array;
  try {
    samples = await store.readAudio(clip.id, info, phrase.start, phrase.end);
  } catch {
    throw new PhraseAudioError('The audio for this phrase could not be read. Add the file for this clip again, or reload the app.', 'missing');
  }
  if (!(samples.length > 0)) {
    throw new PhraseAudioError('This phrase has no audio. Edit the clip\'s phrases, or add the file again.', 'unreadable');
  }
  const firstFrame = Math.min(info.frames, Math.max(0, Math.floor(phrase.start * info.sampleRate)));
  return { samples, sampleRate: info.sampleRate, startSec: firstFrame / info.sampleRate, source: info.kind };
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The analysis was cancelled.', 'AbortError');
  const err = new Error('The analysis was cancelled.');
  err.name = 'AbortError';
  return err;
}

/** How many phrase analyses are kept (the current phrase, the neighbours and a few recent ones). */
export const PHRASE_CACHE_SIZE = 6;

const cache = new Map<string, VoiceAnalysis>(); // insertion order = least recently used first
const inflight = new Map<string, Promise<VoiceAnalysis>>();

/**
 * The options a phrase is analysed with. A phrase of a clip analysed from a full mix must be analysed as a mix again, whatever
 * the caller asked for (a solo analysis of a band is meaningless); audio taken from a stem is always solo.
 */
export function phraseAnalysisOptions(clip: Pick<ClipRecord, 'analysisKind'>, audio: Pick<PhraseAudio, 'source'>, opts: AnalysisOptions): AnalysisOptions {
  const mix = audio.source !== 'vocal' && clip.analysisKind === 'mix-melody';
  const { mode: _ignored, ...rest } = opts;
  return mix ? { ...rest, mode: 'mix' } : { ...rest };
}

export function phraseCacheKey(clip: Pick<ClipRecord, 'id'>, phrase: Pick<PhraseRecord, 'id' | 'start' | 'end'>, audio: PhraseAudio, opts: AnalysisOptions): string {
  return [clip.id, phrase.id, phrase.start, phrase.end, audio.source ?? 'mix', audio.samples.length, opts.voiceType, opts.a4Hz ?? 440, opts.mode ?? 'solo', TRAINER_ANALYSIS_VERSION].join('|');
}

export function clearPhraseAnalysisCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Analysis of one phrase window, cached in an LRU of PHRASE_CACHE_SIZE keyed by (phrase id, window, voice type, a4Hz, mode,
 * analysis version). Callers must treat the result as read-only: the same object is handed to every caller. Rejects with an
 * AbortError when `signal` aborts (the analysis itself finishes in the background and is cached for the next caller).
 */
export function analyzePhraseCached(clip: ClipRecord, phrase: PhraseRecord, audio: PhraseAudio, opts: AnalysisOptions, signal?: AbortSignal): Promise<VoiceAnalysis> {
  if (signal?.aborted) return Promise.reject(abortError());
  const effective = phraseAnalysisOptions(clip, audio, opts);
  const key = phraseCacheKey(clip, phrase, audio, effective);

  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }

  let job = inflight.get(key);
  if (!job) {
    job = analyzeInWorker(audio.samples, audio.sampleRate, effective).then(
      (analysis) => {
        inflight.delete(key);
        cache.set(key, analysis);
        while (cache.size > PHRASE_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
        return analysis;
      },
      (err: unknown) => {
        inflight.delete(key);
        throw err;
      },
    );
    inflight.set(key, job);
  }
  if (!signal) return job;

  const pending = job;
  return new Promise<VoiceAnalysis>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (analysis) => {
        signal.removeEventListener('abort', onAbort);
        resolve(analysis);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
