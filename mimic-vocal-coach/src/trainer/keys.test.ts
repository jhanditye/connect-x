import { describe, expect, it } from 'vitest';
import {
  aboveTrackerRange,
  belowTrackerRange,
  guideShiftChoices,
  keyLine,
  MAX_GUIDE_SHIFT,
  rangeMessage,
  shiftLabel,
  suggestGuideShift,
  TRACKER_CEILING_MIDI,
  TRACKER_FLOOR_MIDI,
} from './keys';

describe('suggestGuideShift', () => {
  it('keeps the singer\'s own shift up to 7 semitones and exact octaves', () => {
    for (const n of [0, 1, -3, 7, -7, 12, -12]) expect(suggestGuideShift(n)).toBe(n);
    expect(suggestGuideShift(3.4)).toBe(3);
    expect(suggestGuideShift(-2.6)).toBe(-3);
    expect(MAX_GUIDE_SHIFT).toBe(7);
  });

  it('folds shifts between 8 and 11, and beyond an octave, to the octave-equivalent', () => {
    expect(suggestGuideShift(9)).toBe(-3);
    expect(suggestGuideShift(-9)).toBe(3);
    expect(suggestGuideShift(8)).toBe(-4);
    expect(suggestGuideShift(11)).toBe(-1);
    expect(suggestGuideShift(14)).toBe(2);
    expect(suggestGuideShift(-14)).toBe(-2);
    expect(suggestGuideShift(24)).toBe(0);
  });

  it('never returns NaN', () => {
    expect(suggestGuideShift(NaN)).toBe(0);
    expect(suggestGuideShift(Infinity)).toBe(0);
  });
});

describe('labels and ranges', () => {
  it('labels the chips', () => {
    expect(shiftLabel(0)).toBe('Original key');
    expect(shiftLabel(NaN)).toBe('Original key');
    expect(shiftLabel(3)).toBe('My key +3');
    expect(shiftLabel(-12)).toBe('My key -12 (octave)');
  });

  it('flags a shift that leaves the range the tracker can follow, and says what to do', () => {
    // A reference around B2 (MIDI 47) moved an octave down is below C2 (MIDI 36).
    expect(belowTrackerRange(47, -12)).toBe(true);
    expect(belowTrackerRange(60, -12)).toBe(false);
    expect(aboveTrackerRange(88, 3)).toBe(true);
    expect(rangeMessage(47, -12)).toMatch(/below the range the app can follow.*octave up/);
    expect(rangeMessage(88, 3)).toMatch(/above the range the app can follow.*octave down/);
    expect(rangeMessage(60, -12)).toBeNull();
    expect(rangeMessage(NaN, -12)).toBeNull();
    expect(TRACKER_FLOOR_MIDI).toBeLessThan(TRACKER_CEILING_MIDI);
  });

  it('writes the key line with note names in the singer\'s key', () => {
    expect(keyLine(64, -12)).toBe('Original E4, your key E3 (an octave lower)');
    expect(keyLine(64, 3)).toBe('Original E4, your key G4 (3 semitones higher)');
    expect(keyLine(64, -1)).toBe('Original E4, your key D#4 (1 semitone lower)');
    expect(keyLine(64, 0)).toBe('Original key (E4)');
    expect(keyLine(NaN, -12)).toBe('My key -12 (octave)');
    expect(keyLine(64, 24)).toBe('Original E4, your key E6 (2 octaves higher)');
  });

  it('offers the original and the suggested key as chips', () => {
    expect(guideShiftChoices(null)).toEqual([0]);
    expect(guideShiftChoices(0)).toEqual([0]);
    expect(guideShiftChoices(-12)).toEqual([0, -12]);
    expect(guideShiftChoices(9)).toEqual([0, -3]);
  });
});
