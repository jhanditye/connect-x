// @vitest-environment jsdom
// The wiring of the real practice engine: App hands trainer/practiceEngine's factory to TrainerProvider as `openPractice`, so
// opening a phrase in the running app builds the real engine (not "Practice is not connected to the audio engine yet"), and
// leaving the phrase disposes it. The library is a real TrainerProvider over a memory store; only the analysis worker is replaced.
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeInWorker } from './analysis/client';
import { App } from './App';
import type { PracticeSession } from './state/TrainerProvider';
import { createMemoryClipStore, type ClipStore } from './storage/clips';
import { FakeTrainerEngine, makeFakeClip } from './testing/trainerFixtures';
import type { PracticeEngine } from './trainer/engine';
import { openPractice } from './trainer/practiceEngine';
import type { ClipRecord } from './types';

vi.mock('./analysis/client', async () => {
  const { makeFakeAnalysis } = await import('./testing/fixtures');
  return { analyzeInWorker: vi.fn(async () => makeFakeAnalysis()) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  if (!window.matchMedia) {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  }
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(analyzeInWorker).mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function seeded(): Promise<{ store: ClipStore; clip: ClipRecord }> {
  const store = createMemoryClipStore();
  const base = makeFakeClip({ id: 'wired-clip' });
  const sampleRate = 22050;
  const info = await store.writeAudio(base.id, 'mix', new Int16Array(sampleRate * 14), sampleRate);
  const clip: ClipRecord = { ...base, audio: { mix: info, vocal: null } };
  await store.putClip(clip);
  return { store, clip };
}

async function show(hash: string, strict = false): Promise<void> {
  window.location.hash = hash;
  await act(async () => root.render(strict ? <StrictMode>{app.current}</StrictMode> : app.current));
  await tick(20);
  await tick(20);
}
const app: { current: React.ReactElement } = { current: <></> };

const dockSing = (): HTMLButtonElement | undefined => Array.from(container.querySelectorAll<HTMLButtonElement>('button.pc-sing, .pc-dock button')).find((b) => /Sing|Getting ready/.test(b.textContent ?? ''));

describe('App wires the real practice engine', () => {
  it('opening a phrase builds the real engine: the screen leaves "preparing", the reference is analysed from the stored audio with the user\'s settings', async () => {
    const { store } = await seeded();
    app.current = <App trainer={{ store, syncTabs: false }} />;
    await show('#trainer/c/wired-clip/p/1');
    expect(container.textContent).not.toMatch(/not connected to the audio engine/);
    expect(container.querySelector('.page--practice h1')?.textContent).toMatch(/Phrase\s*1/);
    expect(container.querySelector('.pr-preparing')).toBeNull(); // the engine finished preparing
    expect(dockSing()?.textContent).toMatch(/Sing/);
    expect(dockSing()?.disabled).toBe(false);
    // the engine read the phrase window from the store and analysed it once, as the reference, with the app's voice type
    const calls = vi.mocked(analyzeInWorker).mock.calls;
    expect(calls).toHaveLength(1);
    const [samples, sampleRate, opts] = calls[0];
    expect(sampleRate).toBe(22050);
    expect(samples.length).toBeGreaterThan(22050 * 3);
    expect(opts).toMatchObject({ voiceType: expect.any(String), a4Hz: 440 });
  });

  it('a phrase of a clip whose audio is missing is not opened (the screen says so before any engine exists)', async () => {
    const { store, clip } = await seeded();
    await store.putClip({ ...clip, audioMissing: true });
    app.current = <App trainer={{ store, syncTabs: false }} />;
    await show('#trainer/c/wired-clip/p/1');
    expect(container.textContent).toMatch(/needs its audio again/);
    expect(vi.mocked(analyzeInWorker)).not.toHaveBeenCalled();
  });

  it('leaving the phrase disposes the engine; StrictMode\'s second open leaves no engine behind', async () => {
    const { store } = await seeded();
    const engines: PracticeEngine[] = [];
    const spy = async (s: PracticeSession): Promise<PracticeEngine> => {
      const e = await openPractice(s);
      engines.push(e);
      return e;
    };
    app.current = <App trainer={{ store, syncTabs: false, openPractice: spy }} />;
    await show('#trainer/c/wired-clip/p/1', true);
    expect(engines.length).toBeGreaterThanOrEqual(1);
    const open = engines.filter((e) => e.getSnapshot().state !== 'closed');
    expect(open).toHaveLength(1);
    expect(open[0].getSnapshot().state).toBe('idle');
    await show('#trainer', true);
    expect(engines.every((e) => e.getSnapshot().state === 'closed')).toBe(true);
  });

  it('an openPractice prop still replaces the real engine (tests and the layout harness rely on it)', async () => {
    const { store } = await seeded();
    const made: FakeTrainerEngine[] = [];
    const custom = vi.fn(async (s: PracticeSession) => {
      const e = new FakeTrainerEngine({ clip: s.clip, phrase: s.phrase });
      made.push(e);
      return e;
    });
    app.current = <App trainer={{ store, syncTabs: false, openPractice: custom }} />;
    await show('#trainer/c/wired-clip/p/2');
    expect(custom).toHaveBeenCalledTimes(1);
    expect(custom.mock.calls[0][0].phrase.id).toBe(made[0].phrase.id);
    expect(custom.mock.calls[0][0].clip.id).toBe('wired-clip');
    expect(vi.mocked(analyzeInWorker)).not.toHaveBeenCalled();
  });
});
