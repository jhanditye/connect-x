import { beforeAll, describe, expect, it } from 'vitest';
import type { VoiceAnalysis } from '../types';
import { analyzeTake } from './analyze';
import { makeDemoTake } from './demo';

describe('makeDemoTake', () => {
  let demo: { samples: Float32Array; sampleRate: number };
  let a: VoiceAnalysis;

  beforeAll(() => {
    demo = makeDemoTake();
    a = analyzeTake(demo.samples, demo.sampleRate, { voiceType: 'baritone' });
  });

  it('is a deterministic ~15 s take at 44.1 kHz by default, without clipping', () => {
    expect(demo.sampleRate).toBe(44100);
    expect(demo.samples.length / demo.sampleRate).toBeCloseTo(15, 1);
    const again = makeDemoTake();
    expect(again.samples).toEqual(demo.samples);
    let peak = 0;
    for (const v of demo.samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(0.9);
    expect(peak).toBeGreaterThan(0.3);
    expect(makeDemoTake(22050).sampleRate).toBe(22050);
    expect(makeDemoTake(22050).samples.length).toBe(15 * 22050);
  });

  it('builds quickly enough for a button press', () => {
    const t0 = performance.now();
    makeDemoTake();
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('analyses cleanly into four phrases through the baritone passaggio', () => {
    expect(a.warnings).toEqual([]);
    expect(a.issues).toEqual([]);
    expect(a.phrases).toHaveLength(4);
    expect(a.pitch.lowMidi).toBeLessThanOrEqual(57);
    expect(a.pitch.highMidi).toBeGreaterThanOrEqual(70);
    expect(a.voicedSec).toBeGreaterThan(10);
  });

  it('exercises every part of the results page', () => {
    const s = a.style;
    expect(a.runs).toHaveLength(1);
    expect(a.runs[0].noteCount).toBeGreaterThanOrEqual(6);
    expect(a.notes.filter((n) => n.vibrato !== null).length).toBeGreaterThanOrEqual(3);
    expect(s.vibratoRateHz).toBeCloseTo(5.5, 0);
    expect(s.flipsPerMinute ?? 0).toBeGreaterThan(0);
    expect(s.chestInUpperRange ?? 0).toBeGreaterThan(0.2);
    expect(s.mixInUpperRange ?? 0).toBeGreaterThan(0.2);
    expect(s.headInUpperRange ?? 0).toBeGreaterThan(0.1);
    expect(a.onsets.some((o) => o.type === 'breathy')).toBe(true);
    expect(s.pitchAccuracyCents ?? 0).toBeGreaterThan(4);
    expect(s.agility ?? 0).toBeGreaterThan(5);
    for (const v of Object.values(s)) expect(v).not.toBeNull();
  });
});
