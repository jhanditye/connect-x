// @vitest-environment jsdom
import { act, StrictMode, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryClipStore, QuotaError, StoreUnavailableError, type ClipStore } from '../storage/clips';
import { findRelinkCandidates, measuredFromClip } from '../storage/library';
import { FAKE_NOW, FakeTrainerEngine, makeFakeAttempts, makeFakeClip, makeFakePreparedClip } from '../testing/trainerFixtures';
import { makeFakeProfile } from '../testing/fixtures';
import type { AppSettings, AttemptRecord, ClipRecord, MeasuredClip, PhraseRecord } from '../types';
import { AppProvider } from './AppProvider';
import { AppContext, useApp, type AppController } from './context';
import { createInitialState } from './reducer';
import { createInertTrainerController, createKeyedQueue, TrainerProvider, useTrainerExtras, type PracticeSession, type TrainerExtras, type TrainerImporter, type TrainerProviderProps } from './TrainerProvider';
import { useTrainer, type TrainerController } from './trainerContext';
import { MAX_ATTEMPTS_PER_PHRASE } from './trainerReducer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' };
const BUILTINS = [
  makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes' }),
  makeFakeProfile({ id: 'daniel-caesar', name: 'Daniel Caesar' }),
  makeFakeProfile({ id: 'jalen-ngonda', name: 'Jalen Ngonda' }),
];
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------
// A stand-in for the parts of AppController the trainer uses

interface FakeApp {
  measured: Record<string, MeasuredClip[]>;
  calls: string[];
  hooks: (() => void | Promise<void>)[];
  bump: () => void;
}

function createFakeApp(initial: Record<string, MeasuredClip[]> = {}) {
  const handle: FakeApp = { measured: initial, calls: [], hooks: [], bump: () => {} };
  const onClear = (fn: () => void | Promise<void>) => {
    handle.hooks.push(fn);
    return () => {
      handle.hooks = handle.hooks.filter((h) => h !== fn);
    };
  };
  function Provider({ children }: { children: ReactNode }) {
    const [, setN] = useState(0);
    handle.bump = () => setN((n) => n + 1);
    const value = {
      state: { ...createInitialState(SETTINGS, [], BUILTINS), measurements: handle.measured },
      builtins: BUILTINS,
      addMeasuredClip: (singerId: string, clip: MeasuredClip) => {
        handle.calls.push(`add:${singerId}:${clip.id}`);
        handle.measured = { ...handle.measured, [singerId]: [...(handle.measured[singerId] ?? []).filter((c) => c.id !== clip.id), clip] };
        handle.bump();
      },
      removeMeasuredClip: (singerId: string, clipId: string) => {
        handle.calls.push(`remove:${singerId}:${clipId}`);
        handle.measured = { ...handle.measured, [singerId]: (handle.measured[singerId] ?? []).filter((c) => c.id !== clipId) };
        handle.bump();
      },
      onClear,
    } as unknown as AppController;
    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
  }
  return { handle, Provider };
}

// ---------------------------------------------------------------------------------------------
// Harness

interface Harness {
  readonly c: TrainerController;
  readonly x: TrainerExtras;
  settle(): Promise<void>;
  unmount(): Promise<void>;
}

let roots: { root: Root; container: HTMLElement }[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(opts: { props?: Partial<TrainerProviderProps>; app?: ReturnType<typeof createFakeApp> | null; strict?: boolean } = {}): Promise<Harness> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  let ctl!: TrainerController;
  let ext!: TrainerExtras;
  function Probe() {
    ctl = useTrainer();
    ext = useTrainerExtras();
    return null;
  }
  const inner = (
    <TrainerProvider now={() => FAKE_NOW} {...opts.props}>
      <Probe />
    </TrainerProvider>
  );
  const withApp = opts.app ? <opts.app.Provider>{inner}</opts.app.Provider> : inner;
  await act(async () => root.render(opts.strict ? <StrictMode>{withApp}</StrictMode> : withApp));
  await settle();
  return {
    get c() {
      return ctl;
    },
    get x() {
      return ext;
    },
    settle,
    unmount: async () => {
      await act(async () => root.unmount());
      roots = roots.filter((r) => r.root !== root);
    },
  };
}

async function seededStore(clips: ClipRecord[] = [makeFakeClip()], attempts: AttemptRecord[] = makeFakeAttempts()): Promise<ClipStore> {
  const store = createMemoryClipStore();
  for (const c of clips) {
    await store.putClip(c);
    await store.writeAudio(c.id, 'mix', new Int16Array(44100), 44100);
  }
  for (const a of attempts) await store.addAttempt(a);
  return store;
}

/** An importer standing in for trainer/import.ts: it writes audio and the record like the real one will. */
function fakeImporter(log: string[] = []): Partial<TrainerImporter> {
  return {
    prepareClip: async (file) => makeFakePreparedClip({ file: { name: file.name, size: file.size } }),
    commitClip: async (prepared, edits, store) => {
      log.push('commit');
      const clip = makeFakeClip({ id: 'imported-1', title: edits.title, singerId: edits.singerId, singerLabel: edits.singerLabel, kind: edits.kind, sourceFileName: prepared.file.name, fingerprint: prepared.fingerprint });
      await store.writeAudio(clip.id, 'mix', new Int16Array(44100), 44100);
      await store.putClip(clip);
      return { clip, measured: edits.contributeToSinger ? measuredFromClip(clip) : null };
    },
    relinkAudio: async (clip, _prepared, store) => {
      log.push('relink');
      await store.writeAudio(clip.id, 'mix', new Int16Array(44100), 44100);
      return { ...clip, audioMissing: false };
    },
  };
}

const EDITS = (over: Record<string, unknown> = {}) =>
  ({ title: 'Imported', singerId: 'shawn-mendes', singerLabel: '', kind: 'solo', phrases: [], contributeToSinger: false, ownedConfirmed: true, ...over }) as never;

async function act1<T>(fn: () => Promise<T>): Promise<T> {
  let out!: T;
  await act(async () => {
    out = await fn();
  });
  return out;
}

function stubStorage(value: Partial<StorageManager> | undefined) {
  Object.defineProperty(window.navigator, 'storage', { configurable: true, value });
}

beforeEach(() => stubStorage(undefined));

afterEach(async () => {
  for (const { root, container } of roots) {
    await act(async () => root.unmount());
    container.remove();
  }
  roots = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  stubStorage(undefined);
});

// ---------------------------------------------------------------------------------------------

describe('loading the library', () => {
  it('starts loading, then shows the clips, the queue and the singers', async () => {
    const store = await seededStore();
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    expect(h.c.status).toBe('ready');
    expect(h.c.error).toBeNull();
    expect(h.c.clips.map((c) => c.id)).toEqual(['fake-clip']);
    expect(h.c.getClip('fake-clip')?.title).toBe('Fake clip, 12 phrases');
    expect(h.c.getClip('nope')).toBeUndefined();
    expect(h.c.queue.map((i) => i.status)).toEqual(['review-due', 'review-due', 'review-due', 'stuck', 'learning']);
    expect(h.c.singers.map((s) => s.id)).toEqual(['shawn-mendes', 'daniel-caesar', 'jalen-ngonda']);
  });

  it('is empty and ready for a new library, with no singers when there is no app around it', async () => {
    const h = await mount({ props: { store: createMemoryClipStore() } });
    expect(h.c).toMatchObject({ status: 'ready', clips: [], queue: [], singers: [] });
    expect(h.x.exportReminder.due).toBe(false);
  });

  it('reads the storage estimate, and falls back to the audio it holds when the browser cannot say', async () => {
    stubStorage({ estimate: async () => ({ usage: 124e6, quota: 6e9 }), persisted: async () => false });
    const h = await mount({ props: { store: await seededStore() } });
    expect(h.c.storage).toEqual({ supported: true, usage: 124e6, quota: 6e9, persisted: false });
    expect(h.x.storageNote).toMatch(/Home Screen/);
    stubStorage({ persist: async () => true });
    const h2 = await mount({ props: { store: await seededStore() } });
    expect(h2.c.storage.usage).toBe(44100 * 2);
    expect(h2.c.storage.quota).toBeNull();
  });

  it('hides records it cannot read, says so, and leaves them in the store', async () => {
    const store = await seededStore();
    await store.putClip({ id: 'junk', addedAt: '2026-01-01T00:00:00Z', title: 'Junk' } as unknown as ClipRecord);
    await store.putClip({ ...makeFakeClip({ id: 'future' }), schema: 2 } as unknown as ClipRecord);
    const h = await mount({ props: { store } });
    expect(h.c.clips.map((c) => c.id)).toEqual(['fake-clip']);
    expect(h.x.warnings.join(' ')).toMatch(/1 saved clip could not be read.*untouched/);
    expect(h.x.warnings.join(' ')).toMatch(/1 saved clip was written by a newer version of Mimic.*Update the app/);
    expect((await store.listClips()).map((c) => c.id).sort()).toEqual(['fake-clip', 'future', 'junk']);
  });

  it('shows an error with the next step when the store cannot be read', async () => {
    const store = await seededStore();
    const broken: ClipStore = { ...store, listClips: () => Promise.reject(new StoreUnavailableError('Your library could not be reached. Export a backup, then reload the app.')) };
    const h = await mount({ props: { store: broken } });
    expect(h.c.status).toBe('error');
    expect(h.c.error).toMatch(/Export a backup, then reload/);
  });

  it('falls back to a labelled memory-only library when IndexedDB cannot be opened', async () => {
    const h = await mount({ props: { openStore: () => Promise.reject(new StoreUnavailableError('This browser is blocking IndexedDB (private browsing).')), importer: fakeImporter() } });
    expect(h.c.status).toBe('memory-only');
    expect(h.x.memoryReason).toMatch(/blocking IndexedDB/);
    expect(h.x.storageNote).toMatch(/lost when you close the app/);
    const clip = await act1(() => h.c.commitClip(makeFakePreparedClip(), EDITS()));
    expect(h.c.clips.map((c) => c.id)).toEqual([clip.id]);
  });

  it('closes a store it opened when it unmounts, and also one that arrives after an early unmount (StrictMode)', async () => {
    const opened: ClipStore[] = [];
    const close = vi.fn();
    const openStore = vi.fn(async () => {
      const s = createMemoryClipStore();
      opened.push(s);
      return { ...s, close: () => (close(), s.close()) } as ClipStore;
    });
    const h = await mount({ props: { openStore }, strict: true });
    expect(h.c.status).toBe('ready');
    expect(openStore).toHaveBeenCalledTimes(2);
    await h.unmount();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('does not close a store that was handed in', async () => {
    const store = await seededStore();
    const close = vi.spyOn(store, 'close');
    const h = await mount({ props: { store } });
    await h.unmount();
    expect(close).not.toHaveBeenCalled();
  });

  it('waits for the library before acting on it', async () => {
    let release!: () => void;
    const store = await seededStore();
    const slow = new Promise<void>((r) => (release = r));
    const h = await mount({ props: { openStore: async () => (await slow, store) } });
    expect(h.c.status).toBe('loading');
    let done = false;
    const pending = h.c.updateClip('fake-clip', { title: 'Early edit' }).then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    release();
    await act(async () => pending);
    expect((await store.getClip('fake-clip'))?.title).toBe('Early edit');
  });
});

describe('editing clips', () => {
  it('renames, assigns a singer and keeps the edit time', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, now: () => FAKE_NOW + DAY }, app: createFakeApp() });
    await act1(() => h.c.updateClip('fake-clip', { title: '  Stitches  ', singerId: 'daniel-caesar', tags: ['verse'], difficulty: 3, notes: 'watch the breath' }));
    const stored = await store.getClip('fake-clip');
    expect(stored).toMatchObject({ title: 'Stitches', singerId: 'daniel-caesar', tags: ['verse'], difficulty: 3, notes: 'watch the breath', updatedAt: new Date(FAKE_NOW + DAY).toISOString() });
    expect(h.c.getClip('fake-clip')?.title).toBe('Stitches');
  });

  it('refuses an empty name or an unknown singer with a message, and changes nothing', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store }, app: createFakeApp() });
    await expect(h.c.updateClip('fake-clip', { title: '  ' })).rejects.toThrow(/Give the clip a name/);
    await expect(h.c.updateClip('fake-clip', { singerId: 'nobody' })).rejects.toThrow(/Choose one of the singers/);
    await expect(h.c.updateClip('ghost', { title: 'x' })).rejects.toThrow(/no longer in the library/);
    expect((await store.getClip('fake-clip'))?.title).toBe('Fake clip, 12 phrases');
    expect(h.c.status).toBe('ready');
  });

  it('two edits at once both land (each reads the clip fresh after the other)', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    await act1(() => Promise.all([h.c.updateClip('fake-clip', { title: 'Renamed' }), h.c.updateClip('fake-clip', { notes: 'A note' }), h.c.updateClip('fake-clip', { tags: ['x'] })]));
    expect(await store.getClip('fake-clip')).toMatchObject({ title: 'Renamed', notes: 'A note', tags: ['x'] });
  });

  it('an edit made from a stale screen does not undo a newer one made elsewhere', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    const other = (await store.getClip('fake-clip')) as ClipRecord;
    await store.putClip({ ...other, notes: 'written by another tab' });
    await act1(() => h.c.updateClip('fake-clip', { title: 'My rename' }));
    expect(await store.getClip('fake-clip')).toMatchObject({ title: 'My rename', notes: 'written by another tab' });
  });

  it('stores an edited phrase list cleaned up, and drops the cache of phrases that went away', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    const clip = h.c.getClip('fake-clip') as ClipRecord;
    const keep = clip.phrases.slice(2, 5).map((p, i) => ({ ...p, label: `P${i}` })).reverse();
    await act1(() => h.c.updatePhrases('fake-clip', keep));
    const stored = (await store.getClip('fake-clip')) as ClipRecord;
    expect(stored.phrases.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(stored.phrases.map((p) => p.start)).toEqual([...stored.phrases.map((p) => p.start)].sort((a, b) => a - b));
    expect(stored.phrases[0].stats).toEqual(clip.phrases[2].stats);
    expect(h.c.queue.every((i) => keep.some((p) => p.id === i.phraseId))).toBe(true);
  });
});

describe("a singer's measured targets", () => {
  it('turning contribution on adds the clip\'s measurements under the same id, and off removes it', async () => {
    const store = await seededStore();
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    expect(h.c.getClip('fake-clip')?.contributesToSinger).toBe(false);
    await act1(() => h.c.setContributes('fake-clip', true));
    expect(app.handle.calls).toEqual(['add:shawn-mendes:fake-clip']);
    const added = app.handle.measured['shawn-mendes'][0];
    expect(added).toEqual(measuredFromClip((await store.getClip('fake-clip')) as ClipRecord));
    expect(added.id).toBe('fake-clip');
    expect((await store.getClip('fake-clip'))?.contributesToSinger).toBe(true);
    expect(h.c.getClip('fake-clip')?.contributesToSinger).toBe(true);
    await act1(() => h.c.setContributes('fake-clip', false));
    expect(app.handle.calls[1]).toBe('remove:shawn-mendes:fake-clip');
    expect((await store.getClip('fake-clip'))?.contributesToSinger).toBe(false);
    expect(h.c.getClip('fake-clip')?.contributesToSinger).toBe(false);
  });

  it('says why a clip cannot contribute, and adds nothing', async () => {
    const unusable = makeFakeClip({ id: 'weak' });
    unusable.analysis = { ...unusable.analysis, usableAsTarget: false, unusableReason: 'Too little singing (4 s).' };
    const store = await seededStore([makeFakeClip({ id: 'nosinger', singerId: null }), makeFakeClip({ id: 'mix', kind: 'mix' }), unusable], []);
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    await expect(h.c.setContributes('nosinger', true)).rejects.toThrow(/Choose which singer/);
    await expect(h.c.setContributes('mix', true)).rejects.toThrow(/vocal-only version/);
    await expect(h.c.setContributes('weak', true)).rejects.toThrow('Too little singing (4 s).');
    expect(app.handle.calls).toEqual([]);
  });

  it('is not available without the app around it', async () => {
    const h = await mount({ props: { store: await seededStore() } });
    await expect(h.c.setContributes('fake-clip', true)).rejects.toThrow(/not available here/);
  });

  it('undoes the measured entry when the clip could not be saved', async () => {
    const store = await seededStore();
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    vi.spyOn(store, 'putClip').mockRejectedValueOnce(new Error('disk full'));
    await expect(h.c.setContributes('fake-clip', true)).rejects.toThrow('disk full');
    expect(app.handle.measured['shawn-mendes']).toEqual([]);
    expect(app.handle.calls).toEqual(['add:shawn-mendes:fake-clip', 'remove:shawn-mendes:fake-clip']);
  });

  it('shows "off" when the targets were cleared elsewhere, whatever the stored flag says', async () => {
    const clip = makeFakeClip({ contributesToSinger: true });
    const app = createFakeApp({ 'shawn-mendes': [measuredFromClip(clip)] });
    const h = await mount({ props: { store: await seededStore([clip]) }, app });
    expect(h.c.getClip('fake-clip')?.contributesToSinger).toBe(true);
    await act(async () => {
      app.handle.measured = {};
      app.handle.bump();
    });
    expect(h.c.getClip('fake-clip')?.contributesToSinger).toBe(false);
  });

  it('moves the contribution when the singer changes, and renames it when the clip is renamed', async () => {
    const store = await seededStore();
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    await act1(() => h.c.setContributes('fake-clip', true));
    app.handle.calls.length = 0;
    await act1(() => h.c.updateClip('fake-clip', { title: 'Renamed' }));
    expect(app.handle.calls).toEqual(['add:shawn-mendes:fake-clip']);
    expect(app.handle.measured['shawn-mendes'][0].name).toBe('Renamed');
    app.handle.calls.length = 0;
    await act1(() => h.c.updateClip('fake-clip', { singerId: 'daniel-caesar' }));
    expect(app.handle.calls).toEqual(['remove:shawn-mendes:fake-clip', 'add:daniel-caesar:fake-clip']);
    expect(h.c.getClip('fake-clip')?.contributesToSinger).toBe(true);
    app.handle.calls.length = 0;
    await act1(() => h.c.updateClip('fake-clip', { singerId: null, singerLabel: 'A friend' }));
    expect(app.handle.calls).toEqual(['remove:daniel-caesar:fake-clip']);
    expect((await store.getClip('fake-clip'))?.contributesToSinger).toBe(false);
  });

  it('leaves the targets alone when a clip that is not contributing is edited', async () => {
    const app = createFakeApp();
    const h = await mount({ props: { store: await seededStore() }, app });
    await act1(() => h.c.updateClip('fake-clip', { title: 'Renamed', singerId: 'jalen-ngonda' }));
    expect(app.handle.calls).toEqual([]);
  });

  it('deleting a contributing clip takes its measurements out of the singer\'s targets', async () => {
    const store = await seededStore();
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    await act1(() => h.c.setContributes('fake-clip', true));
    await act1(() => h.c.deleteClip('fake-clip'));
    expect(app.handle.calls.at(-1)).toBe('remove:shawn-mendes:fake-clip');
    expect(h.c.clips).toEqual([]);
  });
});

describe('stale targets', () => {
  it('a deleted clip leaves the targets even when its stored flag said it did not contribute', async () => {
    const clip = makeFakeClip({ contributesToSinger: false });
    const app = createFakeApp({ 'shawn-mendes': [measuredFromClip(clip)] });
    const h = await mount({ props: { store: await seededStore([clip]) }, app });
    await act1(() => h.c.deleteClip('fake-clip'));
    expect(app.handle.calls).toEqual(['remove:shawn-mendes:fake-clip']);
  });

  it('turning contribution off removes it from whichever singer holds it', async () => {
    const clip = makeFakeClip({ contributesToSinger: true, singerId: 'daniel-caesar' });
    const app = createFakeApp({ 'shawn-mendes': [measuredFromClip(clip)] });
    const h = await mount({ props: { store: await seededStore([clip]) }, app });
    await act1(() => h.c.setContributes('fake-clip', false));
    expect(app.handle.calls).toEqual(['remove:shawn-mendes:fake-clip']);
  });
});

describe('reading a clip\'s audio for the phrase editor', () => {
  it('gives the stored samples, preferring the vocal-only file, and null when the audio is not on the device', async () => {
    const store = createMemoryClipStore();
    const mix = await store.writeAudio('fake-clip', 'mix', new Int16Array(44100).fill(500), 44100);
    await store.putClip({ ...makeFakeClip(), audio: { mix, vocal: null } });
    const h = await mount({ props: { store } });
    const got = await act1(() => h.c.readClipSamples!('fake-clip'));
    expect(got).toMatchObject({ sampleRate: 44100, source: 'mix' });
    expect(got!.samples.length).toBe(44100);

    const vocal = await store.writeAudio('fake-clip', 'vocal', new Int16Array(22050).fill(1000), 22050);
    await store.putClip({ ...makeFakeClip(), audio: { mix, vocal } });
    const stem = await act1(() => h.c.readClipSamples!('fake-clip'));
    expect(stem).toMatchObject({ sampleRate: 22050, source: 'vocal' });
    expect(stem!.samples.length).toBe(22050);

    await store.putClip({ ...makeFakeClip(), audio: { mix, vocal }, audioMissing: true });
    expect(await act1(() => h.c.readClipSamples!('fake-clip'))).toBeNull();
    await expect(h.c.readClipSamples!('ghost')).rejects.toThrow(/no longer in the library/);
  });
});

describe('deleting', () => {
  it('removes the clip with its audio, attempts and queue entries', async () => {
    const store = await seededStore([makeFakeClip(), makeFakeClip({ id: 'second', phrases: makeFakeClip().phrases.map((p) => ({ ...p, id: `second-${p.id}` })) })], makeFakeAttempts());
    const h = await mount({ props: { store } });
    expect(h.c.clips).toHaveLength(2);
    await act1(() => h.c.deleteClip('fake-clip'));
    expect(h.c.clips.map((c) => c.id)).toEqual(['second']);
    expect(await store.listAttempts({ clipId: 'fake-clip' })).toEqual([]);
    expect((await store.usage()).audioBytes).toBe(44100 * 2);
    expect(h.c.queue.every((i) => i.phraseId.startsWith('second-'))).toBe(true);
  });

  it('deleting a clip that is already gone is not an error', async () => {
    const h = await mount({ props: { store: await seededStore() } });
    await act1(() => h.c.deleteClip('ghost'));
    expect(h.c.clips).toHaveLength(1);
  });
});

describe('attempts', () => {
  it('lists and deletes attempts newest first, and rebuilds the phrase stats from what is left', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    const due = h.c.queue.find((i) => i.status === 'review-due');
    expect(due).toBeDefined();
    const phrase = (h.c.getClip('fake-clip') as ClipRecord).phrases.find((p) => p.id === due?.phraseId) as PhraseRecord;
    const list = await h.c.listAttempts({ phraseId: phrase.id });
    expect(list.length).toBe(phrase.stats.attempts);
    expect(list.map((a) => a.at)).toEqual([...list.map((a) => a.at)].sort((a, b) => b - a));
    expect(await h.c.listAttempts({ phraseId: phrase.id, limit: 2 })).toHaveLength(2);
    const removed = await act1(() => h.c.deleteAttempts({ phraseId: phrase.id }));
    expect(removed).toBe(list.length);
    const after = (h.c.getClip('fake-clip') as ClipRecord).phrases.find((p) => p.id === phrase.id);
    expect(after?.stats).toEqual({ attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null });
    expect(after?.srs).toEqual({ rung: 0, dueAt: null, masteredAt: null });
    expect(after?.keyHint).toBeNull();
    expect(h.c.queue.some((i) => i.phraseId === phrase.id && i.status === 'review-due')).toBe(false);
    // other phrases keep their history
    const other = (h.c.getClip('fake-clip') as ClipRecord).phrases.find((p) => p.id !== phrase.id && p.stats.attempts > 0);
    expect(other?.stats.attempts).toBeGreaterThan(0);
  });

  it('deleting a clip\'s attempts resets every phrase of the clip', async () => {
    const h = await mount({ props: { store: await seededStore() } });
    await act1(() => h.c.deleteAttempts({ clipId: 'fake-clip' }));
    expect(h.c.getClip('fake-clip')?.phrases.every((p) => p.stats.attempts === 0 && p.srs.rung === 0)).toBe(true);
    expect(h.c.queue.every((i) => i.status === 'new')).toBe(true);
  });
});

describe('practice sessions', () => {
  const sessions: PracticeSession[] = [];
  const openPractice = async (s: PracticeSession) => (sessions.push(s), new FakeTrainerEngine({ clip: s.clip, phrase: s.phrase }));
  beforeEach(() => void (sessions.length = 0));

  const good = (phraseId: string, n: number, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
    ...makeFakeAttempts()[0],
    id: `live-${phraseId}-${n}`,
    clipId: 'fake-clip',
    phraseId,
    at: FAKE_NOW + n * 60_000,
    rate: 1,
    coverage: 1,
    wrongNotes: 0,
    trust: 'ok',
    transposeSemitones: -12,
    hasAudio: false,
    scores: { overall: 91, pitch: 94, timing: 90, tone: 88, expression: 90 },
    ...over,
  });

  it('says what is missing instead of opening a practice screen it cannot build', async () => {
    const store = await seededStore([makeFakeClip(), makeFakeClip({ id: 'gone', audioMissing: true, phrases: makeFakeClip().phrases.map((p) => ({ ...p, id: `gone-${p.id}` })) })], []);
    const h = await mount({ props: { store } });
    await expect(h.c.openPractice('fake-clip', 'fake-clip-p1')).rejects.toThrow(/not connected to the audio engine/);
    const h2 = await mount({ props: { store, openPractice } });
    await expect(h2.c.openPractice('gone', 'gone-fake-clip-p1')).rejects.toThrow(/needs its audio file again/);
    await expect(h2.c.openPractice('fake-clip', 'nope')).rejects.toThrow(/phrase is no longer/);
    await expect(h2.c.openPractice('ghost', 'x')).rejects.toThrow(/no longer in the library/);
    expect(sessions).toEqual([]);
  });

  it('hands the engine the clip, phrase, store and settings, and returns its engine', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice }, app: createFakeApp() });
    const engine = await act1(() => h.c.openPractice('fake-clip', 'fake-clip-p5'));
    expect(engine).toBeInstanceOf(FakeTrainerEngine);
    expect(sessions[0]).toMatchObject({ settings: SETTINGS });
    expect(sessions[0].clip.id).toBe('fake-clip');
    expect(sessions[0].phrase.id).toBe('fake-clip-p5');
    expect(sessions[0].store).toBe(store);
  });

  it('records an attempt: stored, phrase stats and key hint updated, queue refreshed, backup counter up', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice } });
    const target = h.c.queue.find((i) => i.status === 'learning');
    expect(target).toBeDefined();
    const id = (target as { phraseId: string }).phraseId;
    await act1(() => h.c.openPractice('fake-clip', id));
    const before = (h.c.getClip('fake-clip') as ClipRecord).phrases.find((p) => p.id === id) as PhraseRecord;
    const result = await act1(() => sessions[0].recordAttempt(good(id, 1)));
    expect(result).toMatchObject({ saved: true, notice: null });
    expect(result.phrase.stats).toMatchObject({ attempts: before.stats.attempts + 1, last: 91 });
    expect(result.phrase.stats.recent.at(-1)).toBe(91);
    expect(result.phrase.keyHint).toBe(-12);
    expect(await store.listAttempts({ phraseId: id })).toHaveLength(before.stats.attempts + 1);
    expect((await store.getClip('fake-clip'))?.phrases.find((p) => p.id === id)?.stats.attempts).toBe(before.stats.attempts + 1);
    expect(h.c.queue.find((i) => i.phraseId === id)?.reason).toMatch(/Last 91/);
    expect(await store.getMeta('attemptsSinceExport')).toBe(1);
    expect(h.x.exportReminder.message).toMatch(/over a week/); // never exported, and the clip is ten days old
  });

  it('masters a phrase after three good takes and schedules the review', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice } });
    const id = (h.c.queue.find((i) => i.status === 'learning') as { phraseId: string }).phraseId;
    await act1(() => h.c.openPractice('fake-clip', id));
    for (let n = 1; n <= 3; n++) await act1(() => sessions[0].recordAttempt(good(id, n)));
    const phrase = (h.c.getClip('fake-clip') as ClipRecord).phrases.find((p) => p.id === id);
    expect(phrase?.srs.rung).toBe(1);
    expect(phrase?.srs.dueAt).toBe(FAKE_NOW + 3 * 60_000 + DAY);
    expect(h.c.queue.some((i) => i.phraseId === id)).toBe(false);
  });

  it('does not count a take that sounded like the playback', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice } });
    await act1(() => h.c.openPractice('fake-clip', 'fake-clip-p11'));
    const result = await act1(() => sessions[0].recordAttempt(good('fake-clip-p11', 1, { trust: 'invalid' })));
    expect(result.saved).toBe(false);
    expect(result.notice).toMatch(/Use headphones and try again/);
    expect(await store.listAttempts({ phraseId: 'fake-clip-p11' })).toEqual([]);
  });

  it('keeps the newest three recordings of a phrase', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice } });
    await act1(() => h.c.openPractice('fake-clip', 'fake-clip-p11'));
    for (let n = 1; n <= 5; n++) await act1(() => sessions[0].recordAttempt(good('fake-clip-p11', n), { pcm: new Int16Array(1000), sampleRate: 44100 }));
    const stored = await store.listAttempts({ phraseId: 'fake-clip-p11' });
    expect(stored.map((a) => a.hasAudio)).toEqual([true, true, true, false, false]);
    expect((await store.usage()).audioBytes).toBe(44100 * 2 + 3 * 2000);
  });

  it('saves the score without the recording when the device has no room, and says so', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice } });
    await act1(() => h.c.openPractice('fake-clip', 'fake-clip-p11'));
    vi.spyOn(store, 'addAttempt').mockImplementationOnce(() => Promise.reject(new QuotaError('full')));
    const result = await act1(() => sessions[0].recordAttempt(good('fake-clip-p11', 1), { pcm: new Int16Array(1000), sampleRate: 44100 }));
    expect(result.saved).toBe(true);
    expect(result.notice).toMatch(/not enough room to keep the recording.*Keep my recordings/);
    const stored = await store.listAttempts({ phraseId: 'fake-clip-p11' });
    expect(stored).toHaveLength(1);
    expect(stored[0].hasAudio).toBe(false);
  });

  it('refuses an attempt for another clip or a phrase that is gone', async () => {
    const h = await mount({ props: { store: await seededStore(), openPractice } });
    await act1(() => h.c.openPractice('fake-clip', 'fake-clip-p11'));
    await expect(sessions[0].recordAttempt(good('fake-clip-p11', 1, { clipId: 'other' }))).rejects.toThrow(/different clip/);
    await expect(sessions[0].recordAttempt(good('missing-phrase', 1))).rejects.toThrow(/phrase is no longer/);
  });

  it('a take recorded while the clip is being renamed keeps both changes', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice } });
    await act1(() => h.c.openPractice('fake-clip', 'fake-clip-p11'));
    await act1(() => Promise.all([sessions[0].recordAttempt(good('fake-clip-p11', 1)), h.c.updateClip('fake-clip', { title: 'Renamed mid-take' }), sessions[0].recordAttempt(good('fake-clip-p11', 2))]));
    const stored = (await store.getClip('fake-clip')) as ClipRecord;
    expect(stored.title).toBe('Renamed mid-take');
    expect(stored.phrases[10].stats.attempts).toBe(2);
  });

  it('keeps the calibration the engine learns', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, openPractice } });
    await act1(() => h.c.openPractice('fake-clip', 'fake-clip-p11'));
    expect(await sessions[0].getCalibration()).toEqual({});
    await sessions[0].setCalibration('wired', 92);
    await sessions[0].setCalibration('bluetooth', 210);
    await sessions[0].setCalibration('', 5);
    await sessions[0].setCalibration('wired', NaN);
    expect(await sessions[0].getCalibration()).toEqual({ wired: 92, bluetooth: 210 });
  });

  it('trims the history of a phrase that has more attempts than it keeps', async () => {
    const store = createMemoryClipStore();
    const base = makeFakeClip({ id: 'fake-clip' });
    const phrase = { ...base.phrases[0], stats: { ...base.phrases[0].stats, attempts: MAX_ATTEMPTS_PER_PHRASE } };
    await store.putClip({ ...base, phrases: [phrase, ...base.phrases.slice(1)] });
    await store.writeAudio('fake-clip', 'mix', new Int16Array(100), 44100);
    for (let n = 0; n < MAX_ATTEMPTS_PER_PHRASE + 2; n++) await store.addAttempt(good(phrase.id, n - 500));
    const h = await mount({ props: { store, openPractice } });
    await act1(() => h.c.openPractice('fake-clip', phrase.id));
    await act1(() => sessions[0].recordAttempt(good(phrase.id, 1)));
    expect((await store.listAttempts({ phraseId: phrase.id })).length).toBe(MAX_ATTEMPTS_PER_PHRASE);
  });
});

describe('export and import', () => {
  it('exports a JSON backup with no audio and resets the backup reminder', async () => {
    const store = await seededStore();
    await store.setMeta('attemptsSinceExport', 12);
    await store.setMeta('calibration', { wired: 90 });
    const h = await mount({ props: { store } });
    expect(h.x.exportReminder.due).toBe(true);
    const blob = await act1(() => h.c.exportLibrary());
    expect(blob.type).toBe('application/json');
    const json = JSON.parse(await blob.text());
    expect(json).toMatchObject({ format: 'mimic-library', version: 1, calibration: { wired: 90 } });
    expect(json.clips).toHaveLength(1);
    expect(json.attempts.length).toBe(makeFakeAttempts().length);
    expect(JSON.stringify(json)).not.toMatch(/"pcm"/);
    expect(h.x.exportReminder.due).toBe(false);
    expect(await store.getMeta('attemptsSinceExport')).toBe(0);
    expect(typeof (await store.getMeta('lastExportAt'))).toBe('string');
  });

  it('keeps the reminder on until the file is saved when asked to (a closed share sheet is not a backup)', async () => {
    const store = await seededStore();
    await store.setMeta('attemptsSinceExport', 12);
    const h = await mount({ props: { store } });
    expect(h.x.exportReminder.due).toBe(true);
    const blob = await act1(() => h.c.exportLibrary({ markDone: false }));
    expect(JSON.parse(await blob.text()).clips).toHaveLength(1);
    expect(h.x.exportReminder.due).toBe(true);
    expect(await store.getMeta('attemptsSinceExport')).toBe(12);
    await act1(() => h.c.markExported!());
    expect(h.x.exportReminder.due).toBe(false);
    expect(await store.getMeta('attemptsSinceExport')).toBe(0);
    expect(typeof (await store.getMeta('lastExportAt'))).toBe('string');
    // Nothing pending: a second call changes nothing.
    await act1(() => h.c.markExported!());
    expect(await store.getMeta('attemptsSinceExport')).toBe(0);
  });

  it('counts the takes saved while the share sheet was open toward the next reminder', async () => {
    const store = await seededStore();
    await store.setMeta('attemptsSinceExport', 12);
    const sessions: PracticeSession[] = [];
    const h = await mount({ props: { store, openPractice: async (x) => (sessions.push(x), new FakeTrainerEngine({ clip: x.clip, phrase: x.phrase })) } });
    const id = (h.c.queue[0] as { phraseId: string }).phraseId;
    await act1(() => h.c.openPractice('fake-clip', id));
    await act1(() => h.c.exportLibrary({ markDone: false }));
    const take = { ...makeFakeAttempts()[0], id: 'during-share', clipId: 'fake-clip', phraseId: id, at: FAKE_NOW + 1000, trust: 'ok' as const, hasAudio: false };
    await act1(() => sessions[0].recordAttempt(take));
    expect(await store.getMeta('attemptsSinceExport')).toBe(13);
    await act1(() => h.c.markExported!());
    // The file did not contain the take made meanwhile, so it still counts.
    expect(await store.getMeta('attemptsSinceExport')).toBe(1);
  });

  it('still produces a backup of what is on screen when the store can no longer be read', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    vi.spyOn(store, 'listClips').mockRejectedValue(new Error('gone'));
    const blob = await act1(() => h.c.exportLibrary());
    expect(JSON.parse(await blob.text()).clips).toHaveLength(1);
  });

  it('round trip: export, wipe, import on a clean install, then relink the audio by fingerprint', async () => {
    const log: string[] = [];
    const sourceStore = await seededStore([makeFakeClip({ contributesToSinger: true })]);
    const source = await mount({ props: { store: sourceStore }, app: createFakeApp() });
    const blob = await act1(() => source.c.exportLibrary());
    const original = source.c.getClip('fake-clip') as ClipRecord;
    await source.unmount();

    const targetStore = createMemoryClipStore();
    const app = createFakeApp();
    const target = await mount({ props: { store: targetStore, importer: fakeImporter(log) }, app });
    const file = new File([await blob.text()], 'mimic-library-2026-10-08.json', { type: 'application/json' });
    const result = await act1(() => target.c.importLibrary(file));
    expect(result).toEqual({ added: 1, updated: 0, warnings: [] });

    const imported = target.c.getClip('fake-clip') as ClipRecord;
    expect(imported.audioMissing).toBe(true);
    expect({ ...imported, audioMissing: false, contributesToSinger: original.contributesToSinger }).toEqual(original);
    expect(await targetStore.listAttempts({ clipId: 'fake-clip' })).toHaveLength(makeFakeAttempts().length);
    expect(target.c.queue).toEqual([]); // nothing to practise until the audio is back
    expect(app.handle.calls).toEqual(['add:shawn-mendes:fake-clip']); // the clip's targets came back with it

    // The same file, picked again, is recognised.
    const candidates = findRelinkCandidates(target.c.clips, { fingerprint: original.fingerprint, fileName: original.sourceFileName, durationSec: 84 });
    expect(candidates.map((c) => c.id)).toEqual(['fake-clip']);
    const relinked = await act1(() => target.c.relinkClip('fake-clip', makeFakePreparedClip({ fingerprint: original.fingerprint })));
    expect(relinked.audioMissing).toBe(false);
    expect(log).toEqual(['relink']);
    expect((await targetStore.getClip('fake-clip'))?.audioMissing).toBe(false);
    expect(target.c.queue.length).toBe(5);
    await expect(target.c.relinkClip('fake-clip', makeFakePreparedClip())).rejects.toThrow(/already has its audio/);
  });

  it('importing the same backup again adds nothing and duplicates no attempts', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    const text = await (await act1(() => h.c.exportLibrary())).text();
    const first = await act1(() => h.c.importLibrary(new File([text], 'b.json')));
    expect(first).toEqual({ added: 0, updated: 0, warnings: [] });
    expect(await store.listAttempts({})).toHaveLength(makeFakeAttempts().length);
    expect((await store.getClip('fake-clip'))?.audioMissing).toBe(false);
  });

  it('merges attempts from another copy and rebuilds the phrase stats from the union', async () => {
    const store = await seededStore([makeFakeClip()], makeFakeAttempts().filter((a) => a.phraseId !== 'fake-clip-p5' || a.at < FAKE_NOW - DAY));
    const h = await mount({ props: { store } });
    const before = (h.c.getClip('fake-clip') as ClipRecord).phrases[4].stats.attempts;
    const full = createMemoryClipStore();
    const clip = makeFakeClip();
    await full.putClip(clip);
    for (const a of makeFakeAttempts()) await full.addAttempt(a);
    const other = await mount({ props: { store: full } });
    const text = await (await act1(() => other.c.exportLibrary())).text();
    const r = await act1(() => h.c.importLibrary(new File([text], 'b.json')));
    expect(r.added).toBe(0);
    const after = (h.c.getClip('fake-clip') as ClipRecord).phrases[4];
    expect(after.stats.attempts).toBeGreaterThanOrEqual(before);
    expect(after.stats.attempts).toBe(makeFakeAttempts().filter((a) => a.phraseId === 'fake-clip-p5').length);
  });

  it('refuses things that are not backups, with a message that says what to do', async () => {
    const h = await mount({ props: { store: await seededStore() } });
    await expect(h.c.importLibrary(new File(['{"format": "mimic-lib'], 'x.json'))).rejects.toThrow(/not readable JSON/);
    await expect(h.c.importLibrary(new File([JSON.stringify({ format: 'mimic-library', version: 2 })], 'x.json'))).rejects.toThrow(/newer version of Mimic.*Update the app/);
    await expect(h.c.importLibrary(new File(['[]'], 'x.json'))).rejects.toThrow(/not a Mimic library backup/);
    const huge = { size: 200e6, text: async () => '' } as unknown as File;
    await expect(h.c.importLibrary(huge)).rejects.toThrow(/far larger than a Mimic backup/);
    expect(h.c.clips).toHaveLength(1);
  });

  it('reports the entries it had to skip', async () => {
    const h = await mount({ props: { store: createMemoryClipStore() } });
    const lib = { format: 'mimic-library', version: 1, exportedAt: '2026-10-08T00:00:00Z', clips: [makeFakeClip(), { id: 'bad', title: 'Bad one' }], attempts: [{ nope: true }], calibration: {} };
    const r = await act1(() => h.c.importLibrary(new File([JSON.stringify(lib)], 'x.json')));
    expect(r.added).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/1 clip could not be read.*"Bad one"/);
    expect(r.warnings.join(' ')).toMatch(/1 practice attempt could not be read/);
  });

  it('skips attempts whose phrase has since been edited away on this device', async () => {
    const store = await seededStore([makeFakeClip({ updatedAt: new Date(FAKE_NOW + 5 * DAY).toISOString() })], []);
    const h = await mount({ props: { store } });
    const clip = h.c.getClip('fake-clip') as ClipRecord;
    await act1(() => h.c.updatePhrases('fake-clip', clip.phrases.slice(0, 3)));
    const lib = { format: 'mimic-library', version: 1, exportedAt: '2026-10-08T00:00:00Z', clips: [makeFakeClip()], attempts: makeFakeAttempts(), calibration: {} };
    const r = await act1(() => h.c.importLibrary(new File([JSON.stringify(lib)], 'x.json')));
    expect(r.warnings.join(' ')).toMatch(/practice attempts were skipped because their phrases have been edited or removed/);
    expect((await store.listAttempts({})).every((a) => ['fake-clip-p1', 'fake-clip-p2', 'fake-clip-p3'].includes(a.phraseId))).toBe(true);
  });

  it('does not bring back targets for a clip whose singer the app no longer has', async () => {
    const h = await mount({ props: { store: createMemoryClipStore() }, app: createFakeApp() });
    const lib = { format: 'mimic-library', version: 1, exportedAt: '2026-10-08T00:00:00Z', clips: [makeFakeClip({ singerId: 'retired-singer', contributesToSinger: true })], attempts: [], calibration: {} };
    await act1(() => h.c.importLibrary(new File([JSON.stringify(lib)], 'x.json')));
    expect(h.c.getClip('fake-clip')?.contributesToSinger).toBe(false);
  });

  it('keeps this device\'s calibration and learns routes it did not have', async () => {
    const store = createMemoryClipStore();
    await store.setMeta('calibration', { wired: 80 });
    const h = await mount({ props: { store } });
    const lib = { format: 'mimic-library', version: 1, exportedAt: '2026-10-08T00:00:00Z', clips: [], attempts: [], calibration: { wired: 120, bluetooth: 210 } };
    await act1(() => h.c.importLibrary(new File([JSON.stringify(lib)], 'x.json')));
    expect(await store.getMeta('calibration')).toEqual({ wired: 80, bluetooth: 210 });
  });
});

describe('adding clips', () => {
  const settingsSeen: AppSettings[] = [];
  const importer = (log: string[] = []): Partial<TrainerImporter> => ({
    ...fakeImporter(log),
    prepareClip: async (file, settings) => (settingsSeen.push(settings), makeFakePreparedClip({ file: { name: file.name, size: file.size } })),
  });

  it('prepares with the app settings and stores nothing until the clip is committed', async () => {
    const store = createMemoryClipStore();
    const h = await mount({ props: { store, importer: importer() }, app: createFakeApp() });
    const prepared = await act1(() => h.c.prepareClip(new File(['x'], 'song.m4a')));
    expect(prepared.file.name).toBe('song.m4a');
    expect(settingsSeen.at(-1)).toEqual(SETTINGS);
    expect(await store.listClips()).toEqual([]);
  });

  it('commits through the importer, shows the clip, and refreshes the storage figures', async () => {
    stubStorage({ estimate: async () => ({ usage: 1e6, quota: 6e9 }), persisted: async () => true });
    const log: string[] = [];
    const store = createMemoryClipStore();
    const h = await mount({ props: { store, importer: importer(log) } });
    const clip = await act1(() => h.c.commitClip(makeFakePreparedClip(), EDITS({ title: 'Verse' })));
    expect(log).toEqual(['commit']);
    expect(clip).toMatchObject({ id: 'imported-1', title: 'Verse', contributesToSinger: false });
    expect(h.c.clips.map((c) => c.id)).toEqual(['imported-1']);
    expect((await store.getClip('imported-1'))?.title).toBe('Verse');
  });

  it('adds the clip\'s measurements to the singer when asked, and only when the clip can give them', async () => {
    const app = createFakeApp();
    const h = await mount({ props: { store: createMemoryClipStore(), importer: importer() }, app });
    const clip = await act1(() => h.c.commitClip(makeFakePreparedClip(), EDITS({ contributeToSinger: true })));
    expect(clip.contributesToSinger).toBe(true);
    expect(app.handle.calls).toEqual(['add:shawn-mendes:imported-1']);

    const none = createFakeApp();
    const h2 = await mount({ props: { store: createMemoryClipStore(), importer: importer() }, app: none });
    const other = await act1(() => h2.c.commitClip(makeFakePreparedClip(), EDITS({ contributeToSinger: true, singerId: null, singerLabel: 'Someone' })));
    expect(other.contributesToSinger).toBe(false);
    expect(none.handle.calls).toEqual([]);
  });

  it('takes back everything a failed import already wrote (a clip is stored whole or not at all)', async () => {
    const store = createMemoryClipStore();
    const failing: Partial<TrainerImporter> = {
      commitClip: async (_p, _e, s) => {
        await s.putClip(makeFakeClip({ id: 'half' }));
        await s.writeAudio('half', 'mix', new Int16Array(44100), 44100);
        throw new QuotaError('The device has no room for this clip.');
      },
    };
    const h = await mount({ props: { store, importer: failing } });
    await expect(h.c.commitClip(makeFakePreparedClip(), EDITS())).rejects.toBeInstanceOf(QuotaError);
    expect(await store.listClips()).toEqual([]);
    expect((await store.usage()).audioBytes).toBe(0);
    expect(h.c.clips).toEqual([]);
  });

  it('does not delete a clip that was already in the library when an import fails', async () => {
    const store = await seededStore();
    const failing: Partial<TrainerImporter> = {
      commitClip: async (_p, _e, s) => {
        await s.putClip({ ...makeFakeClip(), title: 'touched' });
        throw new Error('boom');
      },
    };
    const h = await mount({ props: { store, importer: failing } });
    await expect(h.c.commitClip(makeFakePreparedClip(), EDITS())).rejects.toThrow('boom');
    expect((await store.getClip('fake-clip'))?.title).toBe('touched'); // still there, as the importer left it
  });

  it('refuses a clip that cannot fit, before doing any work, and names the next step', async () => {
    stubStorage({ estimate: async () => ({ usage: 5.99e9, quota: 6e9 }), persisted: async () => true });
    const log: string[] = [];
    const h = await mount({ props: { store: createMemoryClipStore(), importer: importer(log) } });
    const big = makeFakePreparedClip({ durationSec: 600, sampleRate: 48000 });
    const err = await h.c.commitClip(big, EDITS()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect((err as Error).message).toMatch(/Not enough room.*Trim the clip|Remove clips/);
    expect(log).toEqual([]);
    // Trimmed to the part the singer wants, the same file fits.
    const trimmed = await act1(() => h.c.commitClip(big, EDITS({ trim: { startSec: 0, endSec: 5 } })));
    expect(trimmed.id).toBe('imported-1');
    expect(log).toEqual(['commit']);
  });

  it('warns at the review step when the clip would use most of the space that is left', async () => {
    stubStorage({ estimate: async () => ({ usage: 0, quota: 10e6 }), persisted: async () => true });
    const h = await mount({ props: { store: createMemoryClipStore(), importer: { prepareClip: async () => makeFakePreparedClip({ samples: new Float32Array(44100 * 100), sampleRate: 44100, durationSec: 100 }) } } });
    const prepared = await act1(() => h.c.prepareClip(new File(['x'], 'long.wav')));
    expect(prepared.warnings.join(' ')).toMatch(/would use most of the space that is left.*Trim it to the part you want/);
  });

  it('asks the browser to keep the data once, from the tap that saves the first clip', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ estimate: async () => ({ usage: 1, quota: 1e10 }), persisted: async () => false, persist });
    const store = createMemoryClipStore();
    const h = await mount({ props: { store, importer: importer() } });
    await act1(() => h.c.commitClip(makeFakePreparedClip(), EDITS()));
    await settle();
    expect(persist).toHaveBeenCalledTimes(1);
    await act1(() => h.c.commitClip(makeFakePreparedClip(), EDITS({ title: 'Second' })));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(typeof (await store.getMeta('lastPersistRequestAt'))).toBe('string');
  });

  it('exposes persistence as an action for Settings', async () => {
    stubStorage({ estimate: async () => ({ usage: 1, quota: 1e10 }), persisted: async () => false, persist: async () => true });
    const h = await mount({ props: { store: createMemoryClipStore() } });
    expect(await act1(() => h.x.requestPersistence())).toBe(true);
  });
});

describe('with the real importer (trainer/import.ts)', () => {
  const prepared = () => makeFakePreparedClip({ samples: new Float32Array(44100 * 21), sampleRate: 44100, durationSec: 21 });
  const edits = (p: ReturnType<typeof prepared>, over: Record<string, unknown> = {}) => EDITS({ title: 'Real import', phrases: p.phrases, ...over });

  it('stores the audio and the clip, lists it, and the library export describes it without audio', async () => {
    const store = createMemoryClipStore();
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    const p = prepared();
    const clip = await act1(() => h.c.commitClip(p, edits(p, { contributeToSinger: true })));
    expect(clip.title).toBe('Real import');
    expect(clip.audioMissing).toBe(false);
    expect(clip.phrases.length).toBeGreaterThan(0);
    expect((await store.usage()).audioBytes).toBe(clip.audio.mix.frames * 2);
    expect(await store.readAudio(clip.id, clip.audio.mix, 0, 1)).toHaveLength(44100);
    expect(h.c.clips.map((c) => c.id)).toEqual([clip.id]);
    expect(h.c.queue.length).toBe(Math.min(5, clip.phrases.length));
    // the measured clip comes from clipFromAnalysis with the clip's id, so the toggle stays symmetric
    if (clip.contributesToSinger) expect(app.handle.measured['shawn-mendes'][0].id).toBe(clip.id);
    const json = JSON.parse(await (await act1(() => h.c.exportLibrary())).text());
    expect(json.clips[0].id).toBe(clip.id);
    expect(JSON.stringify(json)).not.toMatch(/"pcm"/);
  });

  it('refuses without ownership confirmed, and leaves nothing behind', async () => {
    const store = createMemoryClipStore();
    const h = await mount({ props: { store } });
    const p = prepared();
    await expect(h.c.commitClip(p, edits(p, { ownedConfirmed: false }))).rejects.toThrow(/right to practise/);
    expect(await store.usage()).toEqual({ clips: 0, attempts: 0, audioBytes: 0 });
  });

  it('relinks the audio of an imported clip from the same file', async () => {
    const source = createMemoryClipStore();
    const a = await mount({ props: { store: source } });
    const p = prepared();
    const clip = await act1(() => a.c.commitClip(p, edits(p)));
    const text = await (await act1(() => a.c.exportLibrary())).text();
    await a.unmount();

    const target = createMemoryClipStore();
    const b = await mount({ props: { store: target } });
    await act1(() => b.c.importLibrary(new File([text], 'backup.json')));
    expect(b.c.getClip(clip.id)?.audioMissing).toBe(true);
    const relinked = await act1(() => b.c.relinkClip(clip.id, p));
    expect(relinked.audioMissing).toBe(false);
    expect(await target.readAudio(clip.id, relinked.audio.mix, 0, 1)).toHaveLength(44100);
    expect(b.c.queue.length).toBeGreaterThan(0);
  });
});

describe('clearing everything', () => {
  it('deletes clips, attempts, audio and settings in the store, and the clips\' targets', async () => {
    const store = await seededStore([makeFakeClip({ contributesToSinger: true })]);
    const app = createFakeApp({ 'shawn-mendes': [measuredFromClip(makeFakeClip())] });
    const h = await mount({ props: { store }, app });
    await act1(() => h.c.clearAll());
    expect(h.c.clips).toEqual([]);
    expect(h.c.queue).toEqual([]);
    expect(await store.usage()).toEqual({ clips: 0, attempts: 0, audioBytes: 0 });
    expect(app.handle.calls).toEqual(['remove:shawn-mendes:fake-clip']);
    expect(h.c.status).toBe('ready');
  });

  it('is reached from AppController.clearAllData through the onClear hook, and unhooks on unmount', async () => {
    const store = await seededStore();
    const app = createFakeApp();
    const h = await mount({ props: { store }, app });
    expect(app.handle.hooks).toHaveLength(1);
    await act(async () => {
      await Promise.all(app.handle.hooks.map((fn) => fn()));
    });
    expect(h.c.clips).toEqual([]);
    expect((await store.usage()).clips).toBe(0);
    await h.unmount();
    expect(app.handle.hooks).toHaveLength(0);
  });
});

describe('a store that stops answering', () => {
  it('turns into an error state with the next step, keeps the clips on screen, and still lets the singer export', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    vi.spyOn(store, 'putClip').mockRejectedValue(new StoreUnavailableError('Your library could not be reached. Export a backup, then reload the app.'));
    await expect(h.c.updateClip('fake-clip', { title: 'x' })).rejects.toThrow(/Export a backup/);
    await settle();
    expect(h.c.status).toBe('error');
    expect(h.c.error).toMatch(/Export a backup, then reload the app/);
    expect(h.c.clips).toHaveLength(1);
    const blob = await act1(() => h.c.exportLibrary());
    expect(JSON.parse(await blob.text()).clips).toHaveLength(1);
  });

  it('recovers on its own when the store works again', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    vi.spyOn(store, 'putClip').mockRejectedValueOnce(new StoreUnavailableError('Your library could not be reached. Export a backup, then reload the app.'));
    await expect(h.c.updateClip('fake-clip', { title: 'x' })).rejects.toThrow();
    await settle();
    expect(h.c.status).toBe('error');
    await act1(() => h.c.updateClip('fake-clip', { title: 'It works again' }));
    expect(h.c).toMatchObject({ status: 'ready', error: null });
    expect((await store.getClip('fake-clip'))?.title).toBe('It works again');
  });

  it('reload() after a failed load brings the library back', async () => {
    const store = await seededStore();
    let fail = true;
    const flaky: ClipStore = { ...store, listClips: () => (fail ? Promise.reject(new StoreUnavailableError('Your library could not be reached. Export a backup, then reload the app.')) : store.listClips()) };
    const h = await mount({ props: { store: flaky } });
    expect(h.c.status).toBe('error');
    fail = false;
    await act1(() => h.x.reload());
    expect(h.c.status).toBe('ready');
    expect(h.c.clips).toHaveLength(1);
  });

  it('other failures (a full device) are reported to the caller without breaking the library', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store } });
    vi.spyOn(store, 'putClip').mockRejectedValueOnce(new QuotaError('The device has no room for this clip.'));
    await expect(h.c.updateClip('fake-clip', { title: 'x' })).rejects.toBeInstanceOf(QuotaError);
    expect(h.c.status).toBe('ready');
  });
});

describe('several tabs', () => {
  class FakeChannel {
    static all: FakeChannel[] = [];
    posted: unknown[] = [];
    onmessage: ((e: unknown) => void) | null = null;
    closed = false;
    constructor(public name: string) {
      FakeChannel.all.push(this);
    }
    postMessage(m: unknown) {
      this.posted.push(m);
    }
    close() {
      this.closed = true;
    }
  }

  beforeEach(() => {
    FakeChannel.all = [];
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });

  it('tells the other tabs about a change and reloads when they tell it', async () => {
    const store = await seededStore();
    const h = await mount({ props: { store, syncTabs: true } });
    const channel = FakeChannel.all[0];
    expect(channel.name).toBe('mimic-trainer-library');
    await act1(() => h.c.updateClip('fake-clip', { title: 'Mine' }));
    expect(channel.posted).toContain('changed');

    // Another tab saves a new clip; this one finds out.
    await store.putClip(makeFakeClip({ id: 'from-other-tab', phrases: [] }));
    vi.useFakeTimers();
    channel.onmessage?.({});
    channel.onmessage?.({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    await settle();
    expect(h.c.clips.map((c) => c.id).sort()).toEqual(['fake-clip', 'from-other-tab']);
    await h.unmount();
    expect(channel.closed).toBe(true);
  });

  it('stays out of it for a memory store unless asked', async () => {
    await mount({ props: { store: createMemoryClipStore() } });
    expect(FakeChannel.all).toHaveLength(0);
  });
});

describe('the date', () => {
  it('looks at the practice queue again when the app comes back to the foreground', async () => {
    let now = FAKE_NOW;
    const h = await mount({ props: { store: await seededStore(), now: () => now } });
    const dueNow = h.c.queue.filter((i) => i.status === 'review-due').length;
    now = FAKE_NOW + 90 * DAY;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(h.c.queue.filter((i) => i.status === 'review-due').length).toBeGreaterThan(dueNow);
  });
});

describe('inside the real AppProvider', () => {
  beforeEach(() => localStorage.clear());

  it('adds and removes the clip\'s measurements through AppController, so the singer\'s targets change and persist', async () => {
    const store = await seededStore();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    let trainer!: TrainerController;
    let app!: AppController;
    function Probe() {
      trainer = useTrainer();
      app = useApp();
      return null;
    }
    await act(async () =>
      root.render(
        <AppProvider>
          <TrainerProvider store={store} now={() => FAKE_NOW}>
            <Probe />
          </TrainerProvider>
        </AppProvider>,
      ),
    );
    await settle();
    expect(trainer.status).toBe('ready');
    expect(trainer.singers.map((s) => s.id)).toEqual(app.builtins.map((b) => b.id));
    const singer = trainer.getClip('fake-clip')?.singerId as string;
    expect(app.builtins.find((b) => b.id === singer)?.source).toBe('builtin');

    await act1(() => trainer.setContributes('fake-clip', true));
    expect(app.builtins.find((b) => b.id === singer)?.source).toBe('measured');
    expect(app.state.measurements[singer].map((m) => m.id)).toEqual(['fake-clip']);
    expect(JSON.parse(localStorage.getItem('mimic:v1:measurements') ?? '{}')[singer][0].id).toBe('fake-clip');
    expect(trainer.getClip('fake-clip')?.contributesToSinger).toBe(true);

    await act1(() => trainer.updateClip('fake-clip', { title: 'Renamed' }));
    expect(app.state.measurements[singer][0].name).toBe('Renamed');

    await act1(() => trainer.deleteClip('fake-clip'));
    expect(app.builtins.find((b) => b.id === singer)?.source).toBe('builtin');
    expect(app.state.measurements[singer] ?? []).toEqual([]);
  });
});

describe('defaults without a provider', () => {
  it('extras are inert and safe to read', async () => {
    let seen!: TrainerExtras;
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push({ root, container });
    function Probe() {
      seen = useTrainerExtras();
      return null;
    }
    await act(async () => root.render(<Probe />));
    expect(seen).toMatchObject({ memoryReason: null, warnings: [], exportReminder: { due: false, message: null }, storageNote: null });
    expect(await seen.requestPersistence()).toBe(false);
    expect((await seen.refreshStorage()).supported).toBe(false);
    await seen.reload();
  });

  it('the inert controller has the shape and rejects actions that need data', async () => {
    const c = createInertTrainerController();
    expect(c).toMatchObject({ status: 'loading', clips: [], queue: [], singers: [] });
    expect(c.getClip('x')).toBeUndefined();
    expect(await c.listAttempts({})).toEqual([]);
    await expect(c.deleteClip('x')).rejects.toThrow('not implemented');
  });
});

describe('createKeyedQueue', () => {
  it('runs tasks with the same key one after another, in order, even when one fails', async () => {
    const run = createKeyedQueue();
    const order: string[] = [];
    const slow = run('a', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('first');
      throw new Error('first failed');
    });
    const second = run('a', async () => (order.push('second'), 2));
    const other = run('b', async () => (order.push('other'), 3));
    await expect(slow).rejects.toThrow('first failed');
    expect(await second).toBe(2);
    expect(await other).toBe(3);
    expect(order).toEqual(['other', 'first', 'second']);
  });
});
