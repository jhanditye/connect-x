import { describe, expect, it } from 'vitest';
import {
  EAR_LEVELS,
  INTERVALS,
  cleanIntervalSet,
  earSetForLevel,
  intervalInfo,
  intervalKey,
  intervalName,
  intervalPhrase,
  intervalShort,
  intervalTargetMidi,
  parseIntervalKey,
} from './intervals';

describe('interval table', () => {
  it('has the 13 simple intervals with the standard short labels, in order', () => {
    expect(INTERVALS.slice(0, 13).map((i) => i.short)).toEqual(['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7', 'P8']);
    INTERVALS.forEach((info, i) => expect(info.semitones).toBe(i));
  });

  it('names and alternative names', () => {
    expect(intervalName(9)).toBe('major 6th');
    expect(intervalName(9, true)).toBe('Major 6th');
    expect(intervalName(6)).toBe('tritone');
    expect(intervalInfo(6)?.altName).toBe('augmented 4th / diminished 5th');
    expect(intervalName(12)).toBe('octave');
    expect(intervalShort(-7)).toBe('P5');
    expect(intervalShort(14)).toBe('M9');
    expect(intervalInfo(18)).toBeNull();
    expect(intervalInfo(Number.NaN)).toBeNull();
  });

  it('phrases read naturally', () => {
    expect(intervalPhrase(9, 'up')).toBe('a major 6th up');
    expect(intervalPhrase(12, 'down')).toBe('an octave down');
    expect(intervalPhrase(4, 'harmonic')).toBe('a major 3rd (both notes together)');
    expect(intervalPhrase(0, 'up')).toBe('the same note');
  });

  it('keys round-trip', () => {
    expect(intervalKey(7, 'up')).toBe('7u');
    expect(intervalKey(-4, 'down')).toBe('4d');
    expect(intervalKey(4, 'harmonic')).toBe('4h');
    expect(parseIntervalKey('11d')).toEqual({ semitones: 11, direction: 'down' });
    expect(parseIntervalKey('4h')).toEqual({ semitones: 4, direction: 'harmonic' });
    expect(parseIntervalKey('19u')).toBeNull();
    expect(parseIntervalKey('7x')).toBeNull();
  });

  it('target notes', () => {
    expect(intervalTargetMidi(60, 9, 'up')).toBe(69);
    expect(intervalTargetMidi(60, 9, 'down')).toBe(51);
    expect(intervalTargetMidi(60, 4, 'harmonic')).toBe(64);
  });
});

describe('ear-training sets', () => {
  it('Starter is P4, P5, P8, M3', () => {
    expect(earSetForLevel(1)).toEqual([4, 5, 7, 12]);
    expect(EAR_LEVELS[0].label).toBe('Starter');
  });

  it('levels only add, and level 5 is every simple interval but the unison', () => {
    for (let l = 2; l <= 5; l++) {
      const prev = earSetForLevel(l - 1);
      const cur = earSetForLevel(l);
      expect(prev.every((s) => cur.includes(s))).toBe(true);
      expect(cur.length).toBeGreaterThan(prev.length);
    }
    expect(earSetForLevel(5)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(earSetForLevel(99)).toEqual(earSetForLevel(5));
    expect(earSetForLevel(-3)).toEqual(earSetForLevel(1));
  });

  it('custom sets are cleaned, and too-small sets fall back to Starter', () => {
    expect(cleanIntervalSet([7, 3, 3, 15, -1, 2.2])).toEqual([2, 3, 7]);
    expect(cleanIntervalSet([7])).toEqual([4, 5, 7, 12]);
  });
});
