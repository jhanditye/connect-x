// The ClipStore contract as data: a list of cases that any implementation must pass. It uses no test framework so the
// same cases run
//   - under Vitest against createMemoryClipStore() (and against IndexedDB through fake-indexeddb when that is installed),
//   - in real Chromium against openClipStore() (scripts/clip-store-browser/run.mjs).
// A case throws on failure. Keep it free of node-only and browser-only APIs.

import { int16ToFloat } from '../audio/pcm';
import type { AttemptRecord, ClipAudioInfo, ClipRecord } from '../types';
import { AudioMissingError, QuotaError, type ClipStore } from './clips';

export interface ContractEnv {
  /** A fresh, empty store. The environment closes and removes every store it made when `cleanup` runs. */
  make(): Promise<ClipStore>;
  /** A fresh store that accepts only about `bytes` of audio; omit when the environment cannot do that (those cases are skipped). */
  makeWithQuota?(bytes: number): Promise<ClipStore>;
  cleanup(): Promise<void>;
  /** Seconds of audio in the big-clip case (default 240, a four-minute song). */
  bigClipSec?: number;
  log?(line: string): void;
}

export interface ContractCase {
  name: string;
  /** Needs `env.makeWithQuota`. */
  needsQuota?: boolean;
  run(env: ContractEnv): Promise<void>;
}

export interface ContractResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  error?: string;
  ms: number;
}

// ---------------------------------------------------------------------------------------------
// Tiny assertions

export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

async function rejects(p: Promise<unknown>, test: (err: unknown) => boolean, msg: string): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    if (!test(err)) throw new Error(`${msg}: rejected with the wrong error (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)})`);
    return err;
  }
  throw new Error(`${msg}: expected a rejection`);
}

// ---------------------------------------------------------------------------------------------
// Builders

const SR = 44100;
const CHUNK = 10 * SR;

function clipRec(id: string, addedAt = '2026-10-08T00:00:00Z'): ClipRecord {
  return { id, addedAt, updatedAt: addedAt, title: id, phrases: [] } as unknown as ClipRecord;
}

function attempt(id: string, phraseId: string, at: number, clipId = 'c1'): AttemptRecord {
  return { id, clipId, phraseId, at, hasAudio: false } as unknown as AttemptRecord;
}

/** A deterministic tone as Int16, so expected samples can be recomputed anywhere without keeping a second copy. */
function tonePcm(frames: number, sampleRate = SR, freq = 220): Int16Array {
  const out = new Int16Array(frames);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < frames; i++) out[i] = Math.round(12000 * Math.sin(w * i));
  return out;
}

/** Incompressible audio (seeded noise): browsers count compressed bytes against the quota, and a tone shrinks to a fraction. */
function noisePcm(frames: number, seed = 1): Int16Array {
  const out = new Int16Array(frames);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < frames; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = (x & 0xffff) - 0x8000;
  }
  return out;
}

function expectSamples(got: Float32Array, pcm: Int16Array, from: number, to: number, msg: string): void {
  check(got.length === to - from, `${msg}: length ${got.length}, expected ${to - from}`);
  const want = int16ToFloat(pcm.subarray(from, to));
  for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) throw new Error(`${msg}: sample ${i} is ${got[i]}, expected ${want[i]}`);
}

const frameRange = (a: number, b: number, frames: number, sr = SR): [number, number] => [Math.max(0, Math.min(frames, Math.floor(a * sr))), Math.max(0, Math.min(frames, Math.ceil(b * sr)))];

async function withStore(env: ContractEnv, fn: (store: ClipStore) => Promise<void>): Promise<void> {
  const store = await env.make();
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The cases

export const CLIP_STORE_CASES: ContractCase[] = [
  {
    name: 'clips: put, get, replace, list newest first, results are copies',
    run: (env) =>
      withStore(env, async (s) => {
        eq(await s.listClips(), [], 'new store is empty');
        check((await s.getClip('nope')) === null, 'a missing clip is null');
        await s.putClip(clipRec('old', '2026-01-01T00:00:00Z'));
        await s.putClip(clipRec('new', '2026-06-01T00:00:00Z'));
        await s.putClip(clipRec('mid', '2026-03-01T00:00:00Z'));
        eq((await s.listClips()).map((c) => c.id), ['new', 'mid', 'old'], 'newest addedAt first');
        await s.putClip({ ...clipRec('mid', '2026-03-01T00:00:00Z'), title: 'renamed' });
        eq((await s.listClips()).length, 3, 'same id replaces');
        eq((await s.getClip('mid'))?.title, 'renamed', 'replaced title');
        const got = (await s.getClip('mid')) as ClipRecord;
        got.title = 'mutated';
        eq((await s.getClip('mid'))?.title, 'renamed', 'mutating a result does not change the store');
        await rejects(s.putClip({ ...clipRec('x'), id: '' }), () => true, 'a clip needs an id');
        await s.deleteClip('does-not-exist');
        eq((await s.listClips()).length, 3, 'deleting a missing clip changes nothing');
      }),
  },
  {
    name: 'audio: Int16 chunks round trip across chunk edges',
    run: (env) =>
      withStore(env, async (s) => {
        const pcm = tonePcm(37 * SR);
        const info = await s.writeAudio('c1', 'mix', pcm, SR);
        eq(info, { kind: 'mix', sampleRate: SR, frames: pcm.length, chunkFrames: CHUNK }, 'info');
        for (const [a, b] of [[0, 3], [9.5, 10.5], [10, 20], [8, 31.7], [36.9, 40], [12.345, 12.9], [0, 37]] as const) {
          const [from, to] = frameRange(a, b, pcm.length);
          expectSamples(await s.readAudio('c1', info, a, b), pcm, from, to, `read ${a}-${b}`);
        }
        eq((await s.usage()).audioBytes, pcm.byteLength, 'usage counts the stored bytes');
      }),
  },
  {
    name: 'audio: ranges are clamped, empty ranges are empty, junk ranges are refused',
    run: (env) =>
      withStore(env, async (s) => {
        const pcm = tonePcm(25 * SR);
        const info = await s.writeAudio('c1', 'mix', pcm, SR);
        expectSamples(await s.readAudio('c1', info, -5, 2), pcm, 0, 2 * SR, 'starts before the clip');
        expectSamples(await s.readAudio('c1', info, 23, 40), pcm, 23 * SR, pcm.length, 'ends after the clip');
        eq((await s.readAudio('c1', info, 30, 40)).length, 0, 'wholly after the clip');
        eq((await s.readAudio('c1', info, 12, 12)).length, 0, 'empty range');
        eq((await s.readAudio('c1', info, 12, 5)).length, 0, 'reversed range');
        await rejects(s.readAudio('c1', info, NaN, 5), (e) => e instanceof RangeError, 'NaN start');
        await rejects(s.readAudio('c1', info, 0, Infinity), (e) => e instanceof RangeError, 'infinite end');
        await rejects(s.readAudio('c1', { ...info, chunkFrames: 0 }, 0, 1), (e) => e instanceof RangeError, 'bad chunk size');
      }),
  },
  {
    name: 'audio: mix and vocal are separate; deleteAudio removes one kind',
    run: (env) =>
      withStore(env, async (s) => {
        const mix = tonePcm(12 * SR, SR, 220);
        const vocal = tonePcm(12 * SR, SR, 330);
        const mi = await s.writeAudio('c1', 'mix', mix, SR);
        const vi = await s.writeAudio('c1', 'vocal', vocal, SR);
        expectSamples(await s.readAudio('c1', mi, 1, 2), mix, SR, 2 * SR, 'mix');
        expectSamples(await s.readAudio('c1', vi, 1, 2), vocal, SR, 2 * SR, 'vocal');
        await s.deleteAudio('c1', 'vocal');
        await rejects(s.readAudio('c1', vi, 1, 2), (e) => e instanceof AudioMissingError, 'vocal is gone');
        expectSamples(await s.readAudio('c1', mi, 1, 2), mix, SR, 2 * SR, 'mix is untouched');
        await s.deleteAudio('c1', 'vocal'); // deleting again is fine
        await s.deleteAudio('nobody', 'mix');
        eq((await s.usage()).audioBytes, mix.byteLength, 'usage follows');
      }),
  },
  {
    name: 'audio: writing again replaces the old chunks and leaves none behind',
    run: (env) =>
      withStore(env, async (s) => {
        const long = tonePcm(25 * SR);
        const short = tonePcm(12 * SR, SR, 330);
        const oldInfo = await s.writeAudio('c1', 'mix', long, SR);
        const info = await s.writeAudio('c1', 'mix', short, SR);
        eq((await s.usage()).audioBytes, short.byteLength, 'only the new audio is stored');
        expectSamples(await s.readAudio('c1', info, 0, 12), short, 0, short.length, 'new audio');
        await rejects(s.readAudio('c1', oldInfo, 20, 24), (e) => e instanceof AudioMissingError, 'old chunks are gone');
      }),
  },
  {
    name: 'audio: missing audio rejects with AudioMissingError',
    run: (env) =>
      withStore(env, async (s) => {
        const info: ClipAudioInfo = { kind: 'mix', sampleRate: SR, frames: 5 * SR, chunkFrames: CHUNK };
        const err = await rejects(s.readAudio('ghost', info, 0, 2), (e) => e instanceof AudioMissingError, 'unknown clip');
        check(/Add the file again|missing/i.test((err as Error).message), 'the message names the fix');
      }),
  },
  {
    name: 'audio: invalid input is refused and empty audio is stored as nothing',
    run: (env) =>
      withStore(env, async (s) => {
        await rejects(s.writeAudio('c1', 'mix', tonePcm(100), 0), (e) => e instanceof RangeError, 'zero sample rate');
        await rejects(s.writeAudio('c1', 'mix', tonePcm(100), NaN), (e) => e instanceof RangeError, 'NaN sample rate');
        await rejects(s.writeAudio('', 'mix', tonePcm(100), SR), () => true, 'empty clip id');
        await rejects(s.writeAudio('c1', 'stem' as 'mix', tonePcm(100), SR), () => true, 'unknown kind');
        eq((await s.usage()).audioBytes, 0, 'nothing was stored');
        const info = await s.writeAudio('c1', 'mix', new Int16Array(0), SR);
        eq(info.frames, 0, 'empty audio has no frames');
        eq((await s.readAudio('c1', info, 0, 1)).length, 0, 'empty audio reads as empty');
        eq((await s.usage()).audioBytes, 0, 'and takes no bytes');
      }),
  },
  {
    name: 'audio: a four-minute clip is chunked and any 12 s phrase is read back exactly',
    run: async (env) => {
      const sec = env.bigClipSec ?? 240;
      await withStore(env, async (s) => {
        const pcm = tonePcm(sec * SR);
        const t0 = Date.now();
        const info = await s.writeAudio('big', 'mix', pcm, SR);
        const writeMs = Date.now() - t0;
        eq(info.chunkFrames, CHUNK, 'chunk size');
        eq(info.frames, pcm.length, 'frames');
        eq((await s.usage()).audioBytes, pcm.byteLength, `${(pcm.byteLength / 1048576).toFixed(1)} MB stored`);
        const reads: number[] = [];
        for (const start of [0, 7.3, 9.9, 10, 61.25, 118.4, 179.99, sec - 12]) {
          const t1 = Date.now();
          const got = await s.readAudio('big', info, start, start + 12);
          reads.push(Date.now() - t1);
          const [from, to] = frameRange(start, start + 12, pcm.length);
          expectSamples(got, pcm, from, to, `phrase at ${start} s`);
        }
        env.log?.(`${sec} s clip (${(pcm.byteLength / 1048576).toFixed(1)} MB): write ${writeMs} ms; 12 s phrase reads ${reads.join('/')} ms`);
        await s.deleteClip('big');
        eq((await s.usage()).audioBytes, 0, 'deleting the clip frees the audio');
      });
    },
  },
  {
    name: 'attempts: newest first, filters, limit, ties and copies',
    run: (env) =>
      withStore(env, async (s) => {
        await s.addAttempt(attempt('a1', 'p1', 1000));
        await s.addAttempt(attempt('a2', 'p1', 3000));
        await s.addAttempt(attempt('a3', 'p1', 2000));
        await s.addAttempt(attempt('a4', 'p2', 4000));
        await s.addAttempt(attempt('b1', 'p3', 5000, 'c2'));
        await s.addAttempt(attempt('t1', 'p9', 7000));
        await s.addAttempt(attempt('t2', 'p9', 7000));
        eq((await s.listAttempts({ phraseId: 'p1' })).map((a) => a.id), ['a2', 'a3', 'a1'], 'by phrase, newest first');
        eq((await s.listAttempts({ phraseId: 'p1', limit: 2 })).map((a) => a.id), ['a2', 'a3'], 'limit');
        eq((await s.listAttempts({ clipId: 'c2' })).map((a) => a.id), ['b1'], 'by clip');
        eq((await s.listAttempts({ clipId: 'c1' })).map((a) => a.id), ['t2', 't1', 'a4', 'a2', 'a3', 'a1'], 'by clip, ties by larger id first');
        eq((await s.listAttempts({ phraseId: 'p3', clipId: 'c1' })).length, 0, 'both ids must match');
        eq((await s.listAttempts({ phraseId: 'p3', clipId: 'c2' })).map((a) => a.id), ['b1'], 'both ids match');
        eq((await s.listAttempts({})).length, 7, 'no filter lists everything');
        eq((await s.listAttempts({ limit: 3 })).map((a) => a.id), ['t2', 't1', 'b1'], 'no filter with a limit');
        eq((await s.listAttempts({ limit: 0 })).length, 7, 'a limit of 0 means no limit');
        eq((await s.listAttempts({ phraseId: 'nope' })).length, 0, 'unknown phrase');
        const first = (await s.listAttempts({ phraseId: 'p2' }))[0];
        first.at = 1;
        eq((await s.listAttempts({ phraseId: 'p2' }))[0].at, 4000, 'results are copies');
        await rejects(s.addAttempt({ ...attempt('x', 'p1', 1), id: '' }), () => true, 'an attempt needs an id');
        await rejects(s.addAttempt({ ...attempt('x', 'p1', NaN) }), () => true, 'an attempt needs a time');
      }),
  },
  {
    name: 'attempts: adding the same id replaces the attempt',
    run: (env) =>
      withStore(env, async (s) => {
        await s.addAttempt(attempt('a1', 'p1', 1000), { pcm: new Int16Array(500), sampleRate: SR });
        await s.addAttempt({ ...attempt('a1', 'p1', 1000), wrongNotes: 2 } as AttemptRecord);
        const list = await s.listAttempts({ phraseId: 'p1' });
        eq(list.length, 1, 'one attempt');
        eq((list[0] as AttemptRecord).wrongNotes, 2, 'new content');
        eq(list[0].hasAudio, false, 'hasAudio follows the audio argument');
        check((await s.readAttemptAudio('a1')) === null, 'the old recording is gone');
        eq((await s.usage()).audioBytes, 0, 'and takes no space');
      }),
  },
  {
    name: 'attempts: recent attempts per phrase',
    run: (env) =>
      withStore(env, async (s) => {
        for (let i = 0; i < 7; i++) await s.addAttempt(attempt(`p1-${i}`, 'p1', 1000 + i));
        for (let i = 0; i < 2; i++) await s.addAttempt(attempt(`p2-${i}`, 'p2', 5000 + i));
        await s.addAttempt(attempt('p3-0', 'p3', 100));
        const recent = await s.listRecentAttempts(3);
        const byPhrase = (p: string) => recent.filter((a) => a.phraseId === p).map((a) => a.id);
        eq(byPhrase('p1'), ['p1-6', 'p1-5', 'p1-4'], 'newest three of p1, newest first');
        eq(byPhrase('p2'), ['p2-1', 'p2-0'], 'p2 has only two');
        eq(byPhrase('p3'), ['p3-0'], 'p3');
        eq(recent.length, 6, 'nothing else');
        eq((await s.listRecentAttempts(0)).length, 0, 'zero asks for nothing');
        eq((await s.listRecentAttempts(100)).length, 10, 'a large count returns all');
      }),
  },
  {
    name: 'attempts: a recording is optional and read back exactly',
    run: (env) =>
      withStore(env, async (s) => {
        const pcm = tonePcm(3000, 22050, 440);
        await s.addAttempt(attempt('a0', 'p1', 1000), { pcm, sampleRate: 22050 });
        await s.addAttempt(attempt('a1', 'p1', 2000));
        const back = await s.readAttemptAudio('a0');
        check(back !== null && back.sampleRate === 22050 && back.pcm.length === pcm.length, 'recording came back');
        for (let i = 0; i < pcm.length; i += 97) if (back.pcm[i] !== pcm[i]) throw new Error(`recording sample ${i} differs`);
        check((await s.readAttemptAudio('a1')) === null, 'an attempt without a recording has none');
        check((await s.readAttemptAudio('missing')) === null, 'an unknown attempt has none');
        eq((await s.listAttempts({ phraseId: 'p1' })).map((a) => a.hasAudio), [false, true], 'hasAudio matches the recording');
        eq((await s.usage()).audioBytes, pcm.byteLength, 'recordings count in usage');
        pcm[0] = 123;
        eq((await s.readAttemptAudio('a0'))?.pcm[0] === 123, false, 'the store kept its own copy');
      }),
  },
  {
    name: 'attempts: trimming keeps the newest recordings per phrase and clears hasAudio on the rest',
    run: (env) =>
      withStore(env, async (s) => {
        const rec = { pcm: new Int16Array(100), sampleRate: SR };
        for (let i = 0; i < 4; i++) await s.addAttempt(attempt(`p1-${i}`, 'p1', 1000 + i), rec);
        for (let i = 0; i < 2; i++) await s.addAttempt(attempt(`p2-${i}`, 'p2', 2000 + i), rec);
        await s.addAttempt(attempt('p2-plain', 'p2', 2500));
        eq(await s.trimAttemptAudio(2), 2, 'two recordings of p1 are dropped');
        check((await s.readAttemptAudio('p1-0')) === null && (await s.readAttemptAudio('p1-1')) === null, 'oldest p1 recordings gone');
        check((await s.readAttemptAudio('p1-2')) !== null && (await s.readAttemptAudio('p1-3')) !== null, 'newest p1 recordings kept');
        eq((await s.listAttempts({ phraseId: 'p1' })).map((a) => [a.id, a.hasAudio]), [['p1-3', true], ['p1-2', true], ['p1-1', false], ['p1-0', false]], 'records stay, flags follow');
        check((await s.readAttemptAudio('p2-0')) !== null, 'p2 is within its limit');
        eq(await s.trimAttemptAudio(2), 0, 'trimming again does nothing');
        eq(await s.trimAttemptAudio(0), 4, 'zero keeps none');
        eq((await s.usage()).audioBytes, 0, 'all recordings are gone');
        eq((await s.listAttempts({})).length, 7, 'no attempt record was lost');
      }),
  },
  {
    name: 'attempts: deleteAttempts by phrase, clip, keepLast and for everything',
    run: (env) =>
      withStore(env, async (s) => {
        const rec = { pcm: new Int16Array(100), sampleRate: SR };
        const seed = async () => {
          await s.clearAll();
          for (let i = 0; i < 5; i++) await s.addAttempt(attempt(`p1-${i}`, 'p1', 1000 + i), i % 2 === 0 ? rec : undefined);
          await s.addAttempt(attempt('p2-0', 'p2', 3000));
          await s.addAttempt(attempt('o-0', 'po', 4000, 'c2'));
        };
        await seed();
        eq(await s.deleteAttempts({ phraseId: 'p1', keepLast: 2 }), 3, 'keepLast leaves the newest two');
        eq((await s.listAttempts({ phraseId: 'p1' })).map((a) => a.id), ['p1-4', 'p1-3'], 'the newest two stay');
        eq((await s.usage()).audioBytes, rec.pcm.byteLength, 'deleted attempts take their recordings along; p1-4 keeps its own');
        await seed();
        eq(await s.deleteAttempts({ phraseId: 'p1' }), 5, 'a whole phrase');
        eq((await s.usage()).audioBytes, 0, 'recordings follow');
        eq((await s.listAttempts({})).length, 2, 'other phrases stay');
        await seed();
        eq(await s.deleteAttempts({ clipId: 'c1' }), 6, 'a whole clip');
        eq((await s.listAttempts({})).map((a) => a.id), ['o-0'], 'only the other clip is left');
        await seed();
        eq(await s.deleteAttempts({ clipId: 'c1', keepLast: 1 }), 5, 'keepLast per clip');
        eq((await s.listAttempts({ clipId: 'c1' })).map((a) => a.id), ['p2-0'], 'the newest of the clip stays');
        await seed();
        eq(await s.deleteAttempts({}), 7, 'no filter deletes every attempt');
        eq((await s.listAttempts({})).length, 0, 'none left');
        eq(await s.deleteAttempts({ phraseId: 'nothing' }), 0, 'nothing matched');
      }),
  },
  {
    name: 'cascade: deleting a clip removes its audio, attempts and recordings in one go and touches nothing else',
    run: (env) =>
      withStore(env, async (s) => {
        const rec = { pcm: new Int16Array(100), sampleRate: SR };
        const pcm = tonePcm(15 * SR);
        const infos: Record<string, ClipAudioInfo> = {};
        for (const id of ['c1', 'c10', 'c1|x', 'c']) {
          await s.putClip(clipRec(id));
          infos[id] = await s.writeAudio(id, 'mix', pcm, SR);
          await s.writeAudio(id, 'vocal', pcm, SR);
          await s.addAttempt(attempt(`${id}-a1`, `${id}-p1`, 1000, id), rec);
          await s.addAttempt(attempt(`${id}-a2`, `${id}-p1`, 2000, id));
        }
        const before = await s.usage();
        eq(before.clips, 4, 'four clips');
        await s.deleteClip('c1');
        check((await s.getClip('c1')) === null, 'clip gone');
        eq((await s.listAttempts({ clipId: 'c1' })).length, 0, 'attempts gone');
        check((await s.readAttemptAudio('c1-a1')) === null, 'recording gone');
        await rejects(s.readAudio('c1', infos.c1, 0, 1), (e) => e instanceof AudioMissingError, 'mix gone');
        await rejects(s.readAudio('c1', { ...infos.c1, kind: 'vocal' }, 0, 1), (e) => e instanceof AudioMissingError, 'vocal gone');
        const after = await s.usage();
        eq([after.clips, after.attempts], [3, 6], 'the others are all still there');
        eq(after.audioBytes, before.audioBytes - (2 * pcm.byteLength + rec.pcm.byteLength), 'exactly this clip\'s bytes were freed');
        for (const id of ['c10', 'c1|x', 'c']) {
          check((await s.getClip(id)) !== null, `${id} still exists`);
          expectSamples(await s.readAudio(id, infos[id], 11, 12), pcm, 11 * SR, 12 * SR, `${id} audio`);
          eq((await s.listAttempts({ clipId: id })).length, 2, `${id} attempts`);
          check((await s.readAttemptAudio(`${id}-a1`)) !== null, `${id} recording`);
        }
      }),
  },
  {
    name: 'orphans: pruneOrphanAudio removes chunks that have no clip record and nothing else',
    run: (env) =>
      withStore(env, async (s) => {
        const pcm = tonePcm(25 * SR); // three chunks
        const rec = { pcm: new Int16Array(100), sampleRate: SR };
        await s.putClip(clipRec('keep'));
        const kept = await s.writeAudio('keep', 'mix', pcm, SR);
        await s.writeAudio('keep', 'vocal', pcm, SR);
        await s.addAttempt(attempt('k-a1', 'k-p1', 1, 'keep'), rec);
        // An import that died after its audio and before its clip record; ids that share a prefix with a real clip.
        await s.writeAudio('lost', 'mix', pcm, SR);
        await s.writeAudio('lost', 'vocal', pcm, SR);
        await s.writeAudio('keep2', 'mix', tonePcm(SR), SR);
        const before = await s.usage();
        eq(await s.pruneOrphanAudio(), 2, 'two clips\' worth of orphan chunks');
        const after = await s.usage();
        eq(after.audioBytes, before.audioBytes - (2 * pcm.byteLength + tonePcm(SR).byteLength), 'exactly the orphans\' bytes were freed');
        eq([after.clips, after.attempts], [1, 1], 'records are untouched');
        expectSamples(await s.readAudio('keep', kept, 11, 12), pcm, 11 * SR, 12 * SR, 'the real clip\'s audio');
        check((await s.readAttemptAudio('k-a1')) !== null, 'the real recording');
        await rejects(s.readAudio('lost', { ...kept }, 0, 1), (e) => e instanceof AudioMissingError, 'orphan gone');
        eq(await s.pruneOrphanAudio(), 0, 'nothing left to remove');
      }),
  },
  {
    name: 'meta: values round trip, missing keys are null, values are copies',
    run: (env) =>
      withStore(env, async (s) => {
        check((await s.getMeta('nope')) === null, 'missing key');
        await s.setMeta('calibration', { wired: 90, bluetooth: 210 });
        eq(await s.getMeta('calibration'), { wired: 90, bluetooth: 210 }, 'object');
        await s.setMeta('lastExportAt', '2026-10-08T10:00:00Z');
        eq(await s.getMeta('lastExportAt'), '2026-10-08T10:00:00Z', 'string');
        await s.setMeta('calibration', { wired: 80 });
        eq(await s.getMeta('calibration'), { wired: 80 }, 'overwrite');
        const got = (await s.getMeta<Record<string, number>>('calibration')) as Record<string, number>;
        got.wired = 1;
        eq(await s.getMeta('calibration'), { wired: 80 }, 'a result is a copy');
        await rejects(s.setMeta('', 1), () => true, 'a key is required');
      }),
  },
  {
    name: 'usage: counts clips and attempts and adds up the audio bytes exactly',
    run: (env) =>
      withStore(env, async (s) => {
        eq(await s.usage(), { clips: 0, attempts: 0, audioBytes: 0 }, 'empty');
        await s.putClip(clipRec('c1'));
        await s.putClip(clipRec('c2'));
        await s.writeAudio('c1', 'mix', tonePcm(23 * SR), SR); // 3 chunks, the last one short
        await s.writeAudio('c2', 'vocal', tonePcm(1000), SR);
        await s.addAttempt(attempt('a1', 'p1', 1), { pcm: new Int16Array(333), sampleRate: SR });
        await s.addAttempt(attempt('a2', 'p1', 2));
        eq(await s.usage(), { clips: 2, attempts: 2, audioBytes: 2 * (23 * SR + 1000 + 333) }, 'totals');
      }),
  },
  {
    name: 'clearAll empties every store including meta',
    run: (env) =>
      withStore(env, async (s) => {
        await s.putClip(clipRec('c1'));
        await s.writeAudio('c1', 'mix', tonePcm(SR), SR);
        await s.addAttempt(attempt('a1', 'p1', 1), { pcm: new Int16Array(10), sampleRate: SR });
        await s.setMeta('k', 1);
        await s.clearAll();
        eq(await s.usage(), { clips: 0, attempts: 0, audioBytes: 0 }, 'usage');
        check((await s.getMeta('k')) === null, 'meta');
        eq((await s.listClips()).length, 0, 'clips');
        await s.putClip(clipRec('c2')); // still usable afterwards
        eq((await s.listClips()).length, 1, 'usable after clearAll');
      }),
  },
  {
    name: 'concurrency: parallel writes to different clips do not interfere',
    run: (env) =>
      withStore(env, async (s) => {
        const ids = ['x', 'y', 'z'];
        const pcms = ids.map((_, i) => tonePcm((18 + i) * SR, SR, 200 + 50 * i));
        const infos = await Promise.all(
          ids.map(async (id, i) => {
            await s.putClip(clipRec(id));
            const info = await s.writeAudio(id, 'mix', pcms[i], SR);
            await s.addAttempt(attempt(`${id}-a`, `${id}-p`, 10 + i, id), { pcm: new Int16Array(64), sampleRate: SR });
            return info;
          }),
        );
        for (let i = 0; i < ids.length; i++) {
          expectSamples(await s.readAudio(ids[i], infos[i], 12, 13), pcms[i], 12 * SR, 13 * SR, `${ids[i]} audio`);
          eq((await s.listAttempts({ clipId: ids[i] })).length, 1, `${ids[i]} attempts`);
        }
        eq((await s.usage()).audioBytes, pcms.reduce((n, p) => n + p.byteLength, 0) + 3 * 128, 'usage');
      }),
  },
  {
    name: 'concurrency: two writes of the same audio at once leave one complete version',
    run: (env) =>
      withStore(env, async (s) => {
        const a = tonePcm(25 * SR, SR, 220);
        const b = tonePcm(14 * SR, SR, 330);
        const [ia, ib] = await Promise.all([s.writeAudio('c1', 'mix', a, SR), s.writeAudio('c1', 'mix', b, SR)]);
        const bytes = (await s.usage()).audioBytes;
        const winner = bytes === a.byteLength ? { pcm: a, info: ia } : bytes === b.byteLength ? { pcm: b, info: ib } : null;
        check(winner !== null, `the store holds exactly one of the two versions (${bytes} bytes)`);
        expectSamples(await s.readAudio('c1', winner.info, 0, 13), winner.pcm, 0, 13 * SR, 'the winner reads back whole');
      }),
  },
  {
    name: 'concurrency: many attempts and meta writes at once are all kept',
    run: (env) =>
      withStore(env, async (s) => {
        await Promise.all(Array.from({ length: 40 }, (_, i) => s.addAttempt(attempt(`a${i}`, `p${i % 4}`, 1000 + i), i % 5 === 0 ? { pcm: new Int16Array(10), sampleRate: SR } : undefined)));
        await Promise.all(Array.from({ length: 10 }, (_, i) => s.setMeta(`k${i}`, i)));
        eq((await s.listAttempts({})).length, 40, 'attempts');
        for (let p = 0; p < 4; p++) eq((await s.listAttempts({ phraseId: `p${p}` })).length, 10, `phrase p${p}`);
        eq((await s.usage()).audioBytes, 8 * 20, 'recordings');
        eq(await s.getMeta('k7'), 7, 'meta');
        await Promise.all([s.deleteAttempts({ phraseId: 'p0' }), s.deleteAttempts({ phraseId: 'p1' }), s.trimAttemptAudio(1)]);
        eq((await s.listAttempts({})).length, 20, 'after parallel deletes');
      }),
  },
  {
    name: 'quota: a refused audio write reports QuotaError, keeps the old audio and leaves no half-written clip',
    needsQuota: true,
    run: async (env) => {
      check(env.makeWithQuota, 'this environment cannot limit the quota');
      const s = await env.makeWithQuota(6 * 1024 * 1024);
      try {
        const small = noisePcm(20 * SR); // 1.7 MB
        const info = await s.writeAudio('c1', 'mix', small, SR);
        const huge = noisePcm(150 * SR, 2); // 13 MB: more than the quota
        const err = await rejects(s.writeAudio('c1', 'mix', huge, SR), (e) => e instanceof QuotaError, 'writing more than fits');
        check((err as QuotaError).needBytes === huge.byteLength, 'the error says how much was needed');
        expectSamples(await s.readAudio('c1', info, 0, 20), small, 0, small.length, 'the earlier audio is intact');
        eq((await s.usage()).audioBytes, small.byteLength, 'no partial chunks were kept');
        await rejects(s.writeAudio('c2', 'mix', huge, SR), (e) => e instanceof QuotaError, 'a new clip that does not fit');
        eq((await s.usage()).audioBytes, small.byteLength, 'still no partial chunks');
        await s.putClip(clipRec('c3')); // small writes still work after a refusal
        eq((await s.listClips()).length, 1, 'the store still works');
      } finally {
        s.close();
      }
    },
  },
  {
    name: 'quota: a refused attempt recording stores neither the attempt nor the recording',
    needsQuota: true,
    run: async (env) => {
      check(env.makeWithQuota, 'this environment cannot limit the quota');
      const s = await env.makeWithQuota(2 * 1024 * 1024);
      try {
        await s.addAttempt(attempt('a0', 'p1', 1)); // metadata alone always fits
        await rejects(s.addAttempt(attempt('a1', 'p1', 2), { pcm: noisePcm(60 * SR, 3), sampleRate: SR }), (e) => e instanceof QuotaError, 'a recording that does not fit');
        eq((await s.listAttempts({})).map((a) => a.id), ['a0'], 'the refused attempt was not stored');
        check((await s.readAttemptAudio('a1')) === null, 'and has no recording');
      } finally {
        s.close();
      }
    },
  },
];

/** Runs the cases (all by default, or those `only` accepts), one fresh store each, and reports instead of throwing. */
export async function runClipStoreContract(env: ContractEnv, onResult?: (r: ContractResult) => void, only: (c: ContractCase) => boolean = () => true): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const c of CLIP_STORE_CASES.filter(only)) {
    const t0 = Date.now();
    let result: ContractResult;
    if (c.needsQuota && !env.makeWithQuota) {
      result = { name: c.name, status: 'skip', ms: 0 };
    } else {
      try {
        await c.run(env);
        result = { name: c.name, status: 'pass', ms: Date.now() - t0 };
      } catch (err) {
        result = { name: c.name, status: 'fail', error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
      } finally {
        await env.cleanup().catch(() => undefined);
      }
    }
    results.push(result);
    onResult?.(result);
  }
  return results;
}
