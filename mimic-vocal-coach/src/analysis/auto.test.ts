import { describe, expect, it, vi } from 'vitest';
import { makeFakeAnalysis } from '../testing/fixtures';
import type { AnalysisOptions, VoiceAnalysis } from '../types';
import { analyzeWithRouting, SOLO_PROGRESS_SHARE, type AnalyzeFn } from './auto';

const SAMPLES = new Float32Array(1000);
const OPTS: AnalysisOptions = { voiceType: 'tenor' };

const solo = (): VoiceAnalysis => makeFakeAnalysis();
const song = (): VoiceAnalysis => ({ ...makeFakeAnalysis(), issues: ['accompaniment'], warnings: ['band'] });
const mix = (): VoiceAnalysis => ({ ...makeFakeAnalysis(), mode: 'mix', issues: ['accompaniment'] });

/** A fake analyzer: reports 0, 0.5 and 1 for each call and answers per mode. */
function fake(answers: { solo: () => VoiceAnalysis; mix: () => VoiceAnalysis }) {
  const calls: AnalysisOptions[] = [];
  const analyze: AnalyzeFn = vi.fn(async (_s, _r, opts, onProgress) => {
    calls.push(opts);
    onProgress?.(0);
    onProgress?.(0.5);
    onProgress?.(1);
    return opts.mode === 'mix' ? answers.mix() : answers.solo();
  });
  return { analyze, calls };
}

describe('analyzeWithRouting', () => {
  it('auto: a solo recording is analysed once, as solo', async () => {
    const { analyze, calls } = fake({ solo, mix });
    const r = await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS);
    expect(calls.map((c) => c.mode)).toEqual(['solo']);
    expect(r.route).toBe('solo');
    expect(r.analysis.mode).toBeUndefined();
    expect(r.solo).toBe(r.analysis);
    expect(r.mixError).toBeNull();
  });

  it('auto: a song (accompaniment issue) is re-run in mix mode and the mix analysis is returned', async () => {
    const { analyze, calls } = fake({ solo: song, mix });
    const r = await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS);
    expect(calls.map((c) => c.mode)).toEqual(['solo', 'mix']);
    expect(r.route).toBe('mix-auto');
    expect(r.analysis.mode).toBe('mix');
    expect(r.solo?.issues).toContain('accompaniment');
    expect(r.mixError).toBeNull();
    // the other options travel with both passes
    expect(calls.every((c) => c.voiceType === 'tenor')).toBe(true);
  });

  it('auto: the progress stream is one increasing sequence from 0 to 1 over both passes', async () => {
    const { analyze } = fake({ solo: song, mix });
    const seen: number[] = [];
    await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'auto', (f) => seen.push(f));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen).toContain(SOLO_PROGRESS_SHARE);
    expect(seen.filter((v) => v === 1)).toHaveLength(1);
    expect(seen.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it('auto: when no mix pass is needed the stream still ends at exactly one 1', async () => {
    const { analyze } = fake({ solo, mix });
    const seen: number[] = [];
    await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'auto', (f) => seen.push(f));
    expect(seen[seen.length - 1]).toBe(1);
    expect(seen.filter((v) => v === 1)).toHaveLength(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it('auto: if the mix pass fails the solo analysis is returned with the reason', async () => {
    const calls: (string | undefined)[] = [];
    const analyze: AnalyzeFn = async (_s, _r, opts) => {
      calls.push(opts.mode);
      if (opts.mode === 'mix') throw new Error('out of memory');
      return song();
    };
    const seen: number[] = [];
    const r = await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'auto', (f) => seen.push(f));
    expect(calls).toEqual(['solo', 'mix']);
    expect(r.route).toBe('solo');
    expect(r.analysis.issues).toContain('accompaniment');
    expect(r.mixError).toBe('out of memory');
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('auto: a failing solo pass rejects', async () => {
    const analyze: AnalyzeFn = async () => {
      throw new Error('decode failed');
    };
    await expect(analyzeWithRouting(analyze, SAMPLES, 22050, OPTS)).rejects.toThrow('decode failed');
  });

  it('auto: a solo analysis that is already a mix analysis does not trigger a second pass', async () => {
    const { analyze, calls } = fake({ solo: mix, mix });
    const r = await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'auto');
    expect(calls).toHaveLength(1);
    expect(r.route).toBe('solo');
  });

  it('mix (the manual full-song choice): one mix pass, no solo pass', async () => {
    const { analyze, calls } = fake({ solo, mix });
    const seen: number[] = [];
    const r = await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'mix', (f) => seen.push(f));
    expect(calls.map((c) => c.mode)).toEqual(['mix']);
    expect(r.route).toBe('mix-manual');
    expect(r.solo).toBeNull();
    expect(seen).toEqual([0, 0.5, 1]);
  });

  it('mix: a failing manual mix pass rejects (there is nothing to fall back to)', async () => {
    const analyze: AnalyzeFn = async () => {
      throw new Error('boom');
    };
    await expect(analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'mix')).rejects.toThrow('boom');
  });

  it('solo (the manual single-voice choice): one solo pass even for a song', async () => {
    const { analyze, calls } = fake({ solo: song, mix });
    const r = await analyzeWithRouting(analyze, SAMPLES, 22050, { ...OPTS, mode: 'mix' }, 'solo');
    expect(calls.map((c) => c.mode)).toEqual(['solo']);
    expect(r.route).toBe('solo');
    expect(r.analysis.issues).toContain('accompaniment');
  });

  it('the default routing follows opts.mode: mix goes straight to mix, otherwise auto', async () => {
    const a = fake({ solo, mix });
    await analyzeWithRouting(a.analyze, SAMPLES, 22050, { ...OPTS, mode: 'mix' });
    expect(a.calls.map((c) => c.mode)).toEqual(['mix']);
    const b = fake({ solo: song, mix });
    await analyzeWithRouting(b.analyze, SAMPLES, 22050, { ...OPTS, mode: 'solo' });
    expect(b.calls.map((c) => c.mode)).toEqual(['solo', 'mix']);
  });

  it('ignores non-finite progress values and works without a progress callback', async () => {
    const analyze: AnalyzeFn = async (_s, _r, _o, p) => {
      p?.(NaN);
      p?.(Infinity);
      p?.(-1);
      p?.(0.4);
      return solo();
    };
    const seen: number[] = [];
    await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'solo', (f) => seen.push(f));
    expect(seen.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    await expect(analyzeWithRouting(analyze, SAMPLES, 22050, OPTS)).resolves.toBeDefined();
  });
});

describe('analyzeWithRouting: cancelling', () => {
  it('passes the signal to every pass', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const analyze: AnalyzeFn = vi.fn(async (_s, _r, opts, _p, signal) => {
      seen.push(signal);
      return opts.mode === 'mix' ? mix() : song();
    });
    const ctl = new AbortController();
    await analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'auto', undefined, ctl.signal);
    expect(seen).toEqual([ctl.signal, ctl.signal]);
  });

  it('does not start the mix pass when the signal aborted during the solo pass, and rejects with an AbortError', async () => {
    const ctl = new AbortController();
    const calls: string[] = [];
    const analyze: AnalyzeFn = vi.fn(async (_s, _r, opts) => {
      calls.push(opts.mode ?? 'solo');
      ctl.abort(); // the user closed the sheet while the solo pass was finishing
      return song();
    });
    await expect(analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'auto', undefined, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['solo']);
  });

  it('a cancelled mix pass is a cancel, not "the full-song pass failed"', async () => {
    const ctl = new AbortController();
    const analyze: AnalyzeFn = vi.fn(async (_s, _r, opts) => {
      if (opts.mode === 'mix') {
        ctl.abort();
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }
      return song();
    });
    await expect(analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'auto', undefined, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects before any work when the signal is already aborted', async () => {
    const analyze: AnalyzeFn = vi.fn(async () => solo());
    const ctl = new AbortController();
    ctl.abort();
    await expect(analyzeWithRouting(analyze, SAMPLES, 22050, OPTS, 'mix', undefined, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(analyze).not.toHaveBeenCalled();
  });
});
