// Browser side of the IndexedDB check. Bundled by run.mjs (rolldown) and run in real Chromium.
//   1. the shared ClipStore contract (src/storage/clipStoreContract.ts) against openClipStore()
//   2. checks that only a real IndexedDB can answer: migrations, a dropped connection, another tab upgrading,
//      an empty database left by an aborted upgrade, a tab that will not let go, a refusing browser
// window.runClipStoreChecks() resolves to { lines, failed }.

import { floatToInt16 } from '../../src/audio/pcm.ts';
import { getStorageStatus, requestPersistence } from '../../src/storage/quota.ts';
import {
  AudioMissingError,
  DB_NAME,
  MIGRATIONS,
  openClipStore,
  openClipStoreWithFallback,
  QuotaError,
  StoreUnavailableError,
} from '../../src/storage/clips.ts';
import { attempt, CLIP_STORE_CASES, runClipStoreContract } from '../../src/storage/clipStoreContract.ts';

const SR = 44100;
const lines = [];
let failed = 0;
const log = (line) => lines.push(line);
const ok = (name, ms = 0) => log(`PASS ${name}${ms ? ` (${ms} ms)` : ''}`);
const bad = (name, err) => {
  failed++;
  log(`FAIL ${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
};

let counter = 0;
const uniqueName = () => `${DB_NAME}-test-${Date.now()}-${++counter}`;
const names = new Set();

function deleteDb(name) {
  return new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

function rawOpen(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    if (upgrade) r.onupgradeneeded = (e) => upgrade(r.result, r.transaction, e.oldVersion);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => {};
  });
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------------------------
// 1. The shared contract

const contractStores = [];
const contractEnv = {
  async make() {
    const name = uniqueName();
    names.add(name);
    const store = await openClipStore({ name });
    contractStores.push(store);
    return store;
  },
  // Chromium enforces the quota the harness sets through the DevTools protocol, but only while the origin is under it (an
  // origin already over its quota is allowed to keep writing) and it counts usage lazily after deletes. So the quota cases
  // run on an origin of their own (run.mjs serves the page on 127.0.0.1 as well as localhost) and allow `bytes` of new data
  // on top of whatever the origin already holds.
  async makeWithQuota(bytes) {
    let usage = -1;
    for (let i = 0; i < 40; i++) {
      const next = (await navigator.storage.estimate()).usage;
      if (next === usage) break;
      usage = next;
      await new Promise((r) => setTimeout(r, 150));
    }
    await window.__setQuota(usage + bytes);
    const e = await navigator.storage.estimate();
    log(`INFO quota set to ${usage} used + ${bytes} room -> estimate quota ${e.quota}, usage ${e.usage}`);
    const name = uniqueName();
    names.add(name);
    const store = await openClipStore({ name });
    contractStores.push(store);
    return store;
  },
  async cleanup() {
    contractStores.splice(0).forEach((s) => s.close());
    await window.__setQuota(null);
    await Promise.all([...names].map(deleteDb));
    names.clear();
  },
  bigClipSec: 240,
  log: (line) => log(`INFO ${line}`),
};

// ---------------------------------------------------------------------------------------------
// 2. Browser-only checks

const extra = [];
const check = (name, fn) => extra.push({ name, fn });

check('migrations: a version bump runs only the new step, once, and keeps the data', async () => {
  const name = uniqueName();
  names.add(name);
  const v1 = await openClipStore({ name, version: 1, migrations: { 1: MIGRATIONS[1] } });
  await v1.putClip({ id: 'keep', addedAt: '2026-10-08T00:00:00Z', title: 'kept' });
  await v1.writeAudio('keep', 'mix', new Int16Array(SR * 2), SR);
  v1.close();
  const ran = [];
  const migrations = {
    1: MIGRATIONS[1],
    2: (db, tx, oldVersion) => {
      ran.push(oldVersion);
      tx.objectStore('clips').createIndex('byTitle', 'title');
    },
  };
  const v2 = await openClipStore({ name, version: 2, migrations });
  assert(JSON.stringify(ran) === '[1]', `step 2 ran with oldVersion ${JSON.stringify(ran)}`);
  assert((await v2.getClip('keep'))?.title === 'kept', 'the clip survived');
  assert((await v2.usage()).audioBytes === SR * 4, 'the audio survived');
  v2.close();
  const raw = await rawOpen(name, 2);
  assert(raw.version === 2 && raw.transaction('clips').objectStore('clips').indexNames.contains('byTitle'), 'the new index exists');
  raw.close();
  const again = await openClipStore({ name, version: 2, migrations });
  assert(ran.length === 1, 'reopening at the same version runs nothing');
  again.close();
});

check('migrations: a step that throws leaves the old version and its data', async () => {
  const name = uniqueName();
  names.add(name);
  const v1 = await openClipStore({ name, version: 1, migrations: { 1: MIGRATIONS[1] } });
  await v1.putClip({ id: 'keep', addedAt: '2026-10-08T00:00:00Z' });
  v1.close();
  const err = await openClipStore({
    name,
    version: 2,
    migrations: {
      1: MIGRATIONS[1],
      2: () => {
        throw new Error('cannot migrate');
      },
    },
  }).catch((e) => e);
  assert(err instanceof StoreUnavailableError && /cannot migrate/.test(err.message), `rejected with ${err}`);
  const raw = await rawOpen(name, 1);
  assert(raw.version === 1, `still at version ${raw.version}`);
  const row = await new Promise((resolve, reject) => {
    const r = raw.transaction('clips').objectStore('clips').get('keep');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  assert(row?.id === 'keep', 'the data is intact');
  raw.close();
});

check('reconnect: a connection that the browser dropped is reopened once, transparently', async () => {
  const name = uniqueName();
  names.add(name);
  const conns = [];
  const s = await openClipStore({ name, onConnection: (db) => conns.push(db) });
  await s.putClip({ id: 'a', addedAt: '2026-10-08T00:00:00Z' });
  assert(conns.length === 1, 'one connection so far');
  conns[0].close(); // what Safari does when its IndexedDB server goes away
  await s.putClip({ id: 'b', addedAt: '2026-10-09T00:00:00Z' });
  assert(conns.length === 2, `reopened (${conns.length} connections)`);
  assert((await s.listClips()).length === 2, 'both clips are there');
  // Several calls hitting the dead connection together share one new connection.
  conns[1].close();
  await Promise.all([s.getClip('a'), s.getClip('b'), s.usage(), s.listAttempts({})]);
  assert(conns.length === 3, `one reopen for four calls (${conns.length} connections)`);
  s.close();
});

check('versionchange: a newer app in another tab upgrades without being blocked, and this tab then reports it', async () => {
  const name = uniqueName();
  names.add(name);
  const s = await openClipStore({ name });
  await s.putClip({ id: 'a', addedAt: '2026-10-08T00:00:00Z' });
  const upgraded = await rawOpen(name, 2, () => {}); // would hang if our connection did not let go
  upgraded.close();
  const err = await s.getClip('a').catch((e) => e);
  assert(err instanceof StoreUnavailableError && /newer version/.test(err.message), `got ${err}`);
  s.close();
});

check('heal: an empty database left by an aborted upgrade is recreated', async () => {
  const name = uniqueName();
  names.add(name);
  const empty = await rawOpen(name, 1, () => {}); // version 1 with no stores
  empty.close();
  const s = await openClipStore({ name });
  await s.putClip({ id: 'a', addedAt: '2026-10-08T00:00:00Z' });
  assert((await s.listClips()).length === 1, 'usable after healing');
  s.close();
});

check('incomplete: a database with only some stores is refused, not patched', async () => {
  const name = uniqueName();
  names.add(name);
  const partial = await rawOpen(name, 1, (db) => db.createObjectStore('clips', { keyPath: 'id' }));
  partial.close();
  const err = await openClipStore({ name }).catch((e) => e);
  assert(err instanceof StoreUnavailableError && /incomplete/.test(err.message), `got ${err}`);
});

check('blocked: stops waiting for a tab that will not let go, then works once it has', async () => {
  const name = uniqueName();
  names.add(name);
  const holder = await rawOpen(name, 1, (db) => {
    for (const n of ['clips', 'audio', 'attempts', 'attemptAudio', 'meta']) db.createObjectStore(n, { keyPath: 'id' });
  });
  holder.onversionchange = () => {}; // an old tab that ignores the request to close
  const t0 = performance.now();
  const err = await openClipStore({ name, version: 2, migrations: { 1: MIGRATIONS[1], 2: () => {} }, blockedTimeoutMs: 400 }).catch((e) => e);
  const waited = performance.now() - t0;
  assert(err instanceof StoreUnavailableError && /Another tab/.test(err.message), `got ${err}`);
  assert(waited >= 350 && waited < 3000, `waited ${Math.round(waited)} ms`);
  holder.close();
  await deleteDb(name);
  const s = await openClipStore({ name });
  await s.putClip({ id: 'a', addedAt: '2026-10-08T00:00:00Z' });
  s.close();
});

function patchPut(match, fail) {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function patched(value, key) {
    if (match(this, value)) fail();
    return original.call(this, value, key);
  };
  return () => {
    IDBObjectStore.prototype.put = original;
  };
}

check('refusing browser: a store that opens but cannot write is reported as unavailable, and the app falls back to memory', async () => {
  const restore = patchPut(
    (os) => os.name === 'meta',
    () => {
      throw new DOMException('disk full', 'QuotaExceededError');
    },
  );
  try {
    const name = uniqueName();
    names.add(name);
    const err = await openClipStore({ name }).catch((e) => e);
    assert(err instanceof StoreUnavailableError && /cannot store/.test(err.message), `got ${err}`);
    const r = await openClipStoreWithFallback(() => openClipStore({ name }));
    assert(r.store.kind === 'memory' && r.fallback && r.fallback.reason.length > 0, 'fell back to memory with a reason');
  } finally {
    restore();
  }
});

check('atomic: a put that throws half way through a clip leaves the old audio untouched', async () => {
  const name = uniqueName();
  names.add(name);
  const s = await openClipStore({ name });
  const old = floatToInt16(Float32Array.from({ length: 20 * SR }, (_, i) => 0.3 * Math.sin(i / 20)));
  const info = await s.writeAudio('c1', 'mix', old, SR);
  let puts = 0;
  const restore = patchPut(
    (os) => os.name === 'audio' && ++puts === 3,
    () => {
      throw new DOMException('simulated', 'QuotaExceededError');
    },
  );
  try {
    const err = await s.writeAudio('c1', 'mix', new Int16Array(35 * SR), SR).catch((e) => e);
    assert(err instanceof QuotaError, `got ${err}`);
  } finally {
    restore();
  }
  const got = await s.readAudio('c1', info, 15, 16);
  assert(got.length === SR, 'old audio still reads');
  assert((await s.usage()).audioBytes === old.byteLength, 'no new chunks were kept and the old ones were not deleted');
  // The same for an attempt with a recording: neither half is kept.
  puts = 0;
  const restore2 = patchPut(
    (os) => os.name === 'attemptAudio',
    () => {
      throw new DOMException('simulated', 'QuotaExceededError');
    },
  );
  try {
    const err = await s.addAttempt({ id: 'a1', clipId: 'c1', phraseId: 'p1', at: 1, hasAudio: false }, { pcm: new Int16Array(1000), sampleRate: SR }).catch((e) => e);
    assert(err instanceof QuotaError, `got ${err}`);
  } finally {
    restore2();
  }
  assert((await s.listAttempts({})).length === 0, 'the attempt record was rolled back with its recording');
  s.close();
});

check('two tabs: a second connection sees what the first wrote, and deletes cascade across them', async () => {
  const name = uniqueName();
  names.add(name);
  const a = await openClipStore({ name });
  const b = await openClipStore({ name });
  await a.putClip({ id: 'c1', addedAt: '2026-10-08T00:00:00Z' });
  const info = await a.writeAudio('c1', 'mix', new Int16Array(SR * 12), SR);
  await a.addAttempt({ id: 'a1', clipId: 'c1', phraseId: 'p1', at: 5, hasAudio: false });
  assert((await b.getClip('c1')) !== null && (await b.readAudio('c1', info, 0, 1)).length === SR, 'B reads A\'s clip and audio');
  await b.deleteClip('c1');
  assert((await a.getClip('c1')) === null, 'A sees B\'s delete');
  assert((await a.listAttempts({})).length === 0, 'attempts went with it');
  const err = await a.readAudio('c1', info, 0, 1).catch((e) => e);
  assert(err instanceof AudioMissingError, `got ${err}`);
  a.close();
  b.close();
});

check('usage reads index keys only (a 60 s clip and 30 recordings)', async () => {
  const name = uniqueName();
  names.add(name);
  const s = await openClipStore({ name });
  const pcm = new Int16Array(60 * SR);
  await s.writeAudio('c1', 'mix', pcm, SR);
  for (let i = 0; i < 30; i++) await s.addAttempt({ id: `a${i}`, clipId: 'c1', phraseId: 'p1', at: i, hasAudio: false }, { pcm: new Int16Array(SR), sampleRate: SR });
  const t0 = performance.now();
  const u = await s.usage();
  const ms = Math.round(performance.now() - t0);
  assert(u.audioBytes === pcm.byteLength + 30 * SR * 2, `bytes ${u.audioBytes}`);
  log(`INFO usage() over ${(u.audioBytes / 1048576).toFixed(1)} MB took ${ms} ms`);
  s.close();
});

check('storage helpers answer in a real browser', async () => {
  const status = await getStorageStatus();
  assert(status.supported === true, 'navigator.storage is supported');
  assert(typeof status.usage === 'number' && typeof status.quota === 'number' && status.quota > status.usage, `estimate ${JSON.stringify(status)}`);
  const persisted = await requestPersistence();
  log(`INFO storage ${JSON.stringify(status)}; persist() answered ${persisted}`);
});

// ---------------------------------------------------------------------------------------------

// Persistence across a real page reload: write in one page load, read in the next (run.mjs reloads in between).
const PERSIST_DB = `${DB_NAME}-persist-check`;
window.persistWrite = async () => {
  await deleteDb(PERSIST_DB);
  const s = await openClipStore({ name: PERSIST_DB });
  const pcm = new Int16Array(25 * SR).map((_, i) => (i % 1000) - 500);
  await s.putClip({ id: 'kept', addedAt: '2026-10-08T00:00:00Z', title: 'Kept across a reload', phrases: [] });
  const info = await s.writeAudio('kept', 'mix', pcm, SR);
  // Stores read attempts back through parseAttemptRecord, so the fixture must be a complete record.
  await s.addAttempt(attempt('a1', 'p1', 10, 'kept'), { pcm: pcm.slice(0, 500), sampleRate: SR });
  await s.setMeta('calibration', { wired: 91 });
  s.close();
  return info;
};
window.persistRead = async (info) => {
  const s = await openClipStore({ name: PERSIST_DB });
  const out = {
    title: (await s.getClip('kept'))?.title,
    samples: (await s.readAudio('kept', info, 12, 13)).length,
    attempts: (await s.listAttempts({ clipId: 'kept' })).map((a) => [a.id, a.hasAudio]),
    recording: (await s.readAttemptAudio('a1'))?.pcm.length,
    calibration: await s.getMeta('calibration'),
    usage: await s.usage(),
  };
  s.close();
  await deleteDb(PERSIST_DB);
  return out;
};

// part 'quota': only the cases that need a refusing browser; part 'main': everything else.
window.runClipStoreChecks = async (part = 'main') => {
  log(`INFO ${part} part, ${navigator.userAgent}`);
  const results = await runClipStoreContract(
    contractEnv,
    (r) => {
      if (r.status === 'pass') ok(`contract: ${r.name}`, r.ms);
      else if (r.status === 'skip') log(`SKIP contract: ${r.name}`);
      else bad(`contract: ${r.name}`, r.error);
    },
    (c) => (part === 'quota') === !!c.needsQuota,
  );
  log(`INFO contract cases: ${results.filter((r) => r.status === 'pass').length} passed, ${results.filter((r) => r.status === 'fail').length} failed, ${results.filter((r) => r.status === 'skip').length} skipped of ${CLIP_STORE_CASES.length} in total`);
  if (part === 'quota') {
    await Promise.all([...names].map(deleteDb));
    return { lines, failed };
  }
  for (const c of extra) {
    const t0 = performance.now();
    try {
      await c.fn();
      ok(c.name, Math.round(performance.now() - t0));
    } catch (err) {
      bad(c.name, err);
    }
  }
  await Promise.all([...names].map(deleteDb));
  return { lines, failed };
};
