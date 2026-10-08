// @vitest-environment jsdom
// The screen wake lock is requested first thing in the tap that starts an analysis (Safari grants it only within about 5 s of a
// touch, and a decode can take longer), held through the decode and the analysis as one hold, and let go when it ends.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAnalysis } from '../testing/fixtures';
import { AppProvider } from './AppProvider';
import { useApp, type AppController } from './context';

const order: string[] = [];
let releaseDecode!: () => void;
let finishAnalysis!: () => void;

vi.mock('../audio/decode', () => ({
  decodeAudioFile: vi.fn(async () => {
    order.push('decode:start');
    await new Promise<void>((r) => (releaseDecode = r));
    order.push('decode:end');
    return { samples: new Float32Array(44100 * 4), sampleRate: 44100, sourceDurationSec: 4, notices: [] };
  }),
}));
vi.mock('../analysis/client', () => ({
  analyzeInWorker: vi.fn(async () => {
    order.push('analyse:start');
    await new Promise<void>((r) => (finishAnalysis = r));
    order.push('analyse:end');
    return makeFakeAnalysis();
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let app!: AppController;
const sentinel = { release: vi.fn(async () => undefined), addEventListener: vi.fn() };

function Probe() {
  app = useApp();
  return null;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '#studio';
  order.length = 0;
  sentinel.release.mockClear();
  vi.stubGlobal('navigator', Object.assign(Object.create(window.navigator), { wakeLock: { request: vi.fn(async () => (order.push('wakeLock'), sentinel)) } }));
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const tick = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

describe('screen wake lock for a file analysis', () => {
  it('is requested before the decode starts, kept through decode and analysis, and released at the end', async () => {
    let done!: Promise<boolean>;
    act(() => {
      done = app.analyzeFile(new File([new Uint8Array(10)], 'take.wav'));
    });
    // synchronously in the tap: before anything is awaited
    expect(order.slice(0, 2)).toEqual(['wakeLock', 'decode:start']);
    await tick();
    expect(sentinel.release).not.toHaveBeenCalled();
    await act(async () => releaseDecode());
    await tick();
    expect(order).toContain('analyse:start');
    expect(sentinel.release).not.toHaveBeenCalled(); // still held while the worker runs
    expect(order.filter((o) => o === 'wakeLock')).toHaveLength(1); // one hold for decode and analysis, not two requests
    await act(async () => finishAnalysis());
    await act(async () => void (await done));
    await tick();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('is released when the file cannot be read', async () => {
    const { decodeAudioFile } = await import('../audio/decode');
    vi.mocked(decodeAudioFile).mockRejectedValueOnce(new Error('unreadable'));
    await act(async () => void (await app.analyzeFile(new File([new Uint8Array(10)], 'bad.wav'))));
    await tick();
    expect(order[0]).toBe('wakeLock');
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});
