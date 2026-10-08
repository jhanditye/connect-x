// Test support for the real practice engine (imported by tests only; never by app code). A harness that wires
// createPracticeEngine to the Node Web Audio doubles (testing/fakeAudio.ts), a memory clip store and a PracticeSession that
// saves attempts the way TrainerProvider does (storage/library applyAttempt), plus a synthetic singer whose voice reaches the
// fake microphone at a chosen moment. All audio is synthesised (score/testkit.ts); nothing here ships in the app.

import { vi } from 'vitest';
import { analyzeTake } from '../analysis/analyze';
import { floatToInt16 } from '../audio/pcm';
import type { PracticeSession } from '../state/TrainerProvider';
import { createMemoryClipStore, META, type ClipStore } from '../storage/clips';
import { applyAttempt } from '../storage/library';
import { installFakeAudio, runFor, type FakeAudio, type FakeAudioContext, type FakeAudioOptions } from '../testing/fakeAudio';
import { makeFakeClip } from '../testing/trainerFixtures';
import type { AppSettings, AttemptRecord, ClipRecord, PhraseRecord, VoiceAnalysis } from '../types';
import type { TrainerPrefs } from '../ui/trainerPrefs';
import type { PracticeEngine, PracticeSnapshot } from './engine';
import { createPracticeEngine, type PracticeEngineDeps } from './practiceEngine';
import { DEFAULT_TONE, PH_A, renderPhrase, SR, type PNote, type ToneParams } from './score/testkit';

export const SETTINGS: AppSettings = { voiceType: 'tenor', a4Hz: 440, anthropicApiKey: null, aiModel: 'test-model' };
export const WIRED = [{ deviceId: 'headset', label: 'Headset Microphone', kind: 'audioinput' as const, groupId: 'g1' }];
export const BUILTIN = [{ deviceId: 'iphone', label: 'iPhone Microphone', kind: 'audioinput' as const, groupId: 'g2' }];
export const CLIP_ID = 'practice-clip';
export const PHRASE_ID = 'practice-clip-p1';

const refAudioCache = new Map<PNote[], Float32Array>();
const refAnalysisCache = new Map<PNote[], VoiceAnalysis>();

/** The reference phrase as the segmenter would store it: 0.15 s of lead-in, the notes, 0.2 s of tail. */
export function refAudio(notes: PNote[] = PH_A): Float32Array {
  let a = refAudioCache.get(notes);
  if (!a) {
    a = renderPhrase(notes, DEFAULT_TONE, { seed: 11, leadIn: 0.15, tail: 0.2 });
    refAudioCache.set(notes, a);
  }
  return a;
}

export function refAnalysisOf(notes: PNote[] = PH_A): VoiceAnalysis {
  let a = refAnalysisCache.get(notes);
  if (!a) {
    a = analyzeTake(refAudio(notes), SR, { voiceType: 'tenor', a4Hz: 440 });
    refAnalysisCache.set(notes, a);
  }
  return a;
}

export interface VoicePlan {
  notes?: PNote[];
  /** Semitones above (+) or below (-) the reference. */
  key?: number;
  /** The singer comes in this long after the guide (sing-along) or after the end of the guide (turn-taking), seconds. */
  delaySec?: number;
  tone?: ToneParams;
  seed?: number;
  /** Nothing is sung. */
  silent?: boolean;
}

export interface HarnessOptions {
  audio?: FakeAudioOptions;
  notes?: PNote[];
  prefs?: Partial<TrainerPrefs>;
  deps?: PracticeEngineDeps;
  clip?: Partial<ClipRecord>;
  phrase?: Partial<PhraseRecord>;
  /** Do not wait for the phrase to finish loading. */
  noOpen?: boolean;
  /** Replace the session's recordAttempt. */
  recordAttempt?: PracticeSession['recordAttempt'];
}

export interface Harness {
  env: FakeAudio;
  store: ClipStore;
  clip: ClipRecord;
  phrase: PhraseRecord;
  session: PracticeSession & {
    recordAttempt: ReturnType<typeof vi.fn> & PracticeSession['recordAttempt'];
    setCalibration: ReturnType<typeof vi.fn> & PracticeSession['setCalibration'];
  };
  engine: PracticeEngine;
  prefs: TrainerPrefs;
  states: string[];
  ctx(): FakeAudioContext;
  snap(): PracticeSnapshot;
  run(sec: number): Promise<void>;
  /** Runs the audio clock and timers until `p` settles. */
  drive<T>(p: Promise<T>, maxSec?: number): Promise<T>;
  /** Advances until `cond` is true. */
  until(cond: () => boolean, maxSec?: number): Promise<void>;
  plan(p: VoicePlan | null): void;
  /** One Sing with the given voice, driven to the end. */
  take(p?: VoicePlan): Promise<PracticeSnapshot>;
  attempts(): Promise<AttemptRecord[]>;
  cleanup(): Promise<void>;
}

export async function makeHarness(o: HarnessOptions = {}): Promise<Harness> {
  vi.useFakeTimers();
  const env = installFakeAudio({ sampleRate: SR, devices: WIRED, ...o.audio });
  const notes = o.notes ?? PH_A;
  const store = createMemoryClipStore();
  const audio = refAudio(notes);
  const durationSec = audio.length / SR;
  const info = await store.writeAudio(CLIP_ID, 'mix', floatToInt16(audio), SR);
  const base = makeFakeClip({ id: CLIP_ID });
  const phrase: PhraseRecord = {
    ...base.phrases[0],
    id: PHRASE_ID,
    index: 0,
    start: 0,
    end: durationSec,
    voicedStart: 0.15,
    voicedEnd: durationSec - 0.2,
    keyHint: null,
    rate: 1,
    srs: { rung: 0, dueAt: null, masteredAt: null },
    stats: { attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null },
    ...o.phrase,
  };
  const clip: ClipRecord = { ...base, durationSec, audio: { mix: info, vocal: null }, phrases: [phrase], audioMissing: false, ...o.clip };
  await store.putClip(clip);

  const prefs: TrainerPrefs = { defaultRate: 1, countInBeats: 3, startMode: 'auto', keepRecordings: false, ...o.prefs };
  let current = phrase;
  const session = {
    clip,
    phrase,
    store,
    settings: SETTINGS,
    recordAttempt:
      o.recordAttempt ??
      vi.fn(async (attempt: AttemptRecord, recording?: { pcm: Int16Array; sampleRate: number }) => {
        if (attempt.trust === 'invalid') return { saved: false, phrase: current, notice: 'invalid' };
        const history = await store.listAttempts({ phraseId: current.id, limit: 20 });
        const stored = { ...attempt, hasAudio: !!recording };
        await store.addAttempt(stored, recording);
        current = applyAttempt(current, history, stored);
        await store.putClip({ ...clip, phrases: [current] });
        return { saved: true, phrase: current, notice: null };
      }),
    getCalibration: vi.fn(async () => (await store.getMeta<Record<string, number>>(META.calibration)) ?? {}),
    setCalibration: vi.fn(async (route: string, ms: number) => {
      const cur = (await store.getMeta<Record<string, number>>(META.calibration)) ?? {};
      await store.setMeta(META.calibration, { ...cur, [route]: ms });
    }),
  } as unknown as Harness['session'];

  const reference = refAnalysisOf(notes);
  const engine = createPracticeEngine(session, {
    analyzePhrase: async () => reference,
    analyzeAttempt: async (samples, sr, opts) => analyzeTake(samples, sr, opts),
    prefs: () => prefs,
    ...o.deps,
  });

  const states: string[] = [];
  let voice: { body: Float32Array | null; startFrame: number | null; delay: number } | null = null;
  let pending: VoicePlan | null = null;
  const ctx = (): FakeAudioContext => env.contexts[env.contexts.length - 1];
  engine.subscribe(() => {
    const s = engine.getSnapshot();
    if (states[states.length - 1] !== s.state) states.push(s.state);
    if (s.state === 'countin' && voice && voice.startFrame === null) {
      const c = ctx();
      const guideSec = audio.length / SR / s.options.rate;
      const guideStart = c.currentTime + 0.45 + s.options.countInBeats * 0.6;
      const at = s.options.mode === 'sing-along' ? guideStart : guideStart + guideSec;
      voice.startFrame = Math.round((at + voice.delay) * c.sampleRate);
    }
  });
  env.setVoice((frame, n) => {
    if (!voice || !voice.body || voice.startFrame === null) return null;
    const off = frame - voice.startFrame;
    if (off + n <= 0 || off >= voice.body.length) return null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = off + i;
      if (j >= 0 && j < voice.body.length) out[i] = voice.body[j];
    }
    return out;
  });

  const tick = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);
  const h: Harness = {
    env,
    store,
    clip,
    phrase,
    session,
    engine,
    prefs,
    states,
    ctx,
    snap: () => engine.getSnapshot(),
    run: (sec) => runFor(env, sec, tick),
    async drive<T>(p: Promise<T>, maxSec = 60): Promise<T> {
      let done = false;
      let value: T | undefined;
      let error: unknown;
      let failed = false;
      p.then(
        (v) => {
          done = true;
          value = v;
        },
        (e: unknown) => {
          done = true;
          failed = true;
          error = e;
        },
      );
      for (let t = 0; t < maxSec / 0.05 && !done; t++) await h.run(0.05);
      if (!done) throw new Error(`still running after ${maxSec} s of audio time (state ${h.snap().state})`);
      if (failed) throw error;
      return value as T;
    },
    async until(cond, maxSec = 30) {
      for (let t = 0; t < maxSec / 0.05 && !cond(); t++) await h.run(0.05);
      if (!cond()) throw new Error(`condition not reached in ${maxSec} s (state ${h.snap().state})`);
    },
    plan(p) {
      pending = p;
      if (!p || p.silent) {
        voice = p ? { body: null, startFrame: null, delay: 0 } : null;
        return;
      }
      const shifted = (p.notes ?? notes).map((n) => ({ ...n, midi: n.midi + (p.key ?? 0) }));
      voice = {
        body: renderPhrase(shifted, p.tone ?? DEFAULT_TONE, { seed: p.seed ?? 77, leadIn: 0.15, tail: 0.2, noiseRms: 0 }),
        startFrame: null,
        delay: p.delaySec ?? 0,
      };
    },
    async take(p) {
      if (p !== undefined || pending === null) h.plan(p ?? {});
      else h.plan(pending);
      await h.drive(engine.sing());
      return h.snap();
    },
    attempts: () => store.listAttempts({ phraseId: PHRASE_ID }),
    async cleanup() {
      engine.dispose();
      await vi.advanceTimersByTimeAsync(5);
      env.restore();
      vi.useRealTimers();
    },
  };
  if (!o.noOpen) await h.until(() => h.snap().state !== 'preparing', 5);
  return h;
}
