// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { interruptedSplit, markSplitEnded, markSplitStarted, resetSplitMarkerForTests } from './splitMarker';

const KEY = 'mimic.isolateInProgress.v1';

beforeEach(() => {
  localStorage.clear();
  resetSplitMarkerForTests();
});

describe('split marker', () => {
  it('a split that ends any way leaves nothing behind', () => {
    markSplitStarted({ fileName: 'Song.wav', seconds: 60 });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    markSplitEnded();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(interruptedSplit()).toBeNull();
  });

  it('a note from an earlier page load is reported once as a cut-off split, with what was being split', () => {
    localStorage.setItem(KEY, JSON.stringify({ fileName: 'Song.wav', seconds: 300, startedAt: 1_700_000_000_000, session: 'an-earlier-page' }));
    expect(interruptedSplit()).toEqual({ fileName: 'Song.wav', seconds: 300, startedAt: 1_700_000_000_000 });
    expect(localStorage.getItem(KEY)).toBeNull(); // read once
    expect(interruptedSplit()).toEqual({ fileName: 'Song.wav', seconds: 300, startedAt: 1_700_000_000_000 }); // same answer for a screen that opens again
  });

  it('this page\'s own running split is never mistaken for a cut-off one', () => {
    markSplitStarted({ fileName: 'Song.wav', seconds: 60 });
    expect(interruptedSplit()).toBeNull();
  });

  it('starting a new split drops the old message, and an end never removes another page\'s note', () => {
    localStorage.setItem(KEY, JSON.stringify({ fileName: 'Old.wav', seconds: 60, startedAt: 1, session: 'an-earlier-page' }));
    markSplitEnded();
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(interruptedSplit()?.fileName).toBe('Old.wav');
    markSplitStarted({ fileName: 'New.wav', seconds: 60 });
    expect(interruptedSplit()).toBeNull();
  });

  it('survives damaged data and unavailable storage', () => {
    localStorage.setItem(KEY, '{not json');
    expect(interruptedSplit()).toBeNull();
    resetSplitMarkerForTests();
    localStorage.setItem(KEY, JSON.stringify({ fileName: 5 }));
    expect(interruptedSplit()).toBeNull();
    resetSplitMarkerForTests();
    const broken = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => markSplitStarted({ fileName: 'x', seconds: 1 })).not.toThrow();
    broken.mockRestore();
  });
});
