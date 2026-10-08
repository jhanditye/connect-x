import { describe, expect, it } from 'vitest';
import { despikeOctaves } from './contour';

const HOP = 0.01;
const line = (segments: [number, number][]): Float64Array => Float64Array.from(segments.flatMap(([midi, n]) => Array.from({ length: n }, () => midi)));

describe('despikeOctaves', () => {
  it('folds a short octave slip back to the neighbours\' octave', () => {
    const m = line([[54, 70], [66, 18], [54, 70]]);
    const out = despikeOctaves(m, HOP);
    expect(Array.from(out.slice(70, 88))).toEqual(Array(18).fill(54));
    expect(Array.from(out.slice(0, 70))).toEqual(Array(70).fill(54));
  });

  it('folds a slip of two octaves too, and a slip downwards', () => {
    expect(Array.from(despikeOctaves(line([[60, 60], [84, 10], [60, 60]]), HOP).slice(60, 70))).toEqual(Array(10).fill(60));
    expect(Array.from(despikeOctaves(line([[60, 60], [48, 10], [60, 60]]), HOP).slice(60, 70))).toEqual(Array(10).fill(60));
  });

  it('drops a harmonic slip that is not an octave (a third harmonic is 19 semitones up)', () => {
    const out = despikeOctaves(line([[55, 60], [74, 12], [55, 60]]), HOP);
    expect(Array.from(out.slice(60, 72)).every(Number.isNaN)).toBe(true);
    expect(out[10]).toBe(55);
  });

  it('leaves real notes alone: a long octave leap, a fifth, vibrato, and unvoiced gaps', () => {
    const leap = line([[50, 80], [62, 80]]);
    expect(Array.from(despikeOctaves(leap, HOP))).toEqual(Array.from(leap));
    const fifth = line([[55, 25], [62, 25], [55, 25]]);
    expect(Array.from(despikeOctaves(fifth, HOP))).toEqual(Array.from(fifth));
    const vib = Float64Array.from({ length: 300 }, (_, i) => 60 + 0.5 * Math.sin((2 * Math.PI * 5.5 * i * HOP)));
    expect(Array.from(despikeOctaves(vib, HOP))).toEqual(Array.from(vib));
    const gap = Float64Array.from([...Array(40).fill(57), ...Array(20).fill(NaN), ...Array(40).fill(57)]);
    const out = despikeOctaves(gap, HOP);
    expect(out.filter(Number.isFinite)).toHaveLength(80);
  });

  it('does nothing to empty, all-unvoiced and very short input', () => {
    expect(despikeOctaves(new Float64Array(0), HOP)).toHaveLength(0);
    expect(Array.from(despikeOctaves(new Float64Array(30).fill(NaN), HOP)).every(Number.isNaN)).toBe(true);
    const tiny = Float64Array.from([60, 72, 60]);
    expect(Array.from(despikeOctaves(tiny, HOP))).toEqual([60, 72, 60]);
  });

  it('does not change its input', () => {
    const m = line([[54, 70], [66, 18], [54, 70]]);
    const copy = Float64Array.from(m);
    despikeOctaves(m, HOP);
    expect(Array.from(m)).toEqual(Array.from(copy));
  });
});
