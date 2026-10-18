import { describe, expect, it } from 'vitest';
import { passaggioFor } from '../../analysis/passaggio';
import type { VoiceType } from '../../types';
import { SEQUENCE_PRESETS, randomLine } from './generate';
import { candidateTonics, comfortableRange, fitSequence, fitTonic, registerBands, registerThirdOf, tooWideMessage } from './range';
import { mulberry32 } from './rng';
import { parseSequence } from './sequence';

const VOICES: VoiceType[] = ['bass', 'baritone', 'tenor', 'alto', 'mezzo', 'soprano'];

describe('comfortable range', () => {
  it('sits a few semitones above the passaggio start at the top, and spans at least 17 semitones', () => {
    for (const v of VOICES) {
      const r = comfortableRange(v);
      expect(r.highMidi).toBe(passaggioFor(v).lowMidi + 3);
      expect(r.highMidi - r.lowMidi).toBeGreaterThanOrEqual(17);
    }
    expect(comfortableRange('baritone')).toEqual({ lowMidi: 45, highMidi: 65 }); // A2-F4
  });

  it('a sane override wins; a silly one is ignored', () => {
    expect(comfortableRange('tenor', { lowMidi: 50, highMidi: 70 })).toEqual({ lowMidi: 50, highMidi: 70 });
    expect(comfortableRange('tenor', { lowMidi: 60, highMidi: 64 })).toEqual(comfortableRange('tenor'));
    expect(comfortableRange('tenor', { lowMidi: Number.NaN, highMidi: 70 })).toEqual(comfortableRange('tenor'));
  });

  it('register thirds cover the range without gaps', () => {
    for (const v of VOICES) {
      const r = comfortableRange(v);
      const b = registerBands(r);
      expect(b.low.lowMidi).toBe(r.lowMidi);
      expect(b.mid.lowMidi).toBe(b.low.highMidi + 1);
      expect(b.high.lowMidi).toBe(b.mid.highMidi + 1);
      expect(b.high.highMidi).toBe(r.highMidi);
      for (const band of [b.low, b.mid, b.high]) expect(band.highMidi - band.lowMidi).toBeGreaterThanOrEqual(4);
    }
    const r = { lowMidi: 45, highMidi: 65 };
    expect(registerThirdOf(45, r)).toBe('low');
    expect(registerThirdOf(55, r)).toBe('mid');
    expect(registerThirdOf(65, r)).toBe('high');
    expect(registerThirdOf(30, r)).toBe('low');
  });
});

describe('fitting lines into the range', () => {
  it('every preset fits every voice type, every note inside the range, centred', () => {
    for (const v of VOICES) {
      const range = comfortableRange(v);
      const centre = (range.lowMidi + range.highMidi) / 2;
      for (const p of SEQUENCE_PRESETS) {
        const parsed = parseSequence(p.text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        const t = fitSequence(parsed.notes, 'major', range);
        expect(t, `${v} ${p.text}`).not.toBeNull();
        if (!t) continue;
        for (const m of t.midis) {
          expect(m).toBeGreaterThanOrEqual(range.lowMidi);
          expect(m).toBeLessThanOrEqual(range.highMidi);
        }
        const lineCentre = (Math.min(...t.midis) + Math.max(...t.midis)) / 2;
        expect(Math.abs(lineCentre - centre)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('keeps a semitone of margin from the edges when the line leaves room', () => {
    const range = { lowMidi: 45, highMidi: 65 };
    const offsets = [0, 4, 7, 12];
    for (const t of candidateTonics(offsets, range)) {
      expect(t).toBeGreaterThanOrEqual(46);
      expect(t + 12).toBeLessThanOrEqual(64);
    }
  });

  it('uses the edges only when it must, and gives up when the line is too wide', () => {
    const range = { lowMidi: 60, highMidi: 72 };
    expect(candidateTonics([0, 12], range)).toEqual([60]);
    expect(fitTonic([0, 13], range)).toBeNull();
    const parsed = parseSequence('1 8+');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(fitSequence(parsed.notes, 'major', range)).toBeNull();
      expect(tooWideMessage(parsed.notes, range)).toMatch(/spans 24 semitones but your comfortable range is 12/);
    }
  });

  it('with an rng, varies the key but stays within 2 semitones of the most central placement', () => {
    const range = comfortableRange('tenor');
    const offsets = [11, 9, 7, 5, 4, 2];
    const best = fitTonic(offsets, range) as number;
    const rng = mulberry32(5);
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const t = fitTonic(offsets, range, rng) as number;
      seen.add(t);
      expect(Math.abs(t - best)).toBeLessThanOrEqual(2);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('random lines (all modes, lengths 4-8) always fit every voice type', () => {
    const rng = mulberry32(11);
    for (const v of VOICES) {
      const range = comfortableRange(v);
      for (const mode of ['major', 'natural-minor', 'harmonic-minor'] as const) {
        for (let i = 0; i < 20; i++) {
          const line = randomLine(rng, 4 + (i % 5), mode);
          const t = fitSequence(line, mode, range, rng);
          expect(t).not.toBeNull();
          for (const m of t?.midis ?? []) expect(m >= range.lowMidi && m <= range.highMidi).toBe(true);
        }
      }
    }
  });
});
