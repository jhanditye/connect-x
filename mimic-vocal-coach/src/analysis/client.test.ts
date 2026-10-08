import { describe, expect, it } from 'vitest';
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
