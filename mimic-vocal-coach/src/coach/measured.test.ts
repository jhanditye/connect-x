import { describe, expect, it } from 'vitest';
import { makeFakeAnalysis } from '../testing/fixtures';
import type { MeasuredClip, StyleVector } from '../types';
import { buildCoachingPlan } from './coach';
import { compareToProfile } from './compare';
import { clipFromAnalysis, combinedStyle, measuredProfile } from './measured';
import { getProfile } from './profiles';

const SHAWN = getProfile('shawn-mendes')!;

function clip(id: string, style: Partial<StyleVector>, voicedSec = 20): MeasuredClip {
  const base = clipFromAnalysis(makeFakeAnalysis(style), id, id, '2026-09-26T10:00:00.000Z');
  return { ...base, voicedSec };
}

describe('combinedStyle', () => {
  it('weights each clip by its singing time and skips unmeasured values', () => {
    const a = clip('a', { breathiness: 0.3, vibratoRateHz: null }, 30);
    const b = clip('b', { breathiness: 0.6, vibratoRateHz: 5 }, 10);
    const style = combinedStyle([a, b]);
    expect(style.breathiness).toBeCloseTo((0.3 * 30 + 0.6 * 10) / 40, 6);
    expect(style.vibratoRateHz).toBeCloseTo(5, 6);
  });

  it('is null where no clip measured a dimension', () => {
    const style = combinedStyle([clip('a', { agility: null })]);
    expect(style.agility).toBeNull();
  });
});

describe('measuredProfile', () => {
  it('returns the builtin unchanged without clips', () => {
    expect(measuredProfile(SHAWN, [])).toBe(SHAWN);
  });

  it('keeps the singer identity and coaching material but uses measured targets', () => {
    const p = measuredProfile(SHAWN, [clip('a', { breathiness: 0.4, brightness: 0.55 }), clip('b', { breathiness: 0.44, brightness: 0.6 })]);
    expect(p.id).toBe(SHAWN.id);
    expect(p.name).toBe(SHAWN.name);
    expect(p.source).toBe('measured');
    expect(p.signatureMoves).toEqual(SHAWN.signatureMoves);
    expect(p.studySongs).toEqual(SHAWN.studySongs);
    expect(p.targets.breathiness?.ideal).toBeCloseTo(0.42, 6);
    expect(p.targets.brightness?.ideal).toBeCloseTo(0.575, 6);
    expect(p.targets.breathiness?.weight).toBe(SHAWN.targets.breathiness?.weight);
    expect(p.sourceNote).toMatch(/2 clips of Shawn Mendes/);
  });

  it('never targets unhealthy rasp, chest weight or loudness climb', () => {
    const p = measuredProfile(SHAWN, [clip('a', { rasp: 0.7, chestInUpperRange: 0.9, mixInUpperRange: 0.1, headInUpperRange: 0, loudnessClimbDbPerSemitone: 2 })]);
    expect(p.targets.rasp!.ideal).toBeLessThanOrEqual(0.15);
    expect(p.targets.chestInUpperRange!.ideal).toBeLessThanOrEqual(0.55);
    expect(p.targets.chestInUpperRange!.high).toBeLessThanOrEqual(0.6);
    expect(p.targets.loudnessClimbDbPerSemitone!.ideal).toBeLessThanOrEqual(0.5);
    expect(p.targets.loudnessClimbDbPerSemitone!.high).toBeLessThanOrEqual(0.8);
  });

  it('widens a band to cover how much the clips disagree', () => {
    const one = measuredProfile(SHAWN, [clip('a', { brightness: 0.5 })]);
    const spreadOut = measuredProfile(SHAWN, [clip('a', { brightness: 0.3 }), clip('b', { brightness: 0.7 })]);
    const w1 = one.targets.brightness!.high - one.targets.brightness!.low;
    const w2 = spreadOut.targets.brightness!.high - spreadOut.targets.brightness!.low;
    expect(spreadOut.targets.brightness!.ideal).toBeCloseTo(0.5, 6);
    expect(w2).toBeGreaterThan(w1);
    expect(spreadOut.targets.brightness!.low).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(spreadOut.targets.brightness!.high).toBeGreaterThanOrEqual(0.7 - 1e-9);
  });

  it('takes the typical range from the clips', () => {
    const p = measuredProfile(SHAWN, [clip('a', {})]);
    const a = makeFakeAnalysis();
    expect(p.typicalRange.lowMidi).toBe(a.pitch.lowMidi);
    expect(p.typicalRange.highMidi).toBe(a.pitch.highMidi);
  });

  it('scores a take that matches the measured style highly and keeps the singer in the coaching', () => {
    const style: Partial<StyleVector> = { breathiness: 0.5, brightness: 0.45, vibratoPresence: 0.5, vibratoRateHz: 5.8 };
    const p = measuredProfile(SHAWN, [clip('a', style)]);
    const take = makeFakeAnalysis(style);
    const comparison = compareToProfile(take, p);
    expect(comparison.overall).toBeGreaterThan(85);
    const plan = buildCoachingPlan(take, comparison, p);
    expect(plan.headline).toContain('Shawn');
  });
});
