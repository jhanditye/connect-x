import { afterEach, describe, expect, it, vi } from 'vitest';
import { floatToInt16 } from '../audio/pcm';
import type { AttemptRecord, ClipRecord } from '../types';
import { CLIP_STORE_CASES, runClipStoreContract, type ContractEnv } from './clipStoreContract';
import {
  AudioMissingError,
  createMemoryClipStore,
  createReconnecting,
  DB_NAME,
  DB_VERSION,
  isQuotaError,
  isStaleConnection,
  MIGRATIONS,
  openClipStore,
  openClipStoreWithFallback,
  QuotaError,
  StoreUnavailableError,
  type ClipStore,
} from './clips';

const SR = 44100;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// The shared contract, against the memory store

function memoryEnv(): ContractEnv {
  return {
    async make() {
      return createMemoryClipStore();
    },
    async makeWithQuota(bytes) {
      return createMemoryClipStore({ quotaBytes: bytes });
    },
    async cleanup() {},
  };
}

describe('ClipStore contract: memory store', () => {
  const env = memoryEnv();
  for (const c of CLIP_STORE_CASES) it(c.name, () => c.run(env));

  it('the runner reports a failing case instead of throwing', async () => {
    const failing: ContractEnv = {
      ...memoryEnv(),
      async make() {
        throw new Error('no store today');
      },
    };
    const results = await runClipStoreContract(failing);
    expect(results.some((r) => r.status === 'fail' && /no store today/.test(r.error ?? ''))).toBe(true);
    const noQuota = await runClipStoreContract({ ...memoryEnv(), makeWithQuota: undefined });
    expect(noQuota.filter((r) => r.status === 'skip')).toHaveLength(CLIP_STORE_CASES.filter((c) => c.needsQuota).length);
    expect(noQuota.filter((r) => r.status === 'fail')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The same contract against IndexedDB, when fake-indexeddb happens to be installed (it is not a dependency of this
// project). The real IndexedDB run is scripts/clip-store-browser/run.mjs (Chromium).

async function loadFakeIndexedDb(): Promise<boolean> {
  try {
    const name = 'fake-indexeddb/auto';
    await import(/* @vite-ignore */ name);
    return typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

const hasFakeIdb = await loadFakeIndexedDb();

describe.skipIf(!hasFakeIdb)('ClipStore contract: IndexedDB through fake-indexeddb', () => {
  let n = 0;
  const open: ClipStore[] = [];
  const names: string[] = [];
  const env: ContractEnv = {
    async make() {
      const name = `${DB_NAME}-fake-${++n}`;
      names.push(name);
      const s = await openClipStore({ name });
      open.push(s);
      return s;
    },
    async cleanup() {
      open.splice(0).forEach((s) => s.close());
      for (const name of names.splice(0)) indexedDB.deleteDatabase(name);
    },
    // A smaller clip keeps the simulated database quick.
    bigClipSec: 60,
  };
  afterEach(() => env.cleanup());
  for (const c of CLIP_STORE_CASES.filter((x) => !x.needsQuota)) it(c.name, () => c.run(env));
});

// ---------------------------------------------------------------------------------------------
// Memory behaviour that matters on a phone

describe('memory use', () => {
  const tone = (frames: number): Int16Array => floatToInt16(Float32Array.from({ length: frames }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR)));

  // Checked by what the store reports and hands back (chunk counts, bytes written, the size of the returned buffer), never by the
  // process heap: arrayBuffers moves with garbage collection and with every other test file running in the same process.
  it('a four-minute clip is stored once, in 10 s chunks, and a phrase read allocates the phrase, not the clip', async () => {
    const s = createMemoryClipStore();
    const pcm = tone(240 * SR); // 21 MB
    const info = await s.writeAudio('big', 'mix', pcm, SR);
    expect(info).toMatchObject({ kind: 'mix', sampleRate: SR, frames: 240 * SR, chunkFrames: 10 * SR });
    expect(Math.ceil(info.frames / info.chunkFrames)).toBe(24);
    // Stored once: the bytes it accounts for are the clip's own, not a second copy or a Float32 expansion (which would be double).
    expect((await s.usage()).audioBytes).toBe(pcm.byteLength);

    const phrase = await s.readAudio('big', info, 100, 112);
    expect(phrase.length).toBe(12 * SR);
    // The result is its own small buffer (12 s as floats, about 2 MB), not a view into something clip-sized.
    expect(phrase.buffer.byteLength).toBe(phrase.byteLength);
    expect(phrase.byteLength).toBeLessThan(6 * 1024 * 1024);
    expect(phrase.byteLength).toBeLessThan(pcm.byteLength / 4);
    // It is the right part of the clip.
    const again = await s.readAudio('big', info, 100, 100.001);
    expect(again[0]).toBeCloseTo(phrase[0], 6);
  }, 60000);

  it('keeps its own copy of what it was given, and hands out copies it does not share', async () => {
    const s = createMemoryClipStore();
    const pcm = tone(12 * SR);
    const info = await s.writeAudio('c', 'mix', pcm, SR);
    const first = await s.readAudio('c', info, 1, 2);
    const expected = Float32Array.from(first);
    pcm.fill(0); // the caller reuses its buffer
    first.fill(0.5); // and scribbles on what it was handed
    const second = await s.readAudio('c', info, 1, 2);
    expect(Array.from(second.subarray(0, 50))).toEqual(Array.from(expected.subarray(0, 50)));
  });
});

// ---------------------------------------------------------------------------------------------
// Memory store specifics

describe('memory store quota', () => {
  it('counts a replacement against the room it frees, not on top of it', async () => {
    const pcm = new Int16Array(SR * 10); // 882 KB
    const s = createMemoryClipStore({ quotaBytes: pcm.byteLength * 1.2 });
    await s.writeAudio('c1', 'mix', pcm, SR);
    await s.writeAudio('c1', 'mix', pcm, SR); // same size again: fits because the old copy goes
    await expect(s.writeAudio('c2', 'mix', pcm, SR)).rejects.toBeInstanceOf(QuotaError);
    expect((await s.usage()).audioBytes).toBe(pcm.byteLength);
  });

  it('is unlimited by default', async () => {
    const s = createMemoryClipStore();
    await s.writeAudio('c1', 'mix', new Int16Array(SR * 30), SR);
    expect((await s.usage()).audioBytes).toBe(SR * 30 * 2);
  });

  it('reports a missing clip\'s audio as AudioMissingError with a message that names the fix', async () => {
    const s = createMemoryClipStore();
    const err = await s.readAudio('x', { kind: 'mix', sampleRate: SR, frames: SR, chunkFrames: 10 * SR }, 0, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudioMissingError);
    expect((err as Error).message).toMatch(/Add the file again/);
  });
});

// ---------------------------------------------------------------------------------------------
// Opening IndexedDB: failures must come out as StoreUnavailableError and fall back to memory

interface FakeRequest {
  onsuccess?: () => void;
  onerror?: (e?: unknown) => void;
  onblocked?: () => void;
  onupgradeneeded?: (e: { oldVersion: number; newVersion: number | null }) => void;
  result?: unknown;
  error?: unknown;
  transaction?: unknown;
}

function stubIndexedDB(script: (req: FakeRequest, name: string, version: number) => void, deleteScript?: (req: FakeRequest) => void) {
  const factory = {
    open: vi.fn((name: string, version: number) => {
      const req: FakeRequest = {};
      setTimeout(() => script(req, name, version), 0);
      return req;
    }),
    deleteDatabase: vi.fn(() => {
      const req: FakeRequest = {};
      setTimeout(() => deleteScript?.(req), 0);
      return req;
    }),
  };
  vi.stubGlobal('indexedDB', factory);
  return factory;
}

const fakeDb = (stores: string[] = []) => ({
  objectStoreNames: { contains: (n: string) => stores.includes(n) },
  close: vi.fn(),
  createObjectStore: vi.fn(),
});

describe('openClipStore failures', () => {
  it('rejects with StoreUnavailableError when the browser has no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const err = await openClipStore().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toMatch(/does not offer IndexedDB/);
  });

  it('rejects, with a plain message, when even reading indexedDB throws (a sandboxed frame such as an artifact viewer)', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException("Failed to read the 'indexedDB' property from 'Window': The document is sandboxed", 'SecurityError');
      },
    });
    try {
      const err = await openClipStore().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreUnavailableError);
      expect((err as Error).message).toMatch(/blocking IndexedDB/);
      const r = await openClipStoreWithFallback();
      expect(r.store.kind).toBe('memory');
      expect(r.fallback?.reason).toMatch(/blocking IndexedDB/);
    } finally {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  it('rejects when open() throws (private mode, sandboxed frame)', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const err = await openClipStore().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toMatch(/blocking IndexedDB/);
  });

  it('says so when the library was written by a newer app', async () => {
    stubIndexedDB((req) => {
      req.error = { name: 'VersionError', message: 'less than existing' };
      req.onerror?.();
    });
    const err = await openClipStore().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toMatch(/newer version of Mimic/);
  });

  it('passes on the browser\'s reason for any other open error', async () => {
    stubIndexedDB((req) => {
      req.error = { name: 'UnknownError', message: 'backing store unavailable' };
      req.onerror?.();
    });
    const err = await openClipStore().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/backing store unavailable/);
  });

  it('aborts and reports a migration that throws', async () => {
    const abort = vi.fn();
    stubIndexedDB((req) => {
      req.result = fakeDb();
      req.transaction = { abort };
      req.onupgradeneeded?.({ oldVersion: 0, newVersion: 1 });
    });
    const err = await openClipStore({ migrations: { 1: () => { throw new Error('boom'); } } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toMatch(/could not be upgraded: boom/);
    expect(abort).toHaveBeenCalled();
  });

  it('refuses an upgrade that has no migration step', async () => {
    stubIndexedDB((req) => {
      req.result = fakeDb();
      req.transaction = { abort: vi.fn() };
      req.onupgradeneeded?.({ oldVersion: 1, newVersion: 3 });
    });
    const err = await openClipStore({ version: 3, migrations: { 1: () => undefined } }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/No migration for database version 2/);
  });

  it('refuses a database that is missing some of its stores and closes the connection', async () => {
    const db = fakeDb(['clips', 'audio']);
    stubIndexedDB((req) => {
      req.result = db;
      req.onsuccess?.();
    });
    const err = await openClipStore().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toMatch(/incomplete/);
    expect(db.close).toHaveBeenCalled();
  });

  it('reports an empty database that cannot be recreated', async () => {
    const db = fakeDb([]);
    const factory = stubIndexedDB(
      (req) => {
        req.result = db;
        req.onsuccess?.();
      },
      (req) => req.onerror?.(),
    );
    const err = await openClipStore().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/damaged/);
    expect(factory.deleteDatabase).toHaveBeenCalledWith(DB_NAME);
  });

  it('stops waiting for another tab after a while, and closes a connection that arrives late', async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    let late: FakeRequest | null = null;
    stubIndexedDB((req) => {
      late = req;
      req.onblocked?.();
    });
    const pending = openClipStore({ blockedTimeoutMs: 1500 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1600);
    const err = await pending;
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toMatch(/Another tab/);
    (late as FakeRequest | null)!.result = db;
    (late as FakeRequest | null)!.onsuccess?.();
    expect(db.close).toHaveBeenCalled();
  });

  it('creates the five stores and the indexes the store relies on', () => {
    const created: string[] = [];
    const indexes: string[] = [];
    const db = {
      createObjectStore: (name: string) => {
        created.push(name);
        return { createIndex: (index: string) => indexes.push(`${name}.${index}`) };
      },
    };
    MIGRATIONS[1](db as unknown as IDBDatabase, {} as IDBTransaction, 0);
    expect(created).toEqual(['clips', 'audio', 'attempts', 'attemptAudio', 'meta']);
    expect(indexes).toEqual(['audio.byClip', 'audio.byBytes', 'attempts.byPhrase', 'attempts.byClip', 'attemptAudio.byPhrase', 'attemptAudio.byBytes']);
    expect(DB_VERSION).toBe(1);
    expect(Object.keys(MIGRATIONS).map(Number)).toEqual(Array.from({ length: DB_VERSION }, (_, i) => i + 1));
  });
});

describe('openClipStoreWithFallback', () => {
  it('uses the opened store when opening works', async () => {
    const real = createMemoryClipStore();
    const r = await openClipStoreWithFallback(async () => real);
    expect(r.store).toBe(real);
    expect(r.fallback).toBeNull();
  });

  it('falls back to a working memory store and says why when opening throws', async () => {
    const r = await openClipStoreWithFallback(() => Promise.reject(new StoreUnavailableError('This browser does not offer IndexedDB.')));
    expect(r.fallback).toEqual({ reason: 'This browser does not offer IndexedDB.' });
    expect(r.store.kind).toBe('memory');
    await r.store.putClip({ id: 'c1', addedAt: '2026-10-08T00:00:00Z' } as unknown as ClipRecord);
    expect(await r.store.getClip('c1')).not.toBeNull();
  });

  it('falls back when open throws something that is not an Error', async () => {
    const r = await openClipStoreWithFallback(() => Promise.reject('nope'));
    expect(r.fallback?.reason).toMatch(/could not be opened/);
  });

  it('falls back when no IndexedDB exists at all (the default opener)', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const r = await openClipStoreWithFallback();
    expect(r.store.kind).toBe('memory');
    expect(r.fallback?.reason).toMatch(/IndexedDB/);
  });
});

// ---------------------------------------------------------------------------------------------
// The reconnect-once wrapper

describe('createReconnecting', () => {
  const stale = () => new DOMException('The database connection is closing.', 'InvalidStateError');

  function connections() {
    let n = 0;
    const opened: { id: number; closed: boolean }[] = [];
    const open = vi.fn(async () => {
      const c = { id: ++n, closed: false };
      opened.push(c);
      return c;
    });
    const dispose = vi.fn((c: { closed: boolean }) => {
      c.closed = true;
    });
    return { open, dispose, opened };
  }

  it('opens lazily and reuses the connection', async () => {
    const { open, dispose } = connections();
    const rc = createReconnecting(open, dispose);
    expect(open).not.toHaveBeenCalled();
    await rc.run(async (c) => c.id);
    await rc.run(async (c) => c.id);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('retries once on a new connection when the connection went stale', async () => {
    const { open, dispose, opened } = connections();
    const rc = createReconnecting(open, dispose);
    let calls = 0;
    const result = await rc.run(async (c) => {
      calls++;
      if (c.id === 1) throw stale();
      return `ok on ${c.id}`;
    });
    expect(result).toBe('ok on 2');
    expect(calls).toBe(2);
    expect(opened[0].closed).toBe(true);
    expect(opened[1].closed).toBe(false);
  });

  it('does not retry an error that is not about the connection', async () => {
    const { open, dispose } = connections();
    const rc = createReconnecting(open, dispose);
    const fn = vi.fn(async () => {
      throw new DOMException('too big', 'DataCloneError');
    });
    await expect(rc.run(fn)).rejects.toThrow('too big');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reports StoreUnavailableError, with the next step, when the second try fails too', async () => {
    const { open, dispose } = connections();
    const rc = createReconnecting(open, dispose);
    const err = await rc.run(async () => Promise.reject(stale())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect((err as Error).message).toMatch(/Export a backup/);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('passes a non-connection error from the second try through unchanged', async () => {
    const { open, dispose } = connections();
    const rc = createReconnecting(open, dispose);
    const err = await rc
      .run(async (c) => {
        throw c.id === 1 ? stale() : new TypeError('bad input');
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
  });

  it('lets calls that fail together share one new connection', async () => {
    const { open, dispose } = connections();
    const rc = createReconnecting(open, dispose);
    await rc.run(async () => 1); // connection 1
    const results = await Promise.all([1, 2, 3].map((k) => rc.run(async (c) => (c.id === 1 ? Promise.reject(stale()) : k * 10))));
    expect(results).toEqual([10, 20, 30]);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('dropIf only forgets the connection it is given', async () => {
    const { open, dispose, opened } = connections();
    const rc = createReconnecting(open, dispose);
    await rc.run(async () => 1);
    const old = opened[0];
    rc.dropIf(old);
    await rc.run(async () => 1);
    expect(opened).toHaveLength(2);
    rc.dropIf(old); // an old handle arriving late must not close the new connection
    expect(opened[1].closed).toBe(false);
  });

  it('propagates an open failure and tries again on the next call', async () => {
    let fail = true;
    const rc = createReconnecting(
      async () => {
        if (fail) throw new StoreUnavailableError('blocked');
        return { id: 1 };
      },
      () => undefined,
    );
    await expect(rc.run(async () => 1)).rejects.toThrow('blocked');
    fail = false;
    expect(await rc.run(async (c) => c.id)).toBe(1);
  });

  it('is closed for good after close(), and closes a connection that was still opening', async () => {
    const { open, dispose, opened } = connections();
    const rc = createReconnecting(open, dispose);
    await rc.run(async () => 1);
    rc.close();
    expect(opened[0].closed).toBe(true);
    expect(rc.closed).toBe(true);
    await expect(rc.run(async () => 1)).rejects.toBeInstanceOf(StoreUnavailableError);

    let release!: (c: { id: number; closed: boolean }) => void;
    const slow = { id: 9, closed: false };
    const rc2 = createReconnecting(
      () => new Promise<{ id: number; closed: boolean }>((resolve) => (release = resolve)),
      (c) => {
        c.closed = true;
      },
    );
    const pending = rc2.run(async () => 1).catch((e: unknown) => e);
    rc2.close();
    release(slow);
    expect(await pending).toBeInstanceOf(StoreUnavailableError);
    expect(slow.closed).toBe(true);
  });
});

describe('error classification', () => {
  it('recognises quota errors however the browser words them', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error('QuotaExceededError (DOM Exception 22)'))).toBe(true);
    expect(isQuotaError(new Error('something else'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it('recognises a stale connection', () => {
    expect(isStaleConnection(new DOMException('closing', 'InvalidStateError'))).toBe(true);
    expect(isStaleConnection(new DOMException('lost', 'UnknownError'))).toBe(true);
    expect(isStaleConnection(new Error('Connection to Indexed Database server lost. Refresh the page to try again'))).toBe(true);
    expect(isStaleConnection(new DOMException('x', 'DataError'))).toBe(false);
    expect(isStaleConnection(undefined)).toBe(false);
  });
});

describe('a fully typed record', () => {
  it('lets AttemptRecord and ClipRecord pass through the memory store untouched', async () => {
    const s = createMemoryClipStore();
    const clip = { id: 'c1', addedAt: '2026-10-08T00:00:00Z', title: 'x', phrases: [{ id: 'p1' }] } as unknown as ClipRecord;
    await s.putClip(clip);
    expect(await s.getClip('c1')).toEqual(clip);
    const a = { id: 'a1', clipId: 'c1', phraseId: 'p1', at: 5, hasAudio: false, scores: { overall: 80 } } as unknown as AttemptRecord;
    await s.addAttempt(a);
    expect((await s.listAttempts({ clipId: 'c1' }))[0]).toEqual(a);
  });
});
