import { describe, expect, it } from 'vitest';
import { FAKE_NOW, makeFakeClip } from '../../testing/trainerFixtures';
import type { PhraseRecord } from '../../types';
import { clipLength, neighbours, phraseByNumber, phraseCount, phraseLength, phraseNumber, phraseStatus, STATUS_HINT, STATUS_LABEL, summariseClip, visiblePhrases } from './phraseStatus';

const blank = (over: Partial<PhraseRecord> = {}): PhraseRecord => ({ ...makeFakeClip().phrases[10], ...over });

describe('phraseStatus', () => {
  it('reads the status of each fake phrase from what is stored on it', () => {
    const clip = makeFakeClip();
    const status = clip.phrases.map((p) => phraseStatus(p, FAKE_NOW));
    expect(status.slice(0, 3)).toEqual(['review-due', 'review-due', 'review-due']);
    expect(status[3]).toBe('mastered');
    expect(status.slice(4, 9)).toEqual(['learning', 'learning', 'learning', 'learning', 'learning']);
    expect(status[9]).toBe('stuck');
    expect(status.slice(10)).toEqual(['new', 'new']);
  });

  it('a mastered phrase is only due once its due time has come', () => {
    const p = makeFakeClip().phrases[3];
    expect(p.srs.dueAt).not.toBeNull();
    expect(phraseStatus(p, (p.srs.dueAt as number) - 1)).toBe('mastered');
    expect(phraseStatus(p, p.srs.dueAt as number)).toBe('review-due');
  });

  it('a phrase never tried is new, whatever else is stored', () => {
    expect(phraseStatus(blank(), FAKE_NOW)).toBe('new');
  });

  it('stuck needs six full-speed tries and recent scores that never reached 70', () => {
    const base = blank({ stats: { attempts: 6, fullSpeedAttempts: 6, best: 66, last: 63, recent: [52, 58, 61, 55, 66], lastAt: FAKE_NOW } });
    expect(phraseStatus(base, FAKE_NOW)).toBe('stuck');
    expect(phraseStatus({ ...base, stats: { ...base.stats, fullSpeedAttempts: 5 } }, FAKE_NOW)).toBe('learning');
    expect(phraseStatus({ ...base, stats: { ...base.stats, recent: [52, 58, 71, 55, 66] } }, FAKE_NOW)).toBe('learning');
  });

  it('has a label and a hint for every status', () => {
    for (const k of Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]) {
      expect(STATUS_LABEL[k]).toMatch(/^[A-Z]/);
      expect(STATUS_HINT[k].length).toBeGreaterThan(10);
    }
  });
});

describe('summariseClip', () => {
  it('counts mastered (reviews due included), learning, stuck and new phrases', () => {
    const s = summariseClip(makeFakeClip(), FAKE_NOW);
    expect(s).toEqual({ total: 12, hidden: 0, mastered: 4, reviewDue: 3, learning: 6, stuck: 1, fresh: 2 });
  });

  it('leaves hidden phrases out of the counts', () => {
    const clip = makeFakeClip();
    clip.phrases = clip.phrases.map((p, i) => (i >= 10 ? { ...p, hidden: true } : p));
    const s = summariseClip(clip, FAKE_NOW);
    expect(s.total).toBe(10);
    expect(s.hidden).toBe(2);
    expect(s.fresh).toBe(0);
    expect(visiblePhrases(clip)).toHaveLength(10);
  });
});

describe('numbering and neighbours', () => {
  it('numbers phrases from 1 by their position, hidden ones included', () => {
    const clip = makeFakeClip();
    expect(phraseNumber(clip.phrases[0])).toBe(1);
    expect(phraseByNumber(clip, 12)?.id).toBe(clip.phrases[11].id);
    expect(phraseByNumber(clip, 13)).toBeUndefined();
    expect(phraseByNumber(clip, 0)).toBeUndefined();
  });

  it('finds the previous and next visible phrase, and nothing at the ends', () => {
    const clip = makeFakeClip();
    clip.phrases[3] = { ...clip.phrases[3], hidden: true };
    expect(neighbours(clip, clip.phrases[0])).toEqual({ prev: null, next: clip.phrases[1] });
    expect(neighbours(clip, clip.phrases[2]).next?.id).toBe(clip.phrases[4].id);
    expect(neighbours(clip, clip.phrases[11])).toEqual({ prev: clip.phrases[10], next: null });
  });

  it('steps around a hidden phrase that was opened by a link', () => {
    const clip = makeFakeClip();
    clip.phrases[3] = { ...clip.phrases[3], hidden: true };
    const n = neighbours(clip, clip.phrases[3]);
    expect(n.prev?.id).toBe(clip.phrases[2].id);
    expect(n.next?.id).toBe(clip.phrases[4].id);
  });
});

describe('words', () => {
  it('writes counts and lengths', () => {
    expect(phraseCount(1)).toBe('1 phrase');
    expect(phraseCount(12)).toBe('12 phrases');
    expect(clipLength(84)).toBe('1:24');
    expect(clipLength(-1)).toBe('–');
    expect(clipLength(Number.NaN)).toBe('–');
    expect(phraseLength(6.123)).toBe('6.1 s');
    expect(phraseLength(12.4)).toBe('12 s');
  });
});
