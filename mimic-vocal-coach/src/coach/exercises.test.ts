import { describe, expect, it } from 'vitest';
import { FAKE_STYLE } from '../testing/fixtures';
import type { StyleKey } from '../types';
import { EXERCISES, getExercise } from './exercises';

const ALL_KEYS = Object.keys(FAKE_STYLE) as StyleKey[];

describe('EXERCISES', () => {
  it('has at least 18 exercises with unique kebab-case ids', () => {
    expect(EXERCISES.length).toBeGreaterThanOrEqual(18);
    const ids = EXERCISES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('covers the required techniques', () => {
    const required = [
      'lip-trill-siren',
      'straw-phonation-slides',
      'ng-siren',
      'nay-bright-mix',
      'gee-gug-connected-mix',
      'mum-five-tone',
      'octave-slide-wee-oo',
      'messa-di-voce',
      'falsetto-bridge-down',
      'level-volume-scale',
      'vowel-narrowing',
      'aspirate-onsets',
      'balanced-onsets',
      'vibrato-pulses',
      'straight-then-vibrato',
      'pentatonic-runs',
      'gospel-run-patterns',
      'falsetto-flip-leap',
      'blended-leap',
      'soul-falsetto-forward',
      'light-texture-onset',
    ];
    for (const id of required) expect(getExercise(id), id).toBeDefined();
  });

  it('gives every exercise a goal, valid helps, clear steps and a duration', () => {
    for (const e of EXERCISES) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.goal.length).toBeGreaterThan(20);
      expect(e.helps.length).toBeGreaterThan(0);
      for (const k of e.helps) expect(ALL_KEYS, `${e.id} helps ${k}`).toContain(k);
      expect(e.steps.length, e.id).toBeGreaterThanOrEqual(3);
      for (const s of e.steps) expect(s.length).toBeGreaterThan(10);
      expect(e.durationMin).toBeGreaterThan(0);
      expect(e.durationMin).toBeLessThanOrEqual(10);
    }
  });

  it('has playable patterns', () => {
    const withPattern = EXERCISES.filter((e) => e.pattern);
    expect(withPattern.length).toBeGreaterThanOrEqual(18);
    for (const e of withPattern) {
      const p = e.pattern!;
      expect(['scale', 'arpeggio', 'siren', 'sustain']).toContain(p.kind);
      expect(p.steps.length).toBeGreaterThan(0);
      if (p.kind === 'siren') expect(p.steps).toHaveLength(2);
      for (const s of p.steps) expect(Number.isInteger(s)).toBe(true);
      expect(p.bpm).toBeGreaterThanOrEqual(20);
      expect(p.bpm).toBeLessThanOrEqual(300);
      expect(Number.isInteger(p.repetitions)).toBe(true);
      expect(p.repetitions).toBeGreaterThanOrEqual(1);
      // Keep every pattern within a sane distance of the passaggio: never more than about an
      // octave above its low edge by the last repetition.
      const top = p.startOffsetFromPassaggio + Math.max(...p.steps) + p.stepUpSemitones * (p.repetitions - 1);
      expect(top, e.id).toBeLessThanOrEqual(14);
      const bottom = p.startOffsetFromPassaggio + Math.min(...p.steps);
      expect(bottom, e.id).toBeGreaterThanOrEqual(-12);
    }
  });

  it('helps every style dimension with at least one exercise', () => {
    for (const k of ALL_KEYS) expect(EXERCISES.some((e) => e.helps.includes(k)), k).toBe(true);
  });

  it('wraps the texture exercise in strong cautions', () => {
    const ex = getExercise('light-texture-onset')!;
    expect(ex.cautions?.length ?? 0).toBeGreaterThanOrEqual(3);
    const text = (ex.cautions ?? []).join(' ');
    expect(text).toMatch(/stop/i);
    expect(text).toMatch(/hoarse/i);
    expect(text).toMatch(/squeez/i);
    expect(text).toMatch(/skip/i);
  });

  it('getExercise returns undefined for unknown ids', () => {
    expect(getExercise('nope')).toBeUndefined();
    expect(getExercise('lip-trill-siren')?.name).toBe('Lip-trill sirens');
  });
});
