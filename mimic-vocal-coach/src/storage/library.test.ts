import { describe, expect, it } from 'vitest';
import { clipFromAnalysis } from '../coach/measured';
import { makeFakeAttempts, makeFakeClip, FAKE_CLIP_ID, FAKE_NOW } from '../testing/trainerFixtures';
import { makeFakeAnalysis } from '../testing/fixtures';
import type { AttemptRecord, ClipRecord, PhraseRecord } from '../types';
import { createMemoryClipStore } from './clips';
import {
  applyAttempt,
  attemptLite,
  buildLibraryExport,
  contributionBlocker,
  exportFileName,
  exportReminder,
  findRelinkCandidates,
  inspectClipRecord,
  isGoodKeyEvidence,
  LIBRARY_FORMAT,
  LIBRARY_VERSION,
  measuredFromClip,
  mergeLibrary,
  migrateRecord,
  parseAttemptRecord,
  parseClipRecord,
  parseLibraryExport,
  parseLibraryText,
  rebuildPhraseState,
  REMIND_AFTER_ATTEMPTS,
  selectNewAttempts,
} from './library';

const clip = (over: Partial<ClipRecord> = {}): ClipRecord => makeFakeClip(over);
const attempts = (): AttemptRecord[] => makeFakeAttempts();
const blankPhrase = (p: PhraseRecord): PhraseRecord => ({
  ...p,
  keyHint: null,
  srs: { rung: 0, dueAt: null, masteredAt: null },
  stats: { attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null },
});
/** A JSON round trip, the way a record reaches the parser from a file or IndexedDB. */
const viaJson = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));

describe('export', () => {
  it('builds a versioned export from clips, attempts and calibration', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const lib = buildLibraryExport([clip()], attempts(), { wired: 90 }, now);
    expect(lib).toMatchObject({ format: LIBRARY_FORMAT, version: LIBRARY_VERSION, exportedAt: '2026-10-08T12:00:00.000Z', calibration: { wired: 90 } });
    expect(lib.clips).toHaveLength(1);
    expect(lib.attempts.length).toBeGreaterThan(20);
  });

  it('never carries audio: attempts do not claim a recording and nothing binary is written', () => {
    const withAudio = attempts().map((a) => ({ ...a, hasAudio: true }));
    const lib = buildLibraryExport([clip()], withAudio, {});
    expect(lib.attempts.every((a) => a.hasAudio === false)).toBe(true);
    const json = JSON.stringify(lib);
    expect(json).not.toMatch(/"pcm"|ArrayBuffer|Int16Array/);
    expect(json.length).toBeLessThan(200_000);
  });

  it('copies: changing the export does not change the library', () => {
    const c = clip();
    const lib = buildLibraryExport([c], [], {});
    lib.clips[0].title = 'changed';
    lib.clips[0].phrases[0].label = 'changed';
    expect(c.title).not.toBe('changed');
    expect(c.phrases[0].label).not.toBe('changed');
  });

  it('drops calibration entries that are not numbers', () => {
    const lib = buildLibraryExport([], [], { wired: 90, bad: NaN, worse: 'x' as unknown as number, inf: Infinity });
    expect(lib.calibration).toEqual({ wired: 90 });
  });

  it('names the file after the date', () => {
    expect(exportFileName(new Date('2026-10-08T23:59:00Z'))).toBe('mimic-library-2026-10-08.json');
  });
});

describe('parseClipRecord', () => {
  it('reads back what a clip looked like when it was stored', () => {
    const c = clip();
    expect(parseClipRecord(viaJson(c))).toEqual(c);
  });

  it('refuses things that are not clips', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { id: '' }]) expect(parseClipRecord(bad)).toBeNull();
    const base = viaJson(clip()) as Record<string, unknown>;
    for (const key of ['id', 'durationSec', 'audio', 'analysis']) {
      const broken = { ...base };
      delete broken[key];
      expect(parseClipRecord(broken)).toBeNull();
    }
    expect(parseClipRecord({ ...base, durationSec: -1 })).toBeNull();
    expect(parseClipRecord({ ...base, durationSec: 'long' })).toBeNull();
    expect(parseClipRecord({ ...base, audio: { mix: { sampleRate: 44100, frames: 10 } } })).toBeNull();
    expect(parseClipRecord({ ...base, audio: { mix: { sampleRate: 5, frames: 10, chunkFrames: 50 } } })).toBeNull();
    expect(parseClipRecord({ ...base, schema: 'one' })).toBeNull();
  });

  it('refuses, and names, a record from a newer version instead of half-reading it', () => {
    const r = inspectClipRecord({ ...(viaJson(clip()) as object), schema: 2, title: 'From the future' });
    expect(r).toEqual({ ok: false, reason: 'newer', title: 'From the future' });
    expect(parseClipRecord({ ...(viaJson(clip()) as object), schema: 2 })).toBeNull();
  });

  it('accepts a record with no schema field as version 1', () => {
    const raw = viaJson(clip()) as Record<string, unknown>;
    delete raw.schema;
    expect(parseClipRecord(raw)?.schema).toBe(1);
  });

  it('fills defaults for optional fields and normalises odd values', () => {
    const base = viaJson(clip()) as Record<string, unknown>;
    const p = parseClipRecord({
      id: base.id,
      durationSec: 30,
      audio: base.audio,
      analysis: { style: { breathiness: 'airy', rasp: 0.3 }, issues: ['noisy', 'bogus', 'noisy'], usableAsTarget: 'yes' },
      title: '   ',
      kind: 'weird',
      tags: ['a', 'a', ' b ', '', 5],
      difficulty: 7,
    }) as ClipRecord;
    expect(p.title).toBe('Untitled clip');
    expect(p.kind).toBe('solo');
    expect(p.analysisKind).toBe('solo');
    expect(p.tags).toEqual(['a', 'b']);
    expect(p.difficulty).toBeNull();
    expect(p.analysis.issues).toEqual(['noisy']);
    expect(p.analysis.usableAsTarget).toBe(false);
    expect(p.analysis.style.breathiness).toBeNull();
    expect(p.analysis.style.rasp).toBe(0.3);
    expect(p.analysis.voiceType).toBe('tenor');
    expect(p.analysis.a4Hz).toBe(440);
    expect(p.audioMissing).toBe(false);
    expect(p.phrases).toEqual([]);
    expect(p.singerId).toBeNull();
    expect(Number.isFinite(Date.parse(p.addedAt))).toBe(true);
    expect(p.updatedAt).toBe(p.addedAt);
    expect(p.ownedConfirmedAt).toBe(p.addedAt);
  });

  it('a mix gets the mix-melody analysis kind by default', () => {
    const raw = { ...(viaJson(clip({ kind: 'mix' })) as Record<string, unknown>) };
    delete raw.analysisKind;
    expect(parseClipRecord(raw)?.analysisKind).toBe('mix-melody');
  });

  it('cleans the phrase list: bad entries and repeated ids dropped, sorted, renumbered, kept inside the clip', () => {
    const raw = viaJson(clip({ durationSec: 20 })) as { phrases: Record<string, unknown>[] };
    const ph = raw.phrases;
    raw.phrases = [
      { ...ph[2], id: 'late', start: 12, end: 99 },
      { ...ph[0], id: 'first', start: -3, end: 5, rate: 9, voicedStart: -1, voicedEnd: 500 },
      { ...ph[1], id: 'first' },
      { ...ph[1], id: 'backwards', start: 8, end: 7 },
      { ...ph[1], id: 'beyond', start: 50, end: 60 },
      { id: 'nope' },
      'junk',
      { ...ph[3], id: 'mid', start: 6, end: 11, srs: { rung: 0, dueAt: 123, masteredAt: null }, stats: { attempts: 'many', recent: [1, 'x', 2, 3, 4, 5, 6] } },
    ] as Record<string, unknown>[];
    const p = parseClipRecord(raw) as ClipRecord;
    expect(p.phrases.map((x) => x.id)).toEqual(['first', 'mid', 'late']);
    expect(p.phrases.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(p.phrases[0]).toMatchObject({ start: 0, end: 5, rate: 1, voicedStart: 0, voicedEnd: 5 });
    expect(p.phrases[2].end).toBe(20);
    expect(p.phrases[1].srs).toEqual({ rung: 0, dueAt: null, masteredAt: null });
    expect(p.phrases[1].stats.attempts).toBe(0);
    expect(p.phrases[1].stats.recent).toEqual([2, 3, 4, 5, 6]);
  });

  it('does not let a hostile object change how later records parse', () => {
    const raw = JSON.parse('{"__proto__": {"id": "x"}, "constructor": {"prototype": {"polluted": true}}}');
    expect(parseClipRecord(raw)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('schema migrations', () => {
  it('runs one step per version, in order', () => {
    const steps = {
      1: (r: Record<string, unknown>) => ({ ...r, trail: [...((r.trail as string[]) ?? []), 'one->two'] }),
      2: (r: Record<string, unknown>) => ({ ...r, trail: [...((r.trail as string[]) ?? []), 'two->three'] }),
    };
    expect(migrateRecord({ a: 1 }, 1, 3, steps)).toEqual({ a: 1, trail: ['one->two', 'two->three'] });
    expect(migrateRecord({ a: 1 }, 2, 3, steps)).toEqual({ a: 1, trail: ['two->three'] });
    expect(migrateRecord({ a: 1 }, 3, 3, steps)).toEqual({ a: 1 });
  });

  it('refuses to guess when a step is missing', () => {
    expect(() => migrateRecord({}, 1, 3, { 1: (r) => r })).toThrow(/No migration from version 2 to 3/);
  });

  it('brings an older clip record up to the current schema before reading it, and never reads a newer one', () => {
    const raw = { ...(viaJson(clip()) as Record<string, unknown>), schema: 1, legacyTitle: 'Old name' } as Record<string, unknown>;
    delete raw.title;
    const steps = { 1: (r: Record<string, unknown>) => ({ ...r, schema: 2, title: r.legacyTitle }) };
    const upgraded = inspectClipRecord(raw, steps, 2);
    expect(upgraded.ok && upgraded.clip.title).toBe('Old name');
    expect(upgraded.ok && upgraded.clip.schema).toBe(2);
    expect(inspectClipRecord({ ...raw, schema: 3 }, steps, 2)).toMatchObject({ ok: false, reason: 'newer' });
    expect(inspectClipRecord(raw, {}, 2)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('parseAttemptRecord', () => {
  it('reads back a stored attempt', () => {
    for (const a of attempts()) expect(parseAttemptRecord(viaJson(a))).toEqual(a);
  });

  it('refuses attempts without the fields the history needs', () => {
    const a = viaJson(attempts()[0]) as Record<string, unknown>;
    for (const key of ['id', 'clipId', 'phraseId', 'at', 'scores']) {
      const broken = { ...a };
      delete broken[key];
      expect(parseAttemptRecord(broken)).toBeNull();
    }
    expect(parseAttemptRecord({ ...a, scores: { overall: 'high', pitch: 90 } })).toBeNull();
    expect(parseAttemptRecord({ ...a, at: Infinity })).toBeNull();
    expect(parseAttemptRecord(null)).toBeNull();
  });

  it('clamps scores and counts and defaults the rest', () => {
    const a = parseAttemptRecord({ id: 'a', clipId: 'c', phraseId: 'p', at: 5, scores: { overall: 250, pitch: -4, timing: 'x' }, coverage: 3, rate: 40, wrongNotes: -2, trust: 'maybe', mode: 'x', notes: [{ i: 0, refName: 'G3' }, { nope: 1 }], tone: [{ key: 'rasp', diff: 0.2 }, { key: 3 }] }) as AttemptRecord;
    expect(a.scores).toEqual({ overall: 100, pitch: 0, timing: null, tone: null, expression: null });
    expect(a).toMatchObject({ coverage: 1, rate: 2, wrongNotes: 0, trust: 'ok', mode: 'sing-along', keyMode: 'free', route: 'unknown', hasAudio: false });
    expect(a.notes).toHaveLength(1);
    expect(a.tone).toEqual([{ key: 'rasp', diff: 0.2 }]);
  });

  it('drops the recording flag when asked (nothing travels with a backup)', () => {
    const raw = viaJson({ ...attempts()[0], hasAudio: true });
    expect(parseAttemptRecord(raw)?.hasAudio).toBe(true);
    expect(parseAttemptRecord(raw, { dropAudio: true })?.hasAudio).toBe(false);
  });
});

describe('parseLibraryExport', () => {
  const lib = () => viaJson(buildLibraryExport([clip()], attempts(), { wired: 90 }));

  it('round trips a library with no warnings', () => {
    const r = parseLibraryExport(lib());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.value.clips).toEqual([clip()]);
    expect(r.value.attempts).toEqual(attempts());
    expect(r.value.calibration).toEqual({ wired: 90 });
  });

  it('refuses what is not a Mimic backup, in words that say what to do', () => {
    for (const bad of [null, 5, 'text', [], {}, { format: 'other', version: 1 }]) {
      const r = parseLibraryExport(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not a Mimic library backup/);
    }
  });

  it('refuses a backup from a newer app and names the fix', () => {
    const r = parseLibraryExport({ ...(lib() as object), version: 2 });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/newer version of Mimic.*Update the app/) });
    for (const v of [undefined, 'one', 0, 1.5]) {
      expect(parseLibraryExport({ ...(lib() as object), version: v }).ok).toBe(false);
    }
  });

  it('skips unreadable clips and attempts and says how many', () => {
    const raw = lib() as { clips: unknown[]; attempts: unknown[] };
    raw.clips.push({ id: 'broken', title: 'Broken clip' }, 'junk', { ...(viaJson(clip({ id: 'future' })) as object), schema: 9, title: 'From the future' });
    raw.attempts.push({ id: 'bad' }, { ...(viaJson(attempts()[0]) as object), id: 'orphan', clipId: 'not-in-file' });
    const r = parseLibraryExport(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.clips).toHaveLength(1);
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings.join('\n')).toMatch(/2 clips could not be read.*"Broken clip"/);
    expect(r.warnings.join('\n')).toMatch(/1 clip was saved by a newer version of Mimic and skipped: "From the future"/);
    expect(r.warnings.join('\n')).toMatch(/1 practice attempt could not be read/);
    expect(r.warnings.join('\n')).toMatch(/1 practice attempt belonged to clips that are not in the file/);
  });

  it('keeps the most recently edited copy of a clip that appears twice, and each attempt once', () => {
    const raw = lib() as { clips: Record<string, unknown>[]; attempts: unknown[] };
    raw.clips.push({ ...raw.clips[0], title: 'Edited later', updatedAt: '2026-10-09T00:00:00.000Z' }, { ...raw.clips[0], title: 'Edited earlier', updatedAt: '2026-01-01T00:00:00.000Z' });
    raw.attempts.push(...raw.attempts.slice(0, 3));
    const r = parseLibraryExport(raw);
    if (!r.ok) throw new Error('should parse');
    expect(r.value.clips.map((c) => c.title)).toEqual(['Edited later']);
    expect(r.value.attempts).toHaveLength(attempts().length);
    expect(r.warnings.join('\n')).toMatch(/2 clips appeared more than once/);
  });

  it('treats missing lists as empty and ignores a bad exportedAt', () => {
    const r = parseLibraryExport({ format: LIBRARY_FORMAT, version: 1, exportedAt: 'yesterday' });
    expect(r.ok && r.value.clips).toEqual([]);
    expect(r.ok && Number.isFinite(Date.parse(r.value.exportedAt))).toBe(true);
  });

  it('refuses a file that is far too big to be a library', () => {
    const r = parseLibraryExport({ format: LIBRARY_FORMAT, version: 1, clips: new Array(2001).fill(null) });
    expect(r.ok).toBe(false);
  });

  it('parses text, and says so when the file is not JSON', () => {
    expect(parseLibraryText(JSON.stringify(lib())).ok).toBe(true);
    const r = parseLibraryText('{"format": "mimic-lib');
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/not readable JSON/) });
    expect(parseLibraryText('').ok).toBe(false);
  });
});

describe('mergeLibrary', () => {
  const older = '2026-01-01T00:00:00.000Z';
  const newer = '2026-06-01T00:00:00.000Z';

  it('adds clips that are new here as audio-missing, whatever the file said', () => {
    const r = mergeLibrary([], [clip({ id: 'a', audioMissing: false })]);
    expect(r).toMatchObject({ added: 1, updated: 0, kept: 0 });
    expect(r.clips[0].audioMissing).toBe(true);
  });

  it('lets the newer edit win but keeps the audio that is on this device', () => {
    const local = clip({ id: 'a', title: 'Local', updatedAt: older, audioMissing: false });
    const incoming = clip({ id: 'a', title: 'Edited elsewhere', updatedAt: newer, audioMissing: true, audio: { mix: { kind: 'mix', sampleRate: 22050, frames: 5, chunkFrames: 220500 }, vocal: null } });
    const r = mergeLibrary([local], [incoming]);
    expect(r).toMatchObject({ added: 0, updated: 1, kept: 0 });
    expect(r.clips[0].title).toBe('Edited elsewhere');
    expect(r.clips[0].audioMissing).toBe(false);
    expect(r.clips[0].audio).toEqual(local.audio);
  });

  it('keeps what is here when it is newer, or the same age', () => {
    const local = clip({ id: 'a', title: 'Local', updatedAt: newer });
    expect(mergeLibrary([local], [clip({ id: 'a', title: 'Old', updatedAt: older })])).toMatchObject({ kept: 1, updated: 0 });
    const tie = mergeLibrary([local], [clip({ id: 'a', title: 'Same age', updatedAt: newer })]);
    expect(tie.kept).toBe(1);
    expect(tie.clips[0].title).toBe('Local');
  });

  it('importing the same backup twice changes nothing the second time', () => {
    const incoming = [clip({ id: 'a' }), clip({ id: 'b' })];
    const once = mergeLibrary([], incoming);
    const twice = mergeLibrary(once.clips, incoming);
    expect(twice).toMatchObject({ added: 0, updated: 0, kept: 2 });
    expect(twice.clips).toEqual(once.clips);
  });

  it('does not change its inputs and lists newest first', () => {
    const local = [clip({ id: 'a', addedAt: older })];
    const snapshot = JSON.stringify(local);
    const r = mergeLibrary(local, [clip({ id: 'b', addedAt: newer })]);
    expect(JSON.stringify(local)).toBe(snapshot);
    expect(r.clips.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('selectNewAttempts', () => {
  it('takes only unknown attempts of phrases that still exist', () => {
    const c = clip();
    const all = attempts();
    const known = new Set(all.slice(0, 5).map((a) => a.id));
    const orphan = { ...all[0], id: 'orphan', phraseId: 'gone' };
    const r = selectNewAttempts([c], known, [...all, orphan, { ...all[0], id: 'elsewhere', clipId: 'other' }]);
    expect(r.attempts).toHaveLength(all.length - 5);
    expect(r.skippedOrphans).toBe(2);
    expect(r.attempts.every((a) => a.hasAudio === false)).toBe(true);
  });
});

describe('findRelinkCandidates', () => {
  const missing = (over: Partial<ClipRecord>) => clip({ audioMissing: true, ...over });

  it('matches an exact fingerprint first', () => {
    const a = missing({ id: 'a', fingerprint: '100:61200:aaaaaaaaaaaaaaaa', sourceFileName: 'other.m4a' });
    const b = missing({ id: 'b', fingerprint: '100:61200:bbbbbbbbbbbbbbbb', sourceFileName: 'song.m4a' });
    const r = findRelinkCandidates([b, a], { fingerprint: '100:61200:aaaaaaaaaaaaaaaa', fileName: 'song.m4a', durationSec: 61.2 });
    expect(r.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('sees through the excerpt offset of a clip that kept only part of its file', () => {
    const a = missing({ id: 'a', fingerprint: '100:61200:aaaaaaaaaaaaaaaa@8500', durationSec: 20 });
    expect(findRelinkCandidates([a], { fingerprint: '100:61200:aaaaaaaaaaaaaaaa' }).map((c) => c.id)).toEqual(['a']);
    expect(findRelinkCandidates([a], { fingerprint: '100:61200:bbbbbbbbbbbbbbbb' })).toEqual([]);
    const byName = missing({ id: 'n', fingerprint: '100:61200:aaaaaaaaaaaaaaaa@8500', sourceFileName: 'song.m4a', durationSec: 20 });
    expect(findRelinkCandidates([byName], { fingerprint: 'x', fileName: 'song.m4a', durationSec: 61.3 })).toHaveLength(1);
  });

  it('falls back to file name and a duration within 0.3 s of the source duration', () => {
    const a = missing({ id: 'a', fingerprint: '100:61200:aaaaaaaaaaaaaaaa', sourceFileName: 'Song.M4A', durationSec: 20 });
    expect(findRelinkCandidates([a], { fingerprint: 'x', fileName: 'song.mp3', durationSec: 61.4 }).map((c) => c.id)).toEqual(['a']);
    expect(findRelinkCandidates([a], { fingerprint: 'x', fileName: 'song.m4a', durationSec: 61.6 })).toEqual([]);
    expect(findRelinkCandidates([a], { fingerprint: 'x', fileName: 'different.m4a', durationSec: 61.2 })).toEqual([]);
    expect(findRelinkCandidates([a], { fingerprint: 'x', fileName: 'song.m4a' })).toEqual([]);
  });

  it('uses the stored duration when the fingerprint cannot be read', () => {
    const a = missing({ id: 'a', fingerprint: '', sourceFileName: 'song.m4a', durationSec: 30 });
    expect(findRelinkCandidates([a], { fingerprint: 'x', fileName: 'song.m4a', durationSec: 30.1 })).toHaveLength(1);
  });

  it('offers only clips without audio, unless asked for duplicates', () => {
    const present = clip({ id: 'p', audioMissing: false, fingerprint: '1:2:cccccccccccccccc' });
    expect(findRelinkCandidates([present], { fingerprint: '1:2:cccccccccccccccc' })).toEqual([]);
    expect(findRelinkCandidates([present], { fingerprint: '1:2:cccccccccccccccc' }, { includeWithAudio: true })).toHaveLength(1);
  });
});

describe('contribution to a singer\'s targets', () => {
  it('produces exactly what clipFromAnalysis produces for the same analysis', () => {
    const analysis = makeFakeAnalysis();
    const c = clip({
      id: 'c9',
      title: 'Stitches vocal',
      addedAt: '2026-09-26T10:00:00.000Z',
      analysis: {
        analysisVersion: 1,
        voiceType: 'tenor',
        a4Hz: 440,
        durationSec: analysis.durationSec,
        voicedSec: analysis.voicedSec,
        style: { ...analysis.style },
        pitch: { medianMidi: analysis.pitch.medianMidi, lowMidi: analysis.pitch.lowMidi, highMidi: analysis.pitch.highMidi, tessituraLowMidi: analysis.pitch.tessituraLowMidi, tessituraHighMidi: analysis.pitch.tessituraHighMidi },
        issues: [],
        usableAsTarget: true,
        unusableReason: null,
      },
    });
    expect(measuredFromClip(c)).toEqual(clipFromAnalysis(analysis, c.title, c.id, c.addedAt));
  });

  it('says why a clip cannot be used, with the next step', () => {
    expect(contributionBlocker(clip())).toBeNull();
    expect(contributionBlocker(clip({ singerId: null }))).toMatch(/Choose which singer/);
    expect(contributionBlocker(clip({ kind: 'mix' }))).toMatch(/vocal-only version/);
    const unusable = clip();
    unusable.analysis = { ...unusable.analysis, usableAsTarget: false, unusableReason: 'Too little singing (4 s).' };
    expect(contributionBlocker(unusable)).toBe('Too little singing (4 s).');
    unusable.analysis.unusableReason = null;
    expect(contributionBlocker(unusable)).toMatch(/too little clear singing/);
  });
});

describe('phrase state from attempts', () => {
  const all = attempts();
  const clipRec = clip();
  const history = (phraseId: string) => all.filter((a) => a.phraseId === phraseId);

  it('rebuilds exactly the stats, review state and key hint the fixture clip carries', () => {
    for (const p of clipRec.phrases) {
      const rebuilt = rebuildPhraseState(blankPhrase(p), history(p.id));
      expect({ id: p.id, srs: rebuilt.srs }).toEqual({ id: p.id, srs: p.srs });
      expect({ id: p.id, stats: rebuilt.stats }).toEqual({ id: p.id, stats: p.stats });
      expect({ id: p.id, keyHint: rebuilt.keyHint }).toEqual({ id: p.id, keyHint: p.keyHint });
    }
  });

  it('adding attempts one at a time ends where a full rebuild does', () => {
    for (const p of clipRec.phrases) {
      const list = history(p.id).sort((a, b) => a.at - b.at);
      let phrase = blankPhrase(p);
      list.forEach((a, i) => {
        phrase = applyAttempt(phrase, list.slice(0, i), a);
      });
      const rebuilt = rebuildPhraseState(blankPhrase(p), list);
      expect(phrase).toEqual(rebuilt);
    }
  });

  it('masters a phrase after three good full-speed attempts and schedules the first review a day later', () => {
    const p = blankPhrase(clipRec.phrases[0]);
    const good = (n: number): AttemptRecord => ({ ...all[0], id: `g${n}`, phraseId: p.id, at: FAKE_NOW + n * 60_000, rate: 1, coverage: 1, wrongNotes: 0, scores: { overall: 92, pitch: 95, timing: 90, tone: 88, expression: 90 } });
    let phrase = p;
    const done: AttemptRecord[] = [];
    for (let n = 0; n < 3; n++) {
      phrase = applyAttempt(phrase, done, good(n));
      done.push(good(n));
    }
    expect(phrase.srs.rung).toBe(1);
    expect(phrase.srs.dueAt).toBe(good(2).at + 86_400_000);
    expect(phrase.stats).toMatchObject({ attempts: 3, fullSpeedAttempts: 3, best: 92, last: 92, recent: [92, 92, 92] });
  });

  it('ignores an attempt that cannot be trusted', () => {
    const p = clipRec.phrases[4];
    const bleed: AttemptRecord = { ...all[0], id: 'bleed', phraseId: p.id, trust: 'invalid', scores: { overall: 100, pitch: 100, timing: 100, tone: 100, expression: 100 } };
    expect(applyAttempt(p, history(p.id), bleed)).toBe(p);
  });

  it('only a trusted take that matched the phrase sets the key hint', () => {
    const p = { ...blankPhrase(clipRec.phrases[0]), keyHint: -5 };
    const base: AttemptRecord = { ...all[0], phraseId: p.id, transposeSemitones: -12, trust: 'ok', coverage: 1, scores: { overall: 80, pitch: 90, timing: 80, tone: 80, expression: 80 } };
    expect(applyAttempt(p, [], base).keyHint).toBe(-12);
    expect(applyAttempt(p, [], { ...base, trust: 'caution' }).keyHint).toBe(-12);
    expect(applyAttempt(p, [], { ...base, coverage: 0.3 }).keyHint).toBe(-5);
    expect(applyAttempt(p, [], { ...base, scores: { ...base.scores, pitch: 10 } }).keyHint).toBe(-5);
    expect(isGoodKeyEvidence({ ...base, trust: 'invalid' })).toBe(false);
  });

  it('an older attempt added late counts in the totals but does not rewrite "last"', () => {
    const p = clipRec.phrases[4];
    const list = history(p.id);
    const old: AttemptRecord = { ...list[0], id: 'late-arrival', at: list[0].at - 10 * 86_400_000, scores: { ...list[0].scores, overall: 99 } };
    const after = applyAttempt(p, list, old);
    expect(after.stats.attempts).toBe(p.stats.attempts + 1);
    expect(after.stats.best).toBe(99);
    expect(after.stats.last).toBe(p.stats.last);
    expect(after.stats.lastAt).toBe(p.stats.lastAt);
    expect(after.srs).toEqual(p.srs);
  });

  it('reduces an attempt to what the review ladder needs', () => {
    expect(attemptLite(all[0])).toEqual({ at: all[0].at, overall: all[0].scores.overall, pitch: all[0].scores.pitch, timing: all[0].scores.timing, tone: all[0].scores.tone, rate: all[0].rate, coverage: all[0].coverage, wrongNotes: all[0].wrongNotes });
  });

  it('fixture clip id is used for every attempt', () => {
    expect(all.every((a) => a.clipId === FAKE_CLIP_ID)).toBe(true);
  });
});

describe('export reminder', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 8);
  const base = { clipCount: 2, attemptsSinceExport: 3, lastExportAt: new Date(now - 2 * day).toISOString(), oldestClipAt: new Date(now - 30 * day).toISOString() };

  it('stays quiet with nothing to lose or nothing new', () => {
    expect(exportReminder({ ...base, clipCount: 0 }, now).due).toBe(false);
    expect(exportReminder({ ...base, attemptsSinceExport: 0 }, now).due).toBe(false);
    expect(exportReminder(base, now)).toEqual({ due: false, message: null });
  });

  it('asks after enough new attempts', () => {
    const r = exportReminder({ ...base, attemptsSinceExport: REMIND_AFTER_ATTEMPTS }, now);
    expect(r.due).toBe(true);
    expect(r.message).toMatch(/10 practice attempts since your last backup\. Export your library/);
  });

  it('asks after a week of unsaved practice, counting from the oldest clip when never exported', () => {
    expect(exportReminder({ ...base, lastExportAt: new Date(now - 8 * day).toISOString() }, now).message).toMatch(/over a week/);
    expect(exportReminder({ ...base, lastExportAt: null }, now).due).toBe(true);
    expect(exportReminder({ ...base, lastExportAt: null, oldestClipAt: new Date(now - day).toISOString() }, now).due).toBe(false);
  });
});

describe('a library survives a trip through export, a wipe and import', () => {
  it('keeps clips, phrases and history and only asks for the audio again', async () => {
    const store = createMemoryClipStore();
    const original = clip({ contributesToSinger: true });
    const history = attempts();
    const exported = JSON.stringify(buildLibraryExport([original], history, { wired: 88 }));
    await store.clearAll();

    const parsed = parseLibraryText(exported);
    if (!parsed.ok) throw new Error(parsed.error);
    const merged = mergeLibrary([], parsed.value.clips);
    for (const c of merged.clips) await store.putClip(c);
    const picked = selectNewAttempts(merged.clips, new Set(), parsed.value.attempts);
    for (const a of picked.attempts) await store.addAttempt(a);

    const back = (await store.getClip(original.id)) as ClipRecord;
    expect(back.audioMissing).toBe(true);
    expect({ ...back, audioMissing: false }).toEqual(original);
    expect((await store.listAttempts({ clipId: original.id })).length).toBe(history.length);

    // The same file added again is recognised by its fingerprint.
    const match = findRelinkCandidates([back], { fingerprint: original.fingerprint, fileName: original.sourceFileName, durationSec: 84 });
    expect(match.map((c) => c.id)).toEqual([original.id]);
  });
});
