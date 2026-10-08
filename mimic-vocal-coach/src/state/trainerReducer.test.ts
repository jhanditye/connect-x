import { describe, expect, it } from 'vitest';
import { FAKE_NOW, makeFakeAttempts, makeFakeClip } from '../testing/trainerFixtures';
import type { AttemptRecord, ClipRecord, PhraseRecord } from '../types';
import {
  applyClipPatch,
  cleanTags,
  findPhrase,
  initialTrainerState,
  normalizePhrases,
  RECENT_PER_PHRASE,
  recentFromAttempts,
  selectQueue,
  trainerReducer,
  type TrainerState,
} from './trainerReducer';

const clip = (over: Partial<ClipRecord> = {}) => makeFakeClip(over);
const loaded = (clips: ClipRecord[], attempts: AttemptRecord[] = []): TrainerState =>
  trainerReducer(initialTrainerState(FAKE_NOW), { type: 'loaded', clips, recent: recentFromAttempts(attempts), memoryReason: null, warnings: [], lastExportAt: null, attemptsSinceExport: 0 });

describe('trainerReducer', () => {
  it('starts loading with nothing in it', () => {
    const s = initialTrainerState(123);
    expect(s).toMatchObject({ status: 'loading', error: null, clips: [], recent: {}, now: 123, attemptsSinceExport: 0 });
    expect(s.storage.supported).toBe(false);
  });

  it('loaded: ready, or memory-only with the reason; clips newest first', () => {
    const old = clip({ id: 'old', addedAt: '2026-01-01T00:00:00Z' });
    const fresh = clip({ id: 'new', addedAt: '2026-06-01T00:00:00Z' });
    const ready = loaded([old, fresh]);
    expect(ready.status).toBe('ready');
    expect(ready.clips.map((c) => c.id)).toEqual(['new', 'old']);
    const mem = trainerReducer(ready, { type: 'loaded', clips: [], recent: {}, memoryReason: 'No IndexedDB', warnings: ['w'], lastExportAt: '2026-10-01T00:00:00Z', attemptsSinceExport: 4 });
    expect(mem).toMatchObject({ status: 'memory-only', memoryReason: 'No IndexedDB', warnings: ['w'], lastExportAt: '2026-10-01T00:00:00Z', attemptsSinceExport: 4 });
  });

  it('failed keeps the clips on screen and names the problem; loading again clears it', () => {
    const s = trainerReducer(loaded([clip()]), { type: 'failed', message: 'Export a backup, then reload.' });
    expect(s).toMatchObject({ status: 'error', error: 'Export a backup, then reload.' });
    expect(s.clips).toHaveLength(1);
    const back = trainerReducer(s, { type: 'loaded', clips: s.clips, recent: {}, memoryReason: null, warnings: [], lastExportAt: null, attemptsSinceExport: 0 });
    expect(back).toMatchObject({ status: 'ready', error: null });
  });

  it('recovered clears an error and returns to the mode the library is in', () => {
    const failed = trainerReducer(loaded([clip()]), { type: 'failed', message: 'x' });
    expect(trainerReducer(failed, { type: 'recovered' })).toMatchObject({ status: 'ready', error: null });
    const memory = trainerReducer(trainerReducer(loaded([]), { type: 'loaded', clips: [], recent: {}, memoryReason: 'no idb', warnings: [], lastExportAt: null, attemptsSinceExport: 0 }), { type: 'failed', message: 'x' });
    expect(trainerReducer(memory, { type: 'recovered' }).status).toBe('memory-only');
    const ready = loaded([]);
    expect(trainerReducer(ready, { type: 'recovered' })).toBe(ready);
  });

  it('clip/put replaces by id and clip/remove drops the clip and the attempts cached for its phrases', () => {
    const a = clip();
    const attempts = makeFakeAttempts();
    let s = loaded([a], attempts);
    expect(Object.keys(s.recent).length).toBeGreaterThan(5);
    s = trainerReducer(s, { type: 'clip/put', clip: { ...a, title: 'Renamed' } });
    expect(s.clips).toHaveLength(1);
    expect(s.clips[0].title).toBe('Renamed');
    s = trainerReducer(s, { type: 'clip/remove', id: a.id });
    expect(s.clips).toEqual([]);
    expect(s.recent).toEqual({});
  });

  it('a phrase that is edited away loses its cached attempts', () => {
    const a = clip();
    let s = loaded([a], makeFakeAttempts());
    s = trainerReducer(s, { type: 'clip/put', clip: { ...a, phrases: a.phrases.slice(2) } });
    expect(s.recent[a.phrases[0].id]).toBeUndefined();
    expect(s.recent[a.phrases[2].id]).toBeDefined();
  });

  it('recent/set keeps the newest ones, recent/replace prunes to known phrases', () => {
    const a = clip();
    const many = Array.from({ length: 30 }, (_, i) => ({ at: i, overall: i, pitch: 1, timing: 1, tone: 1, rate: 1, coverage: 1, wrongNotes: 0 }));
    let s = loaded([a]);
    s = trainerReducer(s, { type: 'recent/set', phraseId: a.phrases[0].id, attempts: many });
    expect(s.recent[a.phrases[0].id]).toHaveLength(RECENT_PER_PHRASE);
    expect(s.recent[a.phrases[0].id][RECENT_PER_PHRASE - 1].at).toBe(29);
    s = trainerReducer(s, { type: 'recent/replace', recent: { [a.phrases[1].id]: many.slice(0, 2), ghost: many } });
    expect(Object.keys(s.recent)).toEqual([a.phrases[1].id]);
  });

  it('storage, export, tick and reset', () => {
    let s = loaded([clip()], makeFakeAttempts());
    s = trainerReducer(s, { type: 'storage', storage: { supported: true, usage: 1, quota: 2, persisted: true } });
    expect(s.storage.persisted).toBe(true);
    s = trainerReducer(s, { type: 'export', lastExportAt: '2026-10-08T00:00:00Z', attemptsSinceExport: 3 });
    expect(s).toMatchObject({ lastExportAt: '2026-10-08T00:00:00Z', attemptsSinceExport: 3 });
    expect(trainerReducer(s, { type: 'tick', now: s.now })).toBe(s);
    expect(trainerReducer(s, { type: 'tick', now: s.now + 1 }).now).toBe(s.now + 1);
    const reset = trainerReducer(s, { type: 'reset' });
    expect(reset).toMatchObject({ clips: [], recent: {}, attemptsSinceExport: 0, lastExportAt: null, storage: s.storage });
  });
});

describe('selectQueue', () => {
  const attempts = makeFakeAttempts();

  it('puts due reviews first, then stuck, then phrases being learned, and caps the list at five', () => {
    const s = loaded([clip()], attempts);
    const q = selectQueue(s);
    expect(q).toHaveLength(5);
    expect(q.map((i) => i.status)).toEqual(['review-due', 'review-due', 'review-due', 'stuck', 'learning']);
    expect(selectQueue(s, 20)).toHaveLength(11); // 3 reviews, 1 stuck, 5 learning, 2 new; the mastered phrase that is not due yet is left out
    expect(selectQueue(s, 2)).toHaveLength(2);
  });

  it('lists every phrase of a clip that was never practised as new', () => {
    const q = selectQueue(loaded([clip({ phrases: clip().phrases.slice(10) })]), 10);
    expect(q.map((i) => i.status)).toEqual(['new', 'new']);
  });

  it('skips hidden phrases and clips whose audio is missing', () => {
    const base = clip();
    const hidden = clip({ phrases: base.phrases.map((p, i) => (i < 11 ? { ...p, hidden: true } : p)) });
    expect(selectQueue(loaded([hidden], attempts), 20).map((i) => i.phraseId)).toEqual([base.phrases[11].id]);
    expect(selectQueue(loaded([clip({ audioMissing: true })], attempts))).toEqual([]);
  });

  it('reads the date from the state, so a day later a mastered phrase is due', () => {
    const s = loaded([clip()], attempts);
    const later = trainerReducer(s, { type: 'tick', now: FAKE_NOW + 70 * 86_400_000 });
    const due = (st: TrainerState) => selectQueue(st, 20).filter((i) => i.status === 'review-due').length;
    expect(due(later)).toBeGreaterThan(due(s));
  });

  it('is empty for an empty library', () => {
    expect(selectQueue(loaded([]))).toEqual([]);
  });
});

describe('recentFromAttempts and findPhrase', () => {
  it('groups by phrase, oldest first, newest N', () => {
    const list = makeFakeAttempts();
    const r = recentFromAttempts(list, 3);
    for (const [id, items] of Object.entries(r)) {
      expect(items.length).toBeLessThanOrEqual(3);
      expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort((a, b) => a - b));
      const all = list.filter((a) => a.phraseId === id).sort((a, b) => a.at - b.at);
      expect(items[items.length - 1].at).toBe(all[all.length - 1].at);
    }
  });

  it('finds a phrase and its clip', () => {
    const a = clip();
    const b = clip({ id: 'other', phrases: clip().phrases.map((p) => ({ ...p, id: `other-${p.id}` })) });
    expect(findPhrase([a, b], 'other-fake-clip-p3')?.clip.id).toBe('other');
    expect(findPhrase([a, b], a.phrases[2].id)?.clip.id).toBe(a.id);
    expect(findPhrase([a, b], 'nope')).toBeNull();
  });
});

describe('applyClipPatch', () => {
  const now = '2026-10-09T09:00:00.000Z';
  const singers = new Set(['shawn-mendes', 'daniel-caesar']);

  it('renames, trims and stamps the edit time without touching the input', () => {
    const c = clip();
    const snapshot = JSON.stringify(c);
    const next = applyClipPatch(c, { title: '  Stitches, verse 1  ' }, now);
    expect(next.title).toBe('Stitches, verse 1');
    expect(next.updatedAt).toBe(now);
    expect(JSON.stringify(c)).toBe(snapshot);
    expect(next.phrases).toBe(c.phrases);
  });

  it('refuses an empty name with the fix', () => {
    expect(() => applyClipPatch(clip(), { title: '   ' }, now)).toThrow(/Give the clip a name/);
  });

  it('assigns a known singer (clearing a typed name) or "someone else" with a label', () => {
    const typed = clip({ singerId: null, singerLabel: 'My friend' });
    const named = applyClipPatch(typed, { singerId: 'daniel-caesar' }, now, singers);
    expect(named).toMatchObject({ singerId: 'daniel-caesar', singerLabel: '' });
    const other = applyClipPatch(named, { singerId: null, singerLabel: '  Frank  ' }, now, singers);
    expect(other).toMatchObject({ singerId: null, singerLabel: 'Frank' });
    expect(applyClipPatch(typed, { singerId: 'daniel-caesar', singerLabel: 'kept' }, now, singers).singerLabel).toBe('kept');
  });

  it('refuses a singer the app does not know', () => {
    expect(() => applyClipPatch(clip(), { singerId: 'nobody' }, now, singers)).toThrow(/Choose one of the singers/);
    expect(() => applyClipPatch(clip(), { singerId: '' }, now, singers)).toThrow(/Choose one of the singers/);
    expect(applyClipPatch(clip(), { singerId: 'nobody' }, now, null).singerId).toBe('nobody'); // no list to check against
  });

  it('cleans tags, bounds notes and checks difficulty', () => {
    const next = applyClipPatch(clip(), { tags: ['a', ' a ', '', 'b'], notes: 'x'.repeat(5000), difficulty: 3 }, now);
    expect(next.tags).toEqual(['a', 'b']);
    expect(next.notes).toHaveLength(2000);
    expect(next.difficulty).toBe(3);
    expect(applyClipPatch(clip(), { difficulty: null }, now).difficulty).toBeNull();
    expect(() => applyClipPatch(clip(), { difficulty: 5 as 1 }, now)).toThrow(/Difficulty is 1, 2 or 3/);
    expect(cleanTags('nope')).toEqual([]);
    expect(cleanTags(Array.from({ length: 40 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});

describe('normalizePhrases', () => {
  const base = clip({ durationSec: 30 }).phrases;
  const p = (over: Partial<PhraseRecord>): PhraseRecord => ({ ...base[0], ...over });

  it('sorts, renumbers and clamps to the clip', () => {
    const out = normalizePhrases([p({ id: 'b', start: 10, end: 99, index: 7 }), p({ id: 'a', start: -2, end: 6, index: 3 })], 30);
    expect(out.map((x) => [x.id, x.index, x.start, x.end])).toEqual([['a', 0, 0, 6], ['b', 1, 10, 30]]);
  });

  it('drops phrases that are too short, repeated or not numbers', () => {
    const out = normalizePhrases(
      [p({ id: 'ok', start: 0, end: 5 }), p({ id: 'ok', start: 6, end: 9 }), p({ id: 'tiny', start: 12, end: 12.1 }), p({ id: 'nan', start: NaN, end: 4 }), p({ id: 'beyond', start: 40, end: 50 }), null as unknown as PhraseRecord, p({ id: '' })],
      30,
    );
    expect(out.map((x) => x.id)).toEqual(['ok']);
  });

  it('keeps the voiced span inside the window and the speed in range', () => {
    const [x] = normalizePhrases([p({ id: 'a', start: 2, end: 8, voicedStart: -5, voicedEnd: 99, rate: 3 })], 30);
    expect(x).toMatchObject({ voicedStart: 2, voicedEnd: 8, rate: 1 });
    const [y] = normalizePhrases([p({ id: 'a', start: 2, end: 8, voicedStart: NaN, rate: 0.1 })], 30);
    expect(y).toMatchObject({ voicedStart: 2, rate: 0.5 });
  });

  it('keeps the history on the phrases it keeps', () => {
    const keep = base[3];
    const [x] = normalizePhrases([keep], 100);
    expect(x.stats).toEqual(keep.stats);
    expect(x.srs).toEqual(keep.srs);
  });

  it('throws for something that is not a list', () => {
    expect(() => normalizePhrases('nope' as unknown as PhraseRecord[], 30)).toThrow(/not valid/);
  });

  it('does not clamp to a duration it does not know', () => {
    expect(normalizePhrases([p({ id: 'a', start: 0, end: 500 })], 0)[0].end).toBe(500);
  });
});
