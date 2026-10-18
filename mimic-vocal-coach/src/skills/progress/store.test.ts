import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SKILLS_SESSIONS, SKILLS_STORE_KEY, type SkillsSession } from '../types';
import { breathSession, earSession, FakeStorage, matchSession, pitchTestSession, sequenceSession, singSession, workoutSession } from './testKit';

let storage: FakeStorage;
async function mod() {
  return import('./index');
}

beforeEach(() => {
  vi.resetModules();
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const everyKind = (): SkillsSession[] => [
  pitchTestSession([{ register: 'low', heldCents: -12 }, { register: 'high', heldCents: -30 }], 1, 'p1'),
  matchSession([{ register: 'mid', heldCents: 6 }], 2, 'm1'),
  earSession([{ semitones: 7, correct: true }, { semitones: 9, direction: 'down', correct: false }], 3, 'e1'),
  singSession([{ semitones: 9, intervalCents: 30 }, { semitones: 4, direction: 'down', intervalCents: null }], 4, 's1'),
  sequenceSession([{ degree: 7, cents: -40 }, { degree: 6, cents: 5 }], 0.5, 5, 'q1'),
  breathSession({ hissSec: 18, pacedRounds: 2, maxExhale: 10 }, 6, 'b1'),
  workoutSession(['m1', 'e1'], 7, 'w1'),
];

describe('parseSkillsStore', () => {
  it('never throws on garbage and gives an empty store with default preferences', async () => {
    const { parseSkillsStore, DEFAULT_SKILLS_PREFS } = await mod();
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'x',
      [],
      { sessions: 'no' },
      { sessions: [null, 1, 'a', {}, { kind: 'ear' }, { id: 'x', at: 'not a date', kind: 'ear' }] },
      { version: 1, sessions: [{ id: 'z', at: new Date().toISOString(), kind: 'pitch-test', notes: [{ targetMidi: 'C4' }] }] },
      { stats: { hear: { '7u': { n: -1, ema: 2 }, bogus: {} }, degrees: { 'major:9': { n: 1 } } }, bests: { hissSec: { value: -5 } } },
      { prefs: { strictness: 'harsh', earLevel: 'max', earDirections: ['sideways'], rangeOverride: { lowMidi: 50, highMidi: 55 } } },
    ];
    for (const g of garbage) {
      const s = parseSkillsStore(g);
      expect(s.version).toBe(1);
      expect(s.sessions).toEqual([]);
      expect(s.prefs).toEqual({ ...DEFAULT_SKILLS_PREFS, earCustom: [], earDirections: ['up', 'down'] });
      expect(Object.keys(s.stats.hear)).toEqual([]);
      expect(s.bests).toEqual({ hissSec: null, longToneSec: null, pacedExhaleCounts: null });
    }
  });

  it('keeps every valid session kind through JSON and drops bad ones one by one', async () => {
    const { parseSkillsStore, emptySkillsStore } = await mod();
    const good = everyKind();
    const raw = JSON.parse(JSON.stringify({ ...emptySkillsStore(), sessions: [{ id: 'bad', kind: 'nope', at: good[0].at }, ...good, 7] }));
    const s = parseSkillsStore(raw);
    expect(s.sessions.map((x) => x.id)).toEqual(['p1', 'm1', 'e1', 's1', 'q1', 'b1', 'w1']);
    expect(s.sessions).toEqual(good);
  });

  it('drops bad items inside a session but keeps the session, and recounts ear answers', async () => {
    const { parseSkillsStore } = await mod();
    const e = earSession([{ semitones: 7, correct: true }, { semitones: 5, correct: false }], 0, 'e');
    const raw = JSON.parse(JSON.stringify(e));
    raw.answers.push({ kind: 'interval', correctValue: 99, chosenValue: 1 }, 'junk');
    raw.correct = 50;
    raw.total = 2000;
    const s = parseSkillsStore({ sessions: [raw] });
    const got = s.sessions[0];
    expect(got.kind).toBe('ear');
    if (got.kind !== 'ear') return;
    expect(got.answers).toHaveLength(2);
    expect(got.correct).toBe(1);
    expect(got.total).toBe(2);
  });

  it('keeps one copy per id (the last), sorts oldest first and keeps only the newest 500', async () => {
    const { parseSkillsStore } = await mod();
    const many = Array.from({ length: 620 }, (_, i) => earSession([{ semitones: 7, correct: true }], 620 - i, `id${i}`));
    many.push(earSession([{ semitones: 5, correct: false }], 10_000, 'id0'));
    const s = parseSkillsStore({ sessions: many });
    expect(s.sessions).toHaveLength(MAX_SKILLS_SESSIONS);
    const times = s.sessions.map((x) => Date.parse(x.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(s.sessions[s.sessions.length - 1].id).toBe('id0');
    expect(s.sessions.filter((x) => x.id === 'id0')).toHaveLength(1);
  });

  it('rebuilds stats when a stored store has none, and keeps stored stats when present', async () => {
    const { parseSkillsStore, rebuildStats } = await mod();
    const sessions = everyKind();
    const noStats = parseSkillsStore({ sessions });
    expect(noStats.stats).toEqual(rebuildStats(sessions).stats);
    expect(noStats.bests.hissSec?.value).toBe(18);
    const stored = parseSkillsStore({ sessions: [], stats: { hear: { '7u': { n: 40, ema: 0.9, lastAt: sessions[0].at } } }, bests: {} });
    expect(stored.stats.hear['7u']).toEqual({ n: 40, ema: 0.9, lastAt: sessions[0].at });
  });

  it('validates each preference on its own', async () => {
    const { parseSkillsPrefs } = await mod();
    const p = parseSkillsPrefs({
      strictness: 'strict',
      labelMode: 'telepathy',
      scaleMode: 'harmonic-minor',
      earSetMode: 'custom',
      earLevel: 9,
      earCustom: [3, 3, 14, -1, 'x', 4.2, 12],
      earDirections: ['down', 'down', 'harmonic', 'left'],
      headphones: 'yes',
      rangeOverride: { lowMidi: 45, highMidi: 64 },
    });
    expect(p).toEqual({
      strictness: 'strict',
      labelMode: 'numbers',
      scaleMode: 'harmonic-minor',
      earSetMode: 'custom',
      earLevel: 5,
      earCustom: [3, 4, 12],
      earDirections: ['down', 'harmonic'],
      headphones: null,
      rangeOverride: { lowMidi: 45, highMidi: 64 },
    });
  });
});

describe('recordSkillsSession and updateSkillsPrefs', () => {
  it('appends in time order, updates stats and bests, and ignores duplicates and unusable sessions', async () => {
    const { emptySkillsStore, recordSkillsSession } = await mod();
    let s = emptySkillsStore();
    s = recordSkillsSession(s, breathSession({ hissSec: 20 }, 10, 'late'));
    s = recordSkillsSession(s, breathSession({ hissSec: 25, longToneSec: 14 }, 5, 'early'));
    expect(s.sessions.map((x) => x.id)).toEqual(['early', 'late']);
    expect(s.bests.hissSec).toEqual({ value: 25, at: s.sessions[0].at });
    expect(s.bests.longToneSec?.value).toBe(14);
    const same = recordSkillsSession(s, breathSession({ hissSec: 99 }, 11, 'late'));
    expect(same).toBe(s);
    const bad = recordSkillsSession(s, { kind: 'ear', id: 'x' } as unknown as SkillsSession);
    expect(bad).toBe(s);
    s = recordSkillsSession(s, earSession([{ semitones: 7, correct: false }], 12, 'e'));
    expect(s.stats.hear['7u']).toMatchObject({ n: 1, ema: 0 });
  });

  it('caps at 500 sessions, dropping the oldest', async () => {
    const { emptySkillsStore, recordSkillsSession } = await mod();
    let s = emptySkillsStore();
    for (let i = 0; i < 510; i++) s = recordSkillsSession(s, earSession([{ semitones: 5, correct: i % 2 === 0 }], i, `e${i}`));
    expect(s.sessions).toHaveLength(500);
    expect(s.sessions[0].id).toBe('e10');
    expect(s.stats.hear['5u']?.n).toBe(510);
  });

  it('applies valid preference changes and ignores bad ones', async () => {
    const { emptySkillsStore, updateSkillsPrefs } = await mod();
    const s = emptySkillsStore();
    const a = updateSkillsPrefs(s, { strictness: 'gentle', headphones: true, earLevel: 3 });
    expect(a.prefs).toMatchObject({ strictness: 'gentle', headphones: true, earLevel: 3 });
    const b = updateSkillsPrefs(a, { strictness: 'harsh' as never, rangeOverride: { lowMidi: 50, highMidi: 52 }, earDirections: [] });
    expect(b.prefs).toEqual(a.prefs);
    const c = updateSkillsPrefs(a, { headphones: null, rangeOverride: { lowMidi: 45, highMidi: 65 } });
    expect(c.prefs.headphones).toBeNull();
    expect(c.prefs.rangeOverride).toEqual({ lowMidi: 45, highMidi: 65 });
  });
});

describe('persistence', () => {
  it('saves, loads the same object until the stored text changes, and survives a reload', async () => {
    const m = await mod();
    expect(m.loadSkillsStore().sessions).toEqual([]);
    const s = m.recordSkillsSession(m.loadSkillsStore(), earSession([{ semitones: 7, correct: true }], 0, 'e'));
    expect(m.saveSkillsStore(s)).toBe(true);
    expect(m.loadSkillsStore()).toBe(s);
    expect(m.loadSkillsStore()).toBe(m.loadSkillsStore());
    expect(JSON.parse(storage.getItem(SKILLS_STORE_KEY) as string).version).toBe(1);
    // Another tab (or a fresh page) wrote different text: a new object, parsed from it.
    storage.setItem(SKILLS_STORE_KEY, JSON.stringify({ ...s, sessions: [] }));
    const again = m.loadSkillsStore();
    expect(again).not.toBe(s);
    expect(again.sessions).toEqual([]);
    vi.resetModules();
    const fresh = await mod();
    storage.setItem(SKILLS_STORE_KEY, JSON.stringify(s));
    expect(fresh.loadSkillsStore()).toEqual(s);
  });

  it('reads unparseable JSON as an empty store', async () => {
    storage.setItem(SKILLS_STORE_KEY, '{not json');
    const m = await mod();
    expect(m.loadSkillsStore().sessions).toEqual([]);
  });

  it('falls back to memory when storage is blocked, and keeps working', async () => {
    storage.failAll = true;
    const m = await mod();
    const s = m.recordSkillsSession(m.loadSkillsStore(), earSession([{ semitones: 7, correct: true }], 0, 'e'));
    expect(m.saveSkillsStore(s)).toBe(false);
    expect(m.loadSkillsStore().sessions).toHaveLength(1);
    m.clearSkillsStore();
    expect(m.loadSkillsStore().sessions).toHaveLength(0);
  });

  it('keeps the newest sessions when the full store does not fit (quota), stats intact', async () => {
    const m = await mod();
    let s = m.emptySkillsStore();
    for (let i = 0; i < 400; i++) s = m.recordSkillsSession(s, earSession([{ semitones: 7, correct: true }], i, `e${i}`));
    const full = JSON.stringify(s).length;
    storage.maxChars = Math.floor(full * 0.6);
    expect(m.saveSkillsStore(s)).toBe(true);
    const stored = JSON.parse(storage.getItem(SKILLS_STORE_KEY) as string);
    expect(stored.sessions).toHaveLength(150);
    expect(stored.sessions[149].id).toBe('e399');
    expect(stored.stats.hear['7u'].n).toBe(400);
  });

  it('notifies subscribers on save and clear; clear removes the key', async () => {
    const m = await mod();
    const fn = vi.fn();
    const off = m.subscribeSkillsStore(fn);
    m.saveSkillsStore(m.recordSkillsSession(m.emptySkillsStore(), breathSession({ hissSec: 12 }, 0, 'b')));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(storage.getItem(SKILLS_STORE_KEY)).not.toBeNull();
    m.clearSkillsStore();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(storage.getItem(SKILLS_STORE_KEY)).toBeNull();
    expect(m.loadSkillsStore().sessions).toEqual([]);
    expect(m.loadSkillsStore().bests.hissSec).toBeNull();
    off();
    m.clearSkillsStore();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives unique ids', async () => {
    const { skillsId } = await mod();
    const ids = new Set(Array.from({ length: 200 }, () => skillsId()));
    expect(ids.size).toBe(200);
  });
});
