import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_STYLE, makeFakeAnalysis, makeFakeComparison, makeFakeProfile, makeFakeSessions } from '../testing/fixtures';
import type { SessionRecord } from '../types';

/** Minimal in-memory Storage; `failWrites` / `failAll` simulate quota errors and blocked storage. */
class FakeStorage implements Storage {
  data = new Map<string, string>();
  failWrites = false;
  failAll = false;
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    if (this.failAll) throw new DOMException('blocked', 'SecurityError');
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    if (this.failAll) throw new DOMException('blocked', 'SecurityError');
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.failAll) throw new DOMException('blocked', 'SecurityError');
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError');
    this.data.set(k, String(v));
  }
}

let store: FakeStorage;

// Fresh module state (the in-memory fallback) for every test.
async function history() {
  return import('./history');
}
async function settings() {
  return import('./settings');
}

beforeEach(() => {
  vi.resetModules();
  store = new FakeStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function rec(id: string, day: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { ...makeFakeSessions(1)[0], id, createdAt: new Date(Date.UTC(2026, 8, day, 12)).toISOString(), ...overrides };
}

describe('history', () => {
  it('saves, loads newest first, replaces by id and deletes', async () => {
    const h = await history();
    expect(h.loadSessions()).toEqual([]);
    h.saveSession(rec('a', 1));
    h.saveSession(rec('b', 3));
    h.saveSession(rec('c', 2));
    expect(h.loadSessions().map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(JSON.parse(store.getItem('mimic:v1:sessions')!)).toHaveLength(3);

    h.saveSession(rec('a', 1, { overall: 99 }));
    expect(h.loadSessions()).toHaveLength(3);
    expect(h.loadSessions().find((s) => s.id === 'a')?.overall).toBe(99);

    h.deleteSession('c');
    expect(h.loadSessions().map((s) => s.id)).toEqual(['b', 'a']);
    h.deleteSession('missing');
    expect(h.loadSessions()).toHaveLength(2);

    h.clearSessions();
    expect(h.loadSessions()).toEqual([]);
    expect(store.getItem('mimic:v1:sessions')).toBeNull();
  });

  it('keeps only the newest 200', async () => {
    const h = await history();
    const many = Array.from({ length: 205 }, (_, i) => rec(`s${i}`, 1, { createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() }));
    store.setItem('mimic:v1:sessions', JSON.stringify(many.slice(0, 200)));
    for (const r of many.slice(200)) h.saveSession(r);
    const list = h.loadSessions();
    expect(list).toHaveLength(200);
    expect(list[0].id).toBe('s204');
    expect(list.some((s) => s.id === 's0')).toBe(false);
  });

  it('ignores corrupt JSON and drops malformed entries', async () => {
    const h = await history();
    store.setItem('mimic:v1:sessions', '{not json');
    expect(h.loadSessions()).toEqual([]);

    store.setItem('mimic:v1:sessions', JSON.stringify({ not: 'an array' }));
    expect(h.loadSessions()).toEqual([]);

    const good = rec('ok', 5);
    store.setItem(
      'mimic:v1:sessions',
      JSON.stringify([
        good,
        null,
        42,
        { ...good, id: 'no-date', createdAt: 'yesterday' },
        { ...good, id: 'bad-overall', overall: 'high' },
        { ...good, id: '' },
        { ...good, id: 'ok' }, // duplicate id
        { ...good, id: 'partial', style: { breathiness: 'x', rasp: 0.2 }, dimensionScores: { rasp: 70, bogus: 5, brightness: null } },
      ]),
    );
    const list = h.loadSessions();
    expect(list.map((s) => s.id).sort()).toEqual(['ok', 'partial']);
    const partial = list.find((s) => s.id === 'partial')!;
    expect(partial.style.breathiness).toBeNull();
    expect(partial.style.rasp).toBe(0.2);
    expect(partial.style.flipsPerMinute).toBeNull();
    expect(partial.dimensionScores).toEqual({ rasp: 70 });

    // A corrupt store is overwritten by the next save.
    store.setItem('mimic:v1:sessions', 'garbage');
    h.saveSession(rec('new', 6));
    expect(h.loadSessions().map((s) => s.id)).toEqual(['new']);
  });

  it('falls back to memory when storage is blocked', async () => {
    store.failAll = true;
    const h = await history();
    expect(h.loadSessions()).toEqual([]);
    h.saveSession(rec('a', 1));
    h.saveSession(rec('b', 2));
    expect(h.loadSessions().map((s) => s.id)).toEqual(['b', 'a']);
    h.deleteSession('b');
    expect(h.loadSessions().map((s) => s.id)).toEqual(['a']);
    h.clearSessions();
    expect(h.loadSessions()).toEqual([]);
  });

  it('falls back to memory when there is no localStorage at all', async () => {
    vi.stubGlobal('localStorage', undefined);
    const h = await history();
    h.saveSession(rec('a', 1));
    expect(h.loadSessions().map((s) => s.id)).toEqual(['a']);
  });

  it('keeps working in memory when a write fails (quota)', async () => {
    const h = await history();
    h.saveSession(rec('a', 1));
    store.failWrites = true;
    h.saveSession(rec('b', 2));
    expect(h.loadSessions().map((s) => s.id)).toEqual(['b', 'a']);
    // The stored copy is untouched; the in-memory list is now the source of truth.
    expect(JSON.parse(store.getItem('mimic:v1:sessions')!)).toHaveLength(1);
  });

  it('returns copies, so callers cannot mutate the stored list', async () => {
    store.failAll = true;
    const h = await history();
    h.saveSession(rec('a', 1));
    h.loadSessions()[0].overall = -1;
    expect(h.loadSessions()[0].overall).not.toBe(-1);
  });

  it('builds a session record from results', async () => {
    const h = await history();
    const analysis = makeFakeAnalysis({ agility: NaN });
    const comparison = makeFakeComparison('shawn-mendes');
    comparison.overall = 68.44;
    comparison.dimensions.push({ ...comparison.dimensions[0], key: 'rasp', value: null, score: 50 });
    const profile = makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes' });
    const r = h.sessionFromResults(analysis, comparison, profile, '  Chorus take  ');
    expect(r.id).toMatch(/.+/);
    expect(Number.isFinite(Date.parse(r.createdAt))).toBe(true);
    expect(r.profileId).toBe('shawn-mendes');
    expect(r.profileName).toBe('Shawn Mendes');
    expect(r.overall).toBe(68.4);
    expect(r.dimensionScores).toEqual({ breathiness: 84, mixInUpperRange: 55 });
    expect(r.style.breathiness).toBe(FAKE_STYLE.breathiness);
    expect(r.style.agility).toBeNull();
    expect(r.durationSec).toBe(12);
    expect(r.label).toBe('Chorus take');
    expect(h.sessionFromResults(analysis, comparison, profile).label).toBeUndefined();
    expect(h.sessionFromResults(analysis, comparison, profile).id).not.toBe(r.id);
    // Round-trips through storage unchanged.
    h.saveSession(r);
    expect(h.loadSessions()[0]).toEqual(r);
  });

  it('makes ids without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', {});
    const h = await history();
    const a = h.sessionFromResults(makeFakeAnalysis(), makeFakeComparison(), makeFakeProfile());
    const b = h.sessionFromResults(makeFakeAnalysis(), makeFakeComparison(), makeFakeProfile());
    expect(a.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(a.id).not.toBe(b.id);
  });
});

describe('settings', () => {
  it('has the documented defaults', async () => {
    const s = await settings();
    expect(s.DEFAULT_SETTINGS).toEqual({ voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' });
    expect(s.loadSettings()).toEqual(s.DEFAULT_SETTINGS);
    expect(s.loadSettings()).not.toBe(s.DEFAULT_SETTINGS);
  });

  it('saves and loads', async () => {
    const s = await settings();
    s.saveSettings({ voiceType: 'tenor', a4Hz: 442, anthropicApiKey: ' sk-test ', aiModel: 'claude-opus-5' });
    expect(s.loadSettings()).toEqual({ voiceType: 'tenor', a4Hz: 442, anthropicApiKey: 'sk-test', aiModel: 'claude-opus-5' });
    expect(JSON.parse(store.getItem('mimic:v1:settings')!).voiceType).toBe('tenor');
  });

  it('validates each field on its own and ignores corrupt JSON', async () => {
    const s = await settings();
    store.setItem('mimic:v1:settings', JSON.stringify({ voiceType: 'countertenor', a4Hz: 432.5 + 100, anthropicApiKey: 12, aiModel: '' }));
    expect(s.loadSettings()).toEqual(s.DEFAULT_SETTINGS);
    store.setItem('mimic:v1:settings', JSON.stringify({ voiceType: 'mezzo', a4Hz: 'x' }));
    expect(s.loadSettings()).toEqual({ ...s.DEFAULT_SETTINGS, voiceType: 'mezzo' });
    store.setItem('mimic:v1:settings', '][');
    expect(s.loadSettings()).toEqual(s.DEFAULT_SETTINGS);
    store.setItem('mimic:v1:settings', 'null');
    expect(s.loadSettings()).toEqual(s.DEFAULT_SETTINGS);
  });

  it('keeps settings in memory when storage is unavailable', async () => {
    store.failAll = true;
    const s = await settings();
    expect(s.loadSettings()).toEqual(s.DEFAULT_SETTINGS);
    s.saveSettings({ ...s.DEFAULT_SETTINGS, voiceType: 'soprano' });
    expect(s.loadSettings().voiceType).toBe('soprano');
  });

  it('keeps settings in memory when a write fails', async () => {
    const s = await settings();
    store.failWrites = true;
    s.saveSettings({ ...s.DEFAULT_SETTINGS, a4Hz: 441 });
    expect(s.loadSettings().a4Hz).toBe(441);
  });

  it('DEFAULT_SETTINGS cannot be mutated by accident', async () => {
    const s = await settings();
    expect(Object.isFrozen(s.DEFAULT_SETTINGS)).toBe(true);
  });
});
