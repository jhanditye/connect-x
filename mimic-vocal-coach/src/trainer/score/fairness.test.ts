// Fairness regressions from the second review round: a score is closeness to the original and must not invent faults.
//  ornaments and tracker artefacts are not wrong notes; a pitch error does not become a timing fix; poor takes are not told they
//  changed key; a take in the wrong key against a guide is told so; tone advice stays inside what the measurement supports; fixes worth
//  a point or less do not appear; the sentence next to the score does not repeat the first card; no copy has a "?" or contradicts itself.
import { describe, expect, it } from 'vitest';
import { comparePhrase, scoresOf, wrongNoteCount } from '../compare';
import { buildFixes, toneWords } from '../feedback';
import { FIX_SHOWN_POINTS } from './constants';
import { fixEvidence, scoreAttempt, scoreBand } from './score';
import { toneSize } from './tone';
import { DEFAULT_TONE, HUMAN, PH_A, PH_RUN, attemptAnalysis, humanize, refAnalysis, tempo } from './testkit';
import * as I from './testkit';
import type { AttemptScore, PlayTiming } from '../../types';

const ref = refAnalysis(PH_A);
const refRun = refAnalysis(PH_RUN);
const turn: PlayTiming = { mode: 'turn-taking', rate: 1, keyMode: 'free' };
const take = (notes = PH_A, over: Parameters<typeof attemptAnalysis>[0] = {}) => attemptAnalysis({ notes, seed: 77, lead: 1.6, ...over });
const textOf = (r: AttemptScore): string => [...r.notes, ...r.fixes.map((f) => f.advice), ...r.fixes.map((f) => fixEvidence(r, f.id) ?? '')].join(' // ');

describe('ornaments and run notes are never "wrong notes"', () => {
  const simplified = I.clone(PH_RUN);
  simplified.splice(2, 6, { midi: 66, durSec: 0.36 }, { midi: 64, durSec: 0.36 });
  const oneNote = I.clone(PH_RUN);
  oneNote.splice(2, 6, { midi: 64, durSec: 0.72 });

  it('a run sung as two notes, or as one held note, is a good try with no wrong-note flag, fix or wording', () => {
    for (const notes of [simplified, oneNote]) {
      const c = comparePhrase(take(notes), refRun, turn);
      expect(c.score.status).toBe('ok');
      expect(c.notes.filter((n) => n.flags.includes('wrong-note'))).toEqual([]);
      expect(wrongNoteCount(c)).toBe(0);
      expect(c.score.fixes.map((f) => f.id)).not.toContain('pitch.wrong-notes');
      expect(textOf(c.score)).not.toMatch(/wrong (note|pitch)/i);
      expect(c.score.overall as number).toBeGreaterThanOrEqual(90);
      expect(c.score.skills.timing as number).toBeGreaterThanOrEqual(95);
    }
  }, 60_000);

  it('a wrong note outside the run is still a wrong note, and is counted once', () => {
    const wrong = I.wrongNote(PH_RUN, 1, 2);
    const c = comparePhrase(take(wrong), refRun, turn);
    expect(c.score.fixes.map((f) => f.id)).toContain('pitch.wrong-notes');
    expect(wrongNoteCount(c)).toBe(1);
    // a sentence that starts with the note starts with a capital
    expect(fixEvidence(c.score, 'pitch.wrong-notes')).toMatch(/\. Note \d+ \(/);
    expect(textOf(c.score)).not.toMatch(/(^|[.!?] )note \d/);
  }, 60_000);

  it('an octave-displaced note is information, not a wrong note', () => {
    // the line sung an octave low on one long note: the pitch name is right
    const low = I.clone(PH_A);
    low[3].midi -= 12;
    const c = comparePhrase(take(low), ref, turn);
    const row = c.notes[3];
    if (row.flags.includes('octave-displaced')) {
      expect(wrongNoteCount(c)).toBe(0);
      expect(c.score.fixes.map((f) => f.id)).not.toContain('pitch.wrong-notes');
    }
  }, 60_000);
});

describe('a pitch error does not become a timing error', () => {
  it('one note a tone or more off, every entrance on time: no timing fix and a timing score of 97 or more', () => {
    for (const [k, semis] of [[2, 2], [2, 3], [4, -2], [7, 2]] as const) {
      const r = scoreAttempt(ref, take(I.wrongNote(PH_A, k, semis)));
      expect(r.status).toBe('ok');
      expect(r.skills.pitch as number).toBeLessThan(97);
      expect(r.skills.timing as number, `note ${k + 1} ${semis} st`).toBeGreaterThanOrEqual(97);
      expect(r.fixes.map((f) => f.id).filter((id) => id.startsWith('timing.')), `note ${k + 1} ${semis} st`).toEqual([]);
      expect(r.perNote.flatMap((n) => n.flags).filter((f) => f === 'late' || f === 'early')).toEqual([]);
    }
  }, 120_000);

  it('a real timing error next to a pitch error is still found', () => {
    const notes = I.shiftOnset(I.wrongNote(PH_A, 2, 2), 6, 250);
    const r = scoreAttempt(ref, take(notes));
    expect(r.skills.timing as number).toBeLessThan(97);
  }, 60_000);
});

describe('poor takes are not told they changed key', () => {
  it('simulated poor singers in the original key: the key is the original, an octave multiple, never "1 semitone lower"', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = scoreAttempt(ref, attemptAnalysis({ notes: humanize(PH_A, HUMAN.poor, seed), seed: 70 + seed, lead: 1.6 }));
      if (r.status !== 'ok') continue;
      expect(r.transposeSemitones % 12, `seed ${seed}`).toBe(0);
      expect(r.notes.join(' '), `seed ${seed}`).not.toMatch(/semitones? (lower|higher) than the (reference|original)/);
    }
  }, 120_000);

  it('a tidy take one semitone up is a real transposition and is reported as one', () => {
    const r = scoreAttempt(ref, take(PH_A, { key: 1 }));
    expect(r.transposeSemitones).toBe(1);
    expect(r.notes.join(' ')).toMatch(/1 semitone higher/);
  }, 60_000);
});

describe('why a take did not match', () => {
  it('right rhythm, every note far off: the notice says the rhythm matched and the notes were far, not "get closer to the microphone"', () => {
    const notes = I.clone(PH_A).map((n, i) => ({ ...n, detuneCents: (i % 2 ? -1 : 1) * 150 }));
    const r = scoreAttempt(ref, take(notes));
    expect(r.status).toBe('no-match');
    expect(r.diagnostics.noMatchWhy).toBe('pitch-far');
    expect(r.notes[0]).toMatch(/rhythm matched/);
    expect(r.notes[0]).not.toMatch(/microphone/);
    expect(r.fixes).toEqual([]);
  }, 60_000);

  it('a different phrase is plain no-match, without a reason that would blame the pitch', () => {
    const r = scoreAttempt(ref, take(PH_RUN, { seed: 9, lead: 1.5 }));
    expect(r.status).toBe('no-match');
    expect(r.diagnostics.noMatchWhy).toBeNull();
  }, 60_000);

  it('singing along (locked key) in another key: the take is no-match, and the first line says which key you sang and what to do', () => {
    const along = { mode: 'sing-along' as const, keyMode: 'locked' as const, refStartInCaptureSec: 2.0 };
    for (const key of [-5, 2]) {
      const r = scoreAttempt(ref, take(PH_A, { key, lead: 2.3 }), along);
      expect(r.status, `key ${key}`).toBe('no-match');
      expect(r.diagnostics.noMatchWhy, `key ${key}`).toBe('locked-key');
      expect(r.notes[0], `key ${key}`).toMatch(new RegExp(`${Math.abs(key)} semitones? ${key < 0 ? 'below' : 'above'} the original key`));
      expect(r.notes[0]).toMatch(/only octaves count/);
      expect(r.notes[0]).toMatch(/Listen then sing/);
      expect(r.notes[0]).not.toMatch(/my own key|microphone/);
    }
    // the same notes in turn-taking are a perfect copy in another key
    expect(scoreAttempt(ref, take(PH_A, { key: -5 })).status).toBe('ok');
    // an octave is free while singing along
    expect(scoreAttempt(ref, take(PH_A, { key: -12, lead: 2.3 }), along).status).toBe('ok');
  }, 120_000);
});

describe('tone advice stays inside what the measurement supports', () => {
  const rasp = (sub: number) => ({ ...DEFAULT_TONE, subharmonic: sub });

  it('rasp in the take is named before breathiness, whichever reading fired', () => {
    const r = scoreAttempt(ref, take(PH_A, { tone: rasp(0.4) }));
    const ids = r.fixes.map((f) => f.id);
    expect(ids).toContain('tone.rasp');
    if (ids.includes('tone.breathiness')) expect(ids.indexOf('tone.rasp')).toBeLessThan(ids.indexOf('tone.breathiness'));
  }, 60_000);

  it('a raspy take that is given the rasp fix is not also told it is airier', () => {
    for (const sub of [0.3, 0.5]) {
      const r = scoreAttempt(ref, take(PH_A, { tone: rasp(sub) }));
      const ids = r.fixes.map((f) => f.id);
      if (!ids.includes('tone.rasp')) continue;
      expect(ids, `subharmonic ${sub}`).not.toContain('tone.breathiness');
      expect(textOf(r), `subharmonic ${sub}`).not.toMatch(/airier|let your vocal folds meet|more air/i);
    }
    // at least one of the two is a raspy take with the rasp fix, so the loop above is not vacuous
    expect(['tone.rasp'].every((id) => [0.3, 0.5].some((sub) => scoreAttempt(ref, take(PH_A, { tone: rasp(sub) })).fixes.some((f) => f.id === id)))).toBe(true);
  }, 120_000);

  it('a clean take against a raspy original is never told to let more air in', () => {
    const rough = refAnalysis(PH_A, rasp(0.4));
    const r = scoreAttempt(rough, take(PH_A));
    expect(r.fixes.map((f) => f.id)).not.toContain('tone.breathiness');
    expect(textOf(r)).not.toMatch(/more air/i);
  }, 60_000);

  it('the tone fix names its size with the same word as the tone panel, shows no index numbers, and says it is an estimate', () => {
    const c = comparePhrase(take(PH_A, { tone: { ...DEFAULT_TONE, tiltDbPerOct: -6 } }), ref, turn);
    const fix = c.score.fixes.find((f) => f.id === 'tone.brightness');
    expect(fix).toBeDefined();
    const evidence = fixEvidence(c.score, 'tone.brightness') as string;
    const finding = c.tone.find((t) => t.key === 'brightness');
    expect(finding).toBeDefined();
    const panel = toneWords(finding!);
    expect(panel.size).not.toBeNull();
    expect(evidence).toContain(panel.size as string);
    expect(evidence).not.toMatch(/\d\.\d\d/);
    expect(evidence).toMatch(/estimate/);
  }, 60_000);

  it('one size scale: a little / clearly / much', () => {
    expect(toneSize(0.14, 0.1)).toBe('a little');
    expect(toneSize(0.25, 0.1)).toBe('clearly');
    expect(toneSize(0.5, 0.1)).toBe('much');
  });
});

describe('fixes worth a point or less are not shown', () => {
  it('every listed fix is worth at least 1.5 points, or is the only thing to say about a take under 95', () => {
    const takes = [
      take(PH_A), take(I.detuneAll(PH_A, 25)), take(I.cutShort(PH_A, 3, 0.5)), take(I.noScoop(PH_A)), take(I.tempo(PH_A, 0.9)),
      take(PH_A, { tone: { ...DEFAULT_TONE, breathNoise: 0.4, h1BoostDb: 6 } }), take(I.wrongNote(PH_A, 2, 2)), take(I.noVibrato(PH_A)),
    ];
    for (const t of takes) {
      const r = scoreAttempt(ref, t);
      const ok = r.fixes.every((f) => f.gainPoints >= FIX_SHOWN_POINTS || f.id === 'coverage') || (r.fixes.length === 1 && (r.overall as number) < 95);
      expect(ok, JSON.stringify(r.fixes.map((f) => [f.id, f.gainPoints]))).toBe(true);
    }
  }, 120_000);
});

describe('the sentence next to the score', () => {
  it('is a verdict, not the first card repeated and not the key line, when there are fixes', () => {
    for (const notes of [I.detuneAll(PH_A, 45), I.wrongNote(PH_A, 7, -3), I.tempo(PH_A, 1.25)]) {
      const r = scoreAttempt(ref, take(notes, { key: -4 }));
      expect(r.fixes.length).toBeGreaterThan(0);
      const first = r.fixes[0];
      expect(r.notes[0]).not.toBe(fixEvidence(r, first.id));
      expect(r.notes[0]).not.toMatch(/semitones? (lower|higher)/);
      expect(r.notes.slice(1).join(' ')).toMatch(/semitones lower/); // still said, further down
    }
  }, 120_000);
});

describe('copy', () => {
  it('no sentence of a scored take has a question mark in place of a note, or says "you sang X" where X is the note itself', () => {
    const cases = [I.wrongNote(PH_A, 2, 2), I.wrongNote(PH_A, 4, -3), I.detuneAll(PH_A, 80, 11), humanize(PH_A, HUMAN.weak, 4)];
    for (const notes of cases) {
      const r = scoreAttempt(ref, take(notes));
      const text = textOf(r);
      expect(text).not.toMatch(/you sang \?/);
      expect(text).not.toMatch(/\(\?\)|: \?/);
      for (const m of text.matchAll(/note \d+ \(([A-G]#?\d)\): you sang ([A-G]#?\d)(,|\.|;| )/g)) {
        expect(m[2], text).not.toBe(m[1]);
      }
    }
  }, 120_000);

  it('the coverage fix says what was heard in one sentence and what to do in another', () => {
    const r = scoreAttempt(ref, take(I.sliceNotes(PH_A, 0, 6)));
    const f = r.fixes.find((x) => x.id === 'coverage');
    expect(f).toBeDefined();
    expect(fixEvidence(r, 'coverage')).toMatch(/Only \d+% of the original was sung/);
    expect((f as { advice: string }).advice).not.toBe(fixEvidence(r, 'coverage'));
    expect((f as { advice: string }).advice).toMatch(/first note to the last/);
  }, 60_000);

  it('the loudness finding lists each note name once and says what the singer did', () => {
    const gains = PH_A.map((_, i) => (i === 3 || i === 7 || i === 9 ? 9 : 0));
    const c = comparePhrase(take(I.gainPattern(PH_A, gains)), ref, turn);
    const level = c.tone.find((t) => t.key === 'level');
    if (level) {
      const names = (level.detail ?? '').split(', ');
      expect(new Set(names).size).toBe(names.length);
      expect(toneWords(level).text).toMatch(/leaned in more than the original does|held back more than the original does/);
      expect(toneWords(level).text).not.toMatch(/it stays softer there/);
    }
  }, 60_000);
});

describe('tempo wording', () => {
  it('speed is reported as a change of speed, the same way both ways', () => {
    const fast = scoreAttempt(ref, take(tempo(PH_A, 0.8)));
    const slow = scoreAttempt(ref, take(tempo(PH_A, 1.25)));
    expect(fast.notes.join(' ')).toMatch(/about 25% faster/);
    expect(slow.notes.join(' ')).toMatch(/about 20% slower/);
  }, 60_000);

  it('after listening there is no "track" to keep up with; while singing along there is', () => {
    const slowTake = take(tempo(PH_A, 1.25));
    const afterListening = buildFixes(comparePhrase(slowTake, ref, turn));
    const tempoFix = afterListening.find((f) => f.category === 'tempo');
    expect(tempoFix?.title).toBe('Pick up the pace');
    expect(tempoFix?.evidence).not.toMatch(/track/);
    // a person following the track wobbles a little (an exact copy of the playback would be flagged as speaker bleed)
    const along = comparePhrase(take(humanize(tempo(PH_A, 1.25), HUMAN.pro, 3), { lead: 2.3 }), ref, { mode: 'sing-along', rate: 1, keyMode: 'free', refStartInCaptureSec: 2.0 });
    expect(buildFixes(along).find((f) => f.category === 'tempo')?.title).toBe('Keep up with the track');
  }, 120_000);
});

describe('short phrases are rounded without crossing a mark that means something', () => {
  it('83 is shown as 80, not as the 85 that counts as a good attempt; 78 is not shown as the 80 of a passed review; 63 is not 65', () => {
    const base = scoreAttempt(ref, take(PH_A));
    const short = (overall: number): AttemptScore => ({ ...base, overall, diagnostics: { ...base.diagnostics, shortPhrase: true } });
    expect(scoresOf(short(83)).overall).toBe(80);
    expect(scoresOf(short(84)).overall).toBe(80);
    expect(scoresOf(short(86)).overall).toBe(85);
    expect(scoresOf(short(78)).overall).toBe(75);
    expect(scoresOf(short(63)).overall).toBe(60);
    expect(scoresOf(short(97)).overall).toBe(95);
    expect(scoresOf(short(99)).overall).toBe(100);
    expect(scoresOf({ ...base, overall: 83 }).overall).toBe(83); // not short: as measured
  });
});

describe('the words for a score', () => {
  it('"Very close" needs 90, or 93 when the notes themselves were loose (pitch under 85): tone and expression are nearly free', () => {
    expect(scoreBand(91)).toBe('excellent');
    expect(scoreBand(91, null)).toBe('excellent');
    expect(scoreBand(91, 90)).toBe('excellent');
    expect(scoreBand(91, 76)).toBe('good');
    expect(scoreBand(93, 76)).toBe('excellent');
    expect(scoreBand(80)).toBe('good');
    expect(scoreBand(62)).toBe('fair');
    expect(scoreBand(40)).toBe('needs-work');
  });
});

describe('the coverage fix needs a take above the quiet-take level', () => {
  const missing = I.sliceNotes(PH_A, 0, 6);

  it('a take that skipped a note is told to sing the whole phrase', () => {
    const r = scoreAttempt(ref, take(missing));
    expect(r.diagnostics.quietTake).toBe(false);
    expect(r.fixes.map((f) => f.id)).toContain('coverage');
  }, 60_000);

  it('the same take, flagged as very quiet, is not: the notes may simply not have been heard', () => {
    const quiet = { ...take(missing), issues: ['too-quiet' as const] };
    const r = scoreAttempt(ref, quiet);
    expect(r.diagnostics.quietTake).toBe(true);
    expect(r.fixes.map((f) => f.id)).not.toContain('coverage');
    expect(r.diagnostics['fix.coverage']).toBeUndefined();
    expect(r.trust.reasons.join(' ')).toMatch(/very quiet/);
  }, 60_000);
});
