import { describe, expect, it } from 'vitest';
import { centsBetween, hzToMidi, midiToHz, midiToNoteName, noteNameToMidi } from './music';

describe('music', () => {
  it('converts between Hz and MIDI', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 12);
    expect(hzToMidi(261.6255653)).toBeCloseTo(60, 6);
    expect(midiToHz(69)).toBeCloseTo(440, 12);
    expect(midiToHz(57)).toBeCloseTo(220, 12);
    expect(hzToMidi(432, 432)).toBeCloseTo(69, 12);
    expect(midiToHz(69, 442)).toBeCloseTo(442, 12);
    expect(hzToMidi(midiToHz(63.37))).toBeCloseTo(63.37, 10);
    expect(hzToMidi(0)).toBeNaN();
    expect(hzToMidi(NaN)).toBeNaN();
  });

  it('names notes', () => {
    expect(midiToNoteName(60)).toBe('C4');
    expect(midiToNoteName(61)).toBe('C#4');
    expect(midiToNoteName(69)).toBe('A4');
    expect(midiToNoteName(59.6)).toBe('C4');
    expect(midiToNoteName(40)).toBe('E2');
    expect(midiToNoteName(0)).toBe('C-1');
    expect(midiToNoteName(NaN)).toBe('');
  });

  it('parses note names', () => {
    expect(noteNameToMidi('C4')).toBe(60);
    expect(noteNameToMidi('c4')).toBe(60);
    expect(noteNameToMidi('C#4')).toBe(61);
    expect(noteNameToMidi('Db4')).toBe(61);
    expect(noteNameToMidi('bb3')).toBe(58);
    expect(noteNameToMidi('B3')).toBe(59);
    expect(noteNameToMidi('A4')).toBe(69);
    expect(noteNameToMidi('C-1')).toBe(0);
    expect(noteNameToMidi('H2')).toBeNaN();
    expect(noteNameToMidi('')).toBeNaN();
    for (let m = 24; m < 96; m++) expect(noteNameToMidi(midiToNoteName(m))).toBe(m);
  });

  it('measures cents', () => {
    expect(centsBetween(440, 880)).toBeCloseTo(1200, 10);
    expect(centsBetween(880, 440)).toBeCloseTo(-1200, 10);
    expect(centsBetween(440, 440 * Math.pow(2, 1 / 12))).toBeCloseTo(100, 10);
    expect(centsBetween(0, 440)).toBeNaN();
  });
});
