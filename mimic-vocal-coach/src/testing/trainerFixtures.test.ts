import { describe, expect, it } from 'vitest';
import { statusOf } from '../trainer/srs';
import {
  COMPARISON_SCENARIOS,
  FAKE_CLIP_ID,
  FAKE_NOW,
  FAKE_PHRASE_NOTES,
  FakeTrainerEngine,
  makeFakeAttempts,
  makeFakeClip,
  makeFakePhraseAnalysis,
  makeFakePhraseComparison,
  makeFakePreparedClip,
  makeFakeTrainerController,
} from './trainerFixtures';
import { buildFixes } from '../trainer/feedback';

describe('canned comparisons', () => {
  it('every scenario is internally consistent: one overall, notes match the score, flags are words', () => {
    for (const s of COMPARISON_SCENARIOS) {
      const c = makeFakePhraseComparison(s);
      expect(c.notes).toHaveLength(FAKE_PHRASE_NOTES.length);
      expect(c.score.perNote).toHaveLength(FAKE_PHRASE_NOTES.length);
      expect(c.scores.overall).toBe(c.score.overall);
      expect(c.coverage).toBe(c.score.coverage);
      for (const n of c.notes) expect(n.flags.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    }
  });

  it('the scenarios land where the design tables put them', () => {
    const by = Object.fromEntries(COMPARISON_SCENARIOS.map((s) => [s, makeFakePhraseComparison(s)]));
    expect(by.perfect.scores.overall).toBeGreaterThanOrEqual(97);
    expect(by.flat.notes.filter((n) => n.flags.includes('flat'))).toHaveLength(2);
    expect(by.late.notes.filter((n) => n.flags.includes('late')).length).toBeGreaterThanOrEqual(3);
    expect(by.late.scores.timing).toBeLessThan(by.late.scores.pitch);
    expect(by['wrong-note'].notes[2].flags).toContain('wrong-note');
    expect(by['wrong-note'].notes[3].flags).toContain('merged');
    expect(by.partial.coverage).toBeCloseTo(0.52, 2);
    expect(by.partial.notes.filter((n) => n.flags.includes('missed'))).toHaveLength(4);
    expect(by['no-match'].score.status).toBe('no-match');
    expect(by['no-match'].scores.overall).toBeLessThanOrEqual(20);
  });

  it('note names are in the singer key and follow the shift; turn-taking has no sync offset', () => {
    expect(makeFakePhraseComparison('perfect', { shift: 0 }).notes[0].refName).toBe('G3');
    expect(makeFakePhraseComparison('perfect', { shift: -12 }).notes[0].refName).toBe('G2');
    expect(makeFakePhraseComparison('perfect', { mode: 'turn-taking' }).syncOffsetMs).toBeNull();
    expect(makeFakePhraseComparison('perfect', { mode: 'sing-along' }).syncOffsetMs).toBe(160);
  });

  it('the feedback module turns each into at most three fixes with the expected top fix', () => {
    expect(buildFixes(makeFakePhraseComparison('perfect'))).toEqual([]);
    expect(buildFixes(makeFakePhraseComparison('flat')).map((f) => f.category)).toContain('pitch');
    expect(buildFixes(makeFakePhraseComparison('late'))[0].id).toBe('timing-late');
    expect(buildFixes(makeFakePhraseComparison('wrong-note'))[0].id).toBe('wrong-notes');
    expect(buildFixes(makeFakePhraseComparison('partial'))[0].id).toBe('coverage');
    for (const s of COMPARISON_SCENARIOS) expect(buildFixes(makeFakePhraseComparison(s)).length).toBeLessThanOrEqual(3);
  });
});

describe('fake reference analysis', () => {
  it('has the 8 notes and one phrase', () => {
    const a = makeFakePhraseAnalysis();
    expect(a.notes).toHaveLength(8);
    expect(a.phrases).toHaveLength(1);
    expect(a.voicedSec).toBeGreaterThan(5);
  });
});

describe('fake clip', () => {
  const clip = makeFakeClip();
  const attempts = makeFakeAttempts();

  it('has 12 ordered, non-overlapping phrases with unique ids', () => {
    expect(clip.phrases).toHaveLength(12);
    expect(new Set(clip.phrases.map((p) => p.id)).size).toBe(12);
    clip.phrases.forEach((p, i) => {
      expect(p.index).toBe(i);
      if (i > 0) expect(p.start).toBeGreaterThanOrEqual(clip.phrases[i - 1].end);
      expect(p.end).toBeLessThanOrEqual(clip.durationSec);
    });
  });

  it('stats and review state agree with the attempts', () => {
    for (const p of clip.phrases) {
      const mine = attempts.filter((a) => a.phraseId === p.id);
      expect(p.stats.attempts).toBe(mine.length);
      if (mine.length) expect(p.stats.best).toBe(Math.max(...mine.map((a) => a.scores.overall)));
    }
    expect(clip.phrases.filter((p) => p.srs.rung > 0)).toHaveLength(4);
    expect(clip.phrases[10].stats.attempts).toBe(0);
    expect(clip.phrases[11].stats.attempts).toBe(0);
  });

  it('covers every status the library shows', () => {
    const status = clip.phrases.map((p) =>
      statusOf(p.srs, attempts.filter((a) => a.phraseId === p.id).sort((a, b) => a.at - b.at).map((a) => ({ at: a.at, overall: a.scores.overall, pitch: a.scores.pitch, timing: a.scores.timing, tone: a.scores.tone, rate: a.rate, coverage: a.coverage, wrongNotes: a.wrongNotes })), FAKE_NOW),
    );
    for (const s of ['new', 'learning', 'mastered', 'review-due', 'stuck']) expect(status).toContain(s);
  });

  it('is serialisable and carries no audio', () => {
    expect(JSON.parse(JSON.stringify(clip))).toEqual(clip);
    expect(clip.id).toBe(FAKE_CLIP_ID);
  });
});

describe('FakeTrainerEngine', () => {
  it('walks countin, singing, processing, result, and scripts the next takes', async () => {
    const e = new FakeTrainerEngine({ script: ['flat', 'perfect'] });
    const seen: string[] = [];
    e.subscribe(() => seen.push(e.getSnapshot().state));
    await e.sing();
    expect(seen).toEqual(['countin', 'countin', 'countin', 'singing', 'processing', 'result']);
    expect(e.getSnapshot().result?.comparison.score.overall).toBeLessThan(95);
    expect(e.getSnapshot().result?.fixes.length).toBeGreaterThan(0);
    await e.sing();
    expect(e.getSnapshot().result?.comparison.scores.overall).toBeGreaterThanOrEqual(97);
    await e.sing();
    expect(e.getSnapshot().result?.comparison.scores.overall).toBeGreaterThanOrEqual(97);
    expect(e.calls).toEqual(['sing', 'sing', 'sing']);
  });

  it('keeps getSnapshot stable between changes (useSyncExternalStore contract)', async () => {
    const e = new FakeTrainerEngine();
    expect(e.getSnapshot()).toBe(e.getSnapshot());
    const before = e.getSnapshot();
    e.setOptions({ rate: 0.75 });
    expect(e.getSnapshot()).not.toBe(before);
    expect(e.getSnapshot().options.rate).toBe(0.75);
  });

  it('can end in interrupted or error with a message, and dispose is idempotent', async () => {
    const e = new FakeTrainerEngine({ failSing: { state: 'interrupted', message: 'Interrupted - not scored. Tap Sing to try again.' } });
    await e.sing();
    expect(e.getSnapshot().state).toBe('interrupted');
    expect(e.getSnapshot().message).toMatch(/try again/i);
    e.dispose();
    e.dispose();
    expect(e.getSnapshot().state).toBe('closed');
    await e.sing();
    expect(e.getSnapshot().state).toBe('closed');
  });

  it('mirrors the real engine: the microphone is open after a take and Turn off closes it, never while a take runs', async () => {
    const e = new FakeTrainerEngine();
    expect(e.getSnapshot()).toMatchObject({ micOpen: false, speakerConfirmed: false });
    await e.sing();
    expect(e.getSnapshot().micOpen).toBe(true);
    e.releaseMicrophone();
    expect(e.getSnapshot().micOpen).toBe(false);
    e.force({ state: 'singing', micOpen: true });
    e.releaseMicrophone();
    expect(e.getSnapshot().micOpen).toBe(true);
    expect(e.calls).toEqual(['sing', 'releaseMicrophone', 'releaseMicrophone']);
  });

  it('mirrors the real engine: "I have headphones on" is remembered for sing-along only', async () => {
    const e = new FakeTrainerEngine({ options: { mode: 'sing-along' } });
    await e.sing({ speakerConfirmed: true });
    expect(e.getSnapshot().speakerConfirmed).toBe(true);
    const t = new FakeTrainerEngine({ options: { mode: 'turn-taking' } });
    await t.sing({ speakerConfirmed: true });
    expect(t.getSnapshot().speakerConfirmed).toBe(false);
  });

  it('mirrors the real engine: finish() scores what was sung while recording, and is stop() anywhere else; stop() cancels the take', async () => {
    const e = new FakeTrainerEngine({ script: ['perfect'] });
    const seen: string[] = [];
    e.subscribe(() => seen.push(e.getSnapshot().state));
    const p = e.sing();
    for (let i = 0; i < 20 && e.getSnapshot().state !== 'singing'; i++) await Promise.resolve();
    expect(e.getSnapshot().state).toBe('singing');
    e.finish();
    expect(e.getSnapshot().state).toBe('processing');
    await p;
    await Promise.resolve();
    await Promise.resolve();
    expect(e.getSnapshot().state).toBe('result');
    expect(seen.filter((s) => s === 'result')).toHaveLength(1); // the take that was finished is not scored a second time
    // finish() when nothing is recording is stop()
    e.finish();
    expect(e.getSnapshot().state).toBe('result');
    // a cancelled take shows no result
    const c = new FakeTrainerEngine();
    const q = c.sing();
    await Promise.resolve();
    c.stop();
    await q;
    expect(c.getSnapshot().state).toBe('idle');
    expect(c.getSnapshot().result).toBeNull();
  });

  it('starts in preparing with no reference when asked', () => {
    const e = new FakeTrainerEngine({ initialState: 'preparing' });
    expect(e.getSnapshot().reference).toBeNull();
    e.force({ state: 'error', message: 'Could not load this phrase. Go back and open it again.' });
    expect(e.getSnapshot().state).toBe('error');
  });
});

describe('FakeTrainerController', () => {
  it('lists the fake clip, builds a queue and hands out engines', async () => {
    const t = makeFakeTrainerController();
    expect(t.clips).toHaveLength(1);
    expect(t.queue.length).toBeGreaterThan(0);
    expect(t.queue.length).toBeLessThanOrEqual(5);
    const engine = await t.openPractice(t.clips[0].id, t.clips[0].phrases[2].id);
    expect(engine.phrase.index).toBe(2);
    await expect(t.openPractice('nope', 'nope')).rejects.toThrow(/no longer/);
    expect(t.engines).toHaveLength(1);
  });

  it('imports a clip, edits, relinks and deletes in memory', async () => {
    const t = makeFakeTrainerController({ clips: [] });
    expect(t.queue).toEqual([]);
    const prepared = await t.prepareClip(new File([new Uint8Array(4)], 'song.m4a'));
    expect(prepared.phrases.length).toBeGreaterThan(0);
    const clip = await t.commitClip(prepared, { title: 'My clip', singerId: 'daniel-caesar', singerLabel: '', kind: 'solo', phrases: prepared.phrases, contributeToSinger: false, ownedConfirmed: true });
    expect(t.clips[0].id).toBe(clip.id);
    expect(clip.phrases).toHaveLength(prepared.phrases.length);
    expect(t.queue.every((q) => q.status === 'new')).toBe(true);
    await t.updateClip(clip.id, { title: 'Renamed' });
    expect(t.getClip(clip.id)?.title).toBe('Renamed');
    await t.setContributes(clip.id, true);
    expect(t.getClip(clip.id)?.contributesToSinger).toBe(true);
    await t.deleteClip(clip.id);
    expect(t.clips).toEqual([]);
    expect(t.calls).toContain('deleteClip');
  });

  it('lists attempts newest first and deletes them by phrase', async () => {
    const t = makeFakeTrainerController();
    const phraseId = t.clips[0].phrases[0].id;
    const list = await t.listAttempts({ phraseId });
    expect(list.length).toBeGreaterThan(1);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].at).toBeGreaterThanOrEqual(list[i].at);
    expect(await t.deleteAttempts({ phraseId })).toBe(list.length);
    expect(await t.listAttempts({ phraseId })).toEqual([]);
  });

  it('a prepared clip fake is usable as an import review input', () => {
    const p = makeFakePreparedClip({ warnings: ['This looks like a full mix.'] });
    expect(p.warnings).toHaveLength(1);
    expect(p.blockers).toEqual([]);
  });
});
