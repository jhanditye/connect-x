// Skills data in the library backup (LibraryExport.skills, optional so older backups stay valid). Export is a plain
// copy of the store; import merges sessions by id, rebuilds the moving stats in time order and keeps the best of the
// personal bests (src/skills/SPEC.md section 5).

import { isRecord } from '../../storage/local';
import { MAX_SKILLS_SESSIONS, SKILLS_STORE_VERSION, type SkillsStats, type SkillsStore } from '../types';
import { sortSessions } from './parse';
import { isSkillsStoreEmpty, loadSkillsStore, parseSkillsStore, saveSkillsStore } from './store';
import { mergeBests, rebuildStats } from './stats';

/** A copy of the Skills store for the backup file, or null when there is nothing in it worth keeping. */
export function exportSkillsForBackup(): SkillsStore | null {
  const s = loadSkillsStore();
  return isSkillsStoreEmpty(s) ? null : (JSON.parse(JSON.stringify(s)) as SkillsStore);
}

/** Moving stats rebuilt from the merged sessions, with each count at least what either side had (the cap may have dropped old sessions). */
function mergeStats(rebuilt: SkillsStats, a: SkillsStats, b: SkillsStats): SkillsStats {
  const out: SkillsStats = { hear: { ...rebuilt.hear }, sing: { ...rebuilt.sing }, hearDegree: { ...rebuilt.hearDegree }, degrees: { ...rebuilt.degrees }, registers: { ...rebuilt.registers } };
  for (const field of ['hear', 'sing', 'hearDegree', 'degrees', 'registers'] as const) {
    const target = out[field] as Record<string, { n: number }>;
    for (const src of [a[field], b[field]] as Record<string, { n: number } | undefined>[]) {
      for (const [k, v] of Object.entries(src)) {
        if (!v) continue;
        const cur = target[k];
        if (!cur) target[k] = { ...v };
        else if (v.n > cur.n) target[k] = { ...cur, n: v.n };
      }
    }
  }
  return out;
}

/**
 * Merges an incoming store into a local one (pure). Sessions are matched by id (the local copy wins), sorted oldest
 * first and capped; stats are rebuilt in time order; bests are the better of the two sides and the rebuild. The local
 * preferences are kept unless the local store was empty (a fresh device restoring a backup).
 * `added` = incoming sessions now in the store; `skipped` = incoming sessions already there, unreadable or past the cap.
 */
export function mergeSkillsStores(local: SkillsStore, incomingRaw: unknown): { store: SkillsStore; added: number; skipped: number } {
  const rawCount = isRecord(incomingRaw) && Array.isArray(incomingRaw.sessions) ? incomingRaw.sessions.length : 0;
  const incoming = parseSkillsStore(incomingRaw);
  const known = new Set(local.sessions.map((s) => s.id));
  const fresh = incoming.sessions.filter((s) => !known.has(s.id));
  if (fresh.length === 0) {
    // Nothing new to replay: only bests and counts can come across. Unchanged -> the same object (no save needed).
    const candidate: SkillsStore = { ...local, stats: mergeStats(local.stats, local.stats, incoming.stats), bests: mergeBests(local.bests, incoming.bests) };
    const same = JSON.stringify(candidate.stats) === JSON.stringify(local.stats) && JSON.stringify(candidate.bests) === JSON.stringify(local.bests);
    return { store: same ? local : candidate, added: 0, skipped: rawCount };
  }
  let sessions = sortSessions([...local.sessions, ...fresh]);
  if (sessions.length > MAX_SKILLS_SESSIONS) sessions = sessions.slice(sessions.length - MAX_SKILLS_SESSIONS);
  const kept = new Set(sessions.map((s) => s.id));
  const added = fresh.filter((s) => kept.has(s.id)).length;
  const rebuilt = rebuildStats(sessions);
  const store: SkillsStore = {
    version: SKILLS_STORE_VERSION,
    sessions,
    stats: mergeStats(rebuilt.stats, local.stats, incoming.stats),
    bests: mergeBests(mergeBests(local.bests, incoming.bests), rebuilt.bests),
    prefs: isSkillsStoreEmpty(local) ? incoming.prefs : local.prefs,
  };
  return { store, added, skipped: Math.max(0, rawCount - added) };
}

/**
 * Brings the `skills` part of a backup into this device's store and saves it. Nothing happens for a backup without
 * one; one written by a newer version of the store is skipped whole rather than guessed at.
 */
export function importSkillsFromBackup(raw: unknown): { added: number; skipped: number } {
  if (raw === undefined || raw === null) return { added: 0, skipped: 0 };
  const rawCount = isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions.length : 0;
  if (!isRecord(raw) || (typeof raw.version === 'number' && raw.version > SKILLS_STORE_VERSION)) return { added: 0, skipped: rawCount };
  const local = loadSkillsStore();
  const r = mergeSkillsStores(local, raw);
  if (r.store !== local) saveSkillsStore(r.store);
  return { added: r.added, skipped: r.skipped };
}
