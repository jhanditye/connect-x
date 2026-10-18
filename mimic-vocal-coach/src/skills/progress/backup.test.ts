import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKILLS_STORE_KEY } from '../types';
import { breathSession, earSession, FakeStorage, sequenceSession, singSession } from './testKit';

let storage: FakeStorage;
async function mods() {
  const progress = await import('./index');
  const library = await import('../../storage/library');
  return { ...progress, ...library };
}

beforeEach(() => {
  vi.resetModules();
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function seeded() {
  const m = await mods();
  let s = m.updateSkillsPrefs(m.emptySkillsStore(), { strictness: 'strict', labelMode: 'solfege' });
  s = m.recordSkillsSession(s, earSession([{ semitones: 7, correct: true }, { semitones: 9, direction: 'down', correct: false }], 1, 'e1'));
  s = m.recordSkillsSession(s, singSession([{ semitones: 9, intervalCents: 25 }], 2, 's1'));
  s = m.recordSkillsSession(s, sequenceSession([{ degree: 7, cents: -30 }, { degree: 4, cents: 12 }], 0.5, 3, 'q1'));
  s = m.recordSkillsSession(s, breathSession({ hissSec: 22, longToneSec: 15 }, 4, 'b1'));
  m.saveSkillsStore(s);
  return { m, s };
}

describe('exportSkillsForBackup / importSkillsFromBackup', () => {
  it('exports nothing for an empty store (preferences alone do not count)', async () => {
    const m = await mods();
    expect(m.exportSkillsForBackup()).toBeNull();
    m.saveSkillsStore(m.updateSkillsPrefs(m.emptySkillsStore(), { strictness: 'gentle' }));
    expect(m.exportSkillsForBackup()).toBeNull();
  });

  it('round trip: export, delete everything, import gives back the same store', async () => {
    const { m, s } = await seeded();
    const exported = JSON.parse(JSON.stringify(m.exportSkillsForBackup()));
    expect(exported.sessions).toHaveLength(4);
    m.clearSkillsStore();
    expect(m.loadSkillsStore().sessions).toEqual([]);
    expect(m.importSkillsFromBackup(exported)).toEqual({ added: 4, skipped: 0 });
    const back = m.loadSkillsStore();
    expect(back.sessions).toEqual(s.sessions);
    expect(back.stats).toEqual(s.stats);
    expect(back.bests).toEqual(s.bests);
    // A fresh device takes the backup's preferences.
    expect(back.prefs).toEqual(s.prefs);
    // Importing the same file again changes nothing.
    expect(m.importSkillsFromBackup(exported)).toEqual({ added: 0, skipped: 4 });
    expect(m.loadSkillsStore()).toBe(back);
  });

  it('merges by session id with what is on the device, rebuilding stats in time order and keeping local preferences', async () => {
    const { m } = await seeded();
    const exported = JSON.parse(JSON.stringify(m.exportSkillsForBackup()));
    // The device has moved on: one older session from the backup is gone, a new one added, preferences changed.
    let local = m.emptySkillsStore();
    local = m.updateSkillsPrefs(local, { strictness: 'gentle' });
    local = m.recordSkillsSession(local, earSession([{ semitones: 7, correct: false }], 0, 'e0'));
    local = m.recordSkillsSession(local, breathSession({ hissSec: 30 }, 10, 'b2'));
    m.saveSkillsStore(local);
    expect(m.importSkillsFromBackup(exported)).toEqual({ added: 4, skipped: 0 });
    const merged = m.loadSkillsStore();
    expect(merged.sessions.map((x) => x.id)).toEqual(['e0', 'e1', 's1', 'q1', 'b1', 'b2']);
    expect(merged.stats).toEqual(m.rebuildStats(merged.sessions).stats);
    expect(merged.stats.hear['7u']).toMatchObject({ n: 2, ema: 0.5 });
    expect(merged.bests.hissSec?.value).toBe(30);
    expect(merged.bests.longToneSec?.value).toBe(15);
    expect(merged.prefs.strictness).toBe('gentle');
  });

  it('keeps the larger count when the device has history older than its sessions (cap)', async () => {
    const m = await mods();
    const local = { ...m.emptySkillsStore(), stats: { ...m.emptySkillsStats(), hear: { '7u': { n: 900, ema: 0.8, lastAt: new Date(2026, 0, 1).toISOString() } } } };
    const r = m.mergeSkillsStores(local, { sessions: [earSession([{ semitones: 7, correct: true }], 0, 'x')] });
    expect(r.added).toBe(1);
    expect(r.store.stats.hear['7u']?.n).toBe(900);
  });

  it('skips a newer store version whole, ignores garbage and never throws', async () => {
    const { m, s } = await seeded();
    expect(m.importSkillsFromBackup({ version: 2, sessions: [earSession([{ semitones: 5, correct: true }], 9, 'new')] })).toEqual({ added: 0, skipped: 1 });
    for (const g of [undefined, null, 3, 'x', [], { sessions: 'no' }, { sessions: [null, {}, { kind: 'ear' }] }]) {
      expect(() => m.importSkillsFromBackup(g)).not.toThrow();
    }
    expect(m.loadSkillsStore().sessions).toEqual(s.sessions);
    expect(m.importSkillsFromBackup({ sessions: [null, {}, earSession([{ semitones: 5, correct: true }], 9, 'ok')] })).toEqual({ added: 1, skipped: 2 });
  });
});

describe('library backup file', () => {
  it('carries the Skills store and reads it back; old backups without it stay valid', async () => {
    const { m, s } = await seeded();
    const lib = m.buildLibraryExport([], [], {}, new Date('2026-10-18T12:00:00Z'), m.exportSkillsForBackup());
    const parsed = m.parseLibraryExport(JSON.parse(JSON.stringify(lib)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toEqual([]);
    expect(parsed.value.skills?.sessions).toEqual(s.sessions);
    expect(parsed.value.skills?.stats).toEqual(s.stats);

    const old = m.buildLibraryExport([], [], {});
    expect('skills' in old).toBe(false);
    expect(JSON.stringify(old)).not.toContain('skills');
    const oldParsed = m.parseLibraryExport(JSON.parse(JSON.stringify(old)));
    expect(oldParsed.ok && oldParsed.value.skills).toBeUndefined();
  });

  it('warns about unreadable or newer Skills data instead of failing the whole import', async () => {
    const m = await mods();
    const base = JSON.parse(JSON.stringify(m.buildLibraryExport([], [], {})));
    const newer = m.parseLibraryExport({ ...base, skills: { version: 2, sessions: [] } });
    expect(newer.ok && newer.value.skills).toBeUndefined();
    expect(newer.ok && newer.warnings.join(' ')).toMatch(/newer version of Mimic.*skipped/);
    const bad = m.parseLibraryExport({ ...base, skills: { version: 1, sessions: [{}, earSession([{ semitones: 7, correct: true }], 0, 'e')] } });
    expect(bad.ok && bad.value.skills?.sessions).toHaveLength(1);
    expect(bad.ok && bad.warnings).toEqual(['1 Skills session could not be read and was skipped.']);
    const junk = m.parseLibraryExport({ ...base, skills: 'junk' });
    expect(junk.ok && junk.warnings.join(' ')).toMatch(/could not be read and was skipped/);
  });

  it('is removed by "Delete everything" (all mimic: keys) and the in-memory copy is emptied by clearSkillsStore', async () => {
    const { m } = await seeded();
    const { removeAllAppKeys } = await import('../../storage/local');
    expect(storage.getItem(SKILLS_STORE_KEY)).not.toBeNull();
    removeAllAppKeys();
    expect(storage.getItem(SKILLS_STORE_KEY)).toBeNull();
    expect(m.loadSkillsStore().sessions).toEqual([]);
  });
});
