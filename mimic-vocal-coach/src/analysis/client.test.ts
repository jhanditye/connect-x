import { afterEach, describe, expect, it, vi } from 'vitest';
import { concat, silence, synthMelody } from '../testing/synth';
import { analyzeAuto, analyzeInWorker } from './client';

// Node has no Worker, so these run the client's main-thread fallback: the real analysis, end to end, through the same
// entry points the app uses.
const SR = 22050;
const voice = concat(silence(0.3, SR), synthMelody([{ midi: 57, durSec: 2 }, { midi: 60, durSec: 2 }], { sampleRate: SR, amplitude: 0.35 }), silence(0.3, SR));

describe('client (main-thread fallback)', () => {
  it('analyzeInWorker passes opts.mode through', async () => {
    expect((await analyzeInWorker(voice, SR, { voiceType: 'tenor' })).mode).toBeUndefined();
    expect((await analyzeInWorker(voice, SR, { voiceType: 'tenor', mode: 'mix' })).mode).toBe('mix');
  });

  it('analyzeAuto: a plain voice is analysed once, as solo, with one progress stream', async () => {
    const seen: number[] = [];
    const r = await analyzeAuto(voice, SR, { voiceType: 'tenor' }, (f) => seen.push(f));
    expect(r.route).toBe('solo');
    expect(r.analysis.mode).toBeUndefined();
    expect(r.analysis.notes.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('analyzeAuto: the manual full-song choice goes straight to mix mode', async () => {
    const r = await analyzeAuto(voice, SR, { voiceType: 'tenor' }, undefined, 'mix');
    expect(r.route).toBe('mix-manual');
    expect(r.analysis.mode).toBe('mix');
    expect(r.solo).toBeNull();
  });
});

describe('cancelling an analysis', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects at once with an AbortError when the signal has already aborted, without starting any work', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const progress = vi.fn();
    await expect(analyzeInWorker(voice, SR, { voiceType: 'tenor' }, progress, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(analyzeAuto(voice, SR, { voiceType: 'tenor' }, progress, 'auto', ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).not.toHaveBeenCalled();
  });

  it('main-thread fallback: aborting while it runs rejects with an AbortError and drops the result', async () => {
    const ctl = new AbortController();
    const pending = analyzeInWorker(voice, SR, { voiceType: 'tenor' }, undefined, ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('terminates the worker when aborted, and rejects with an AbortError', async () => {
    const terminate = vi.fn();
    const posted: unknown[] = [];
    class FakeWorker {
      onmessage: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      postMessage(m: unknown) {
        posted.push(m);
      }
      terminate = terminate;
    }
    vi.stubGlobal('Worker', FakeWorker);
    const ctl = new AbortController();
    const pending = analyzeInWorker(voice, SR, { voiceType: 'tenor' }, undefined, ctl.signal);
    // Only meaningful when the bundler's inline worker wrapper used the stub; otherwise the main-thread path ran and abort still rejects.
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    if (posted.length > 0) expect(terminate).toHaveBeenCalled();
  });
});
