// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakeAnalysis } from '../testing/fixtures';
import { clipFromAnalysis } from '../coach/measured';
import { clearMeasurements, loadMeasurements, MEASUREMENTS_KEY, parseMeasurements, saveMeasurements } from './measurements';

const clip = clipFromAnalysis(makeFakeAnalysis(), 'Stitches vocal', 'c1', '2026-09-26T10:00:00.000Z');

beforeEach(() => localStorage.clear());

describe('measurements storage', () => {
  it('round-trips clips per singer', () => {
    saveMeasurements({ 'shawn-mendes': [clip] });
    const back = loadMeasurements();
    expect(back['shawn-mendes']).toHaveLength(1);
    expect(back['shawn-mendes'][0].name).toBe('Stitches vocal');
    expect(back['shawn-mendes'][0].style.breathiness).toBe(clip.style.breathiness);
  });

  it('drops malformed and duplicate entries and empty singers', () => {
    const parsed = parseMeasurements({
      'shawn-mendes': [clip, { ...clip }, { id: 'x' }, 'nope'],
      'daniel-caesar': [],
      'jalen-ngonda': 'nope',
    });
    expect(parsed['shawn-mendes']).toHaveLength(1);
    expect(parsed['daniel-caesar']).toBeUndefined();
    expect(parsed['jalen-ngonda']).toBeUndefined();
  });

  it('survives corrupt JSON and clears', () => {
    localStorage.setItem(MEASUREMENTS_KEY, '{not json');
    expect(loadMeasurements()).toEqual({});
    saveMeasurements({ 'shawn-mendes': [clip] });
    clearMeasurements();
    expect(loadMeasurements()).toEqual({});
  });
});
