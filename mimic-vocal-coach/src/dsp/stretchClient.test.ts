import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderGuideOffMainThread, type WorkerLike } from './stretchClient';
import { runRenderJob, type RenderRequest, type RenderResponse } from './stretchProtocol';
import { renderGuide } from './timestretch';

const SR = 16000;
const tone = (sec: number): Float32Array => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR));

/** A worker double: runs the real job runner when it gets a request, answering on a later tick like a real worker. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = 0;
  requests: RenderRequest[] = [];
  constructor(private readonly script: 'normal' | 'silent' | 'crash-before-start' | 'crash-after-start' | 'error-reply' = 'normal') {
    if (script === 'normal' || script === 'error-reply' || script === 'crash-after-start') setTimeout(() => this.emit({ type: 'alive' }), 0);
    if (script === 'crash-before-start') setTimeout(() => this.onerror?.({ message: 'blocked', preventDefault() {} } as unknown as ErrorEvent), 0);
  }
  private emit(m: RenderResponse): void {
    if (this.terminated) return;
    this.onmessage?.({ data: m } as MessageEvent<RenderResponse>);
  }
  postMessage(message: RenderRequest, transfer: Transferable[]): void {
    this.requests.push(message);
    void transfer;
    if (this.script === 'crash-after-start') {
      setTimeout(() => this.onerror?.({ message: 'boom', preventDefault() {} } as unknown as ErrorEvent), 5);
      return;
    }
    if (this.script === 'error-reply') {
      setTimeout(() => this.emit({ type: 'error', id: message.id, message: 'The guide could not be rendered: nope' }), 5);
      return;
    }
    if (this.script !== 'normal') return;
    setTimeout(() => runRenderJob(message, (m) => this.emit(m)), 5);
  }
  terminate(): void {
    this.terminated++;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('renderGuideOffMainThread', () => {
  it('renders in the worker, forwards progress, keeps the caller samples and terminates the worker once', async () => {
    const x = tone(2);
    const keep = Float32Array.from(x);
    const worker = new FakeWorker();
    const progress: number[] = [];
    const out = await renderGuideOffMainThread(x, SR, { rate: 0.75, semitones: 0, outRate: 24000 }, { createWorker: () => worker, onProgress: (p) => progress.push(p) });
    expect(out.viaWorker).toBe(true);
    expect(out.sampleRate).toBe(24000);
    expect(out.samples).toEqual(renderGuide(x, SR, { rate: 0.75, semitones: 0, outRate: 24000 }));
    expect(x).toEqual(keep);
    expect(x.buffer.byteLength).toBeGreaterThan(0); // not detached: a copy was transferred
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0].samples).not.toBe(x);
    expect(worker.terminated).toBe(1);
    expect(progress.at(-1)).toBe(1);
    expect(out.ms).toBeGreaterThanOrEqual(0);
  });

  it('renders on the main thread when there is no Worker at all, with the same result and the same output rate', async () => {
    const x = tone(1);
    const out = await renderGuideOffMainThread(x, SR, { rate: 0.75, semitones: 0, outRate: 24000 }, { createWorker: () => null });
    expect(out.viaWorker).toBe(false);
    expect(out.sampleRate).toBe(24000);
    expect(out.samples).toEqual(renderGuide(x, SR, { rate: 0.75, semitones: 0, outRate: 24000 }));
  });

  it('a key shift on the main thread also converts to the output rate', async () => {
    const out = await renderGuideOffMainThread(tone(1), SR, { rate: 1, semitones: 3, outRate: 24000 }, { forceMainThread: true });
    expect(out.viaWorker).toBe(false);
    expect(out.sampleRate).toBe(24000);
    expect(Math.abs(out.samples.length / 24000 - 1)).toBeLessThan(0.01);
  });

  it('falls back to the main thread when the worker never starts', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker('silent');
    const p = renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { createWorker: () => worker, startTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1200);
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out.viaWorker).toBe(false);
    expect(worker.terminated).toBe(1);
  });

  it('falls back when the worker script fails before it started, but reports a crash after it started', async () => {
    const early = new FakeWorker('crash-before-start');
    const ok = await renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { createWorker: () => early });
    expect(ok.viaWorker).toBe(false);
    expect(early.terminated).toBe(1);
    const late = new FakeWorker('crash-after-start');
    await expect(renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { createWorker: () => late })).rejects.toThrow(/boom|stopped/);
    expect(late.terminated).toBe(1);
  });

  it('passes a render error through as an Error and does not retry on the main thread', async () => {
    const worker = new FakeWorker('error-reply');
    await expect(renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { createWorker: () => worker })).rejects.toThrow(/nope/);
    expect(worker.terminated).toBe(1);
  });

  it('aborts: terminates the worker, rejects with AbortError and ignores late messages', async () => {
    const ctl = new AbortController();
    const worker = new FakeWorker('normal');
    const p = renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { createWorker: () => worker, signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(worker.terminated).toBe(1);
  });

  it('rejects at once for an already aborted signal without creating a worker', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const make = vi.fn(() => new FakeWorker());
    await expect(renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { createWorker: make, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(make).not.toHaveBeenCalled();
  });

  it('uses the main thread when forced and when postMessage throws', async () => {
    const forced = await renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { forceMainThread: true, createWorker: () => { throw new Error('should not be called'); } });
    expect(forced.viaWorker).toBe(false);
    const w = new FakeWorker('silent');
    w.postMessage = () => {
      throw new Error('DataCloneError');
    };
    const out = await renderGuideOffMainThread(tone(1), SR, { rate: 0.9, semitones: 0 }, { createWorker: () => w });
    expect(out.viaWorker).toBe(false);
    expect(w.terminated).toBe(1);
  });

  it('rejects an invalid spec on both paths with a RangeError message', async () => {
    await expect(renderGuideOffMainThread(tone(1), SR, { rate: 0, semitones: 0 }, { forceMainThread: true })).rejects.toThrow(RangeError);
    await expect(renderGuideOffMainThread(tone(1), SR, { rate: 0, semitones: 0 }, { createWorker: () => new FakeWorker() })).rejects.toThrow(/rate/);
  });

  it('without a Worker global the default factory yields no worker', async () => {
    vi.stubGlobal('Worker', undefined);
    const out = await renderGuideOffMainThread(tone(0.5), SR, { rate: 0.9, semitones: 0 });
    expect(out.viaWorker).toBe(false);
  });
});
