// The contract between the scorer and the rest of the trainer: what it reports about mixes, short phrases, flags, bleed,
// tone calibration and the tracker's range. (Accuracy of the numbers is in score.test.ts and injectedErrors.test.ts.)
import { describe, expect, it } from 'vitest';
import { analyzeTake } from '../../analysis/analyze';
import { concat, makeRng, silence } from '../../testing/synth';
import type { AttemptRecord, NoteSegment, StyleVector, VoiceAnalysis } from '../../types';
import { hasRealVoice, loadRealVoice } from './realVoice';
import { fixEvidence, isMixReference, isShortPhrase, scoreAttempt, untrackableNotes } from './score';
import type { AttemptScore } from './types';
import { TONE_BIAS_MAX, estimateToneBias, toneBiasFromAttempts, toneIndexDiffs } from './tone';
import { DEFAULT_TONE, HUMAN, PH_A, PH_SHORT, SR, analyse, attemptAnalysis, humanize, refAnalysis, renderPhrase, roomNoise } from './testkit';
import * as I from './testkit';

const ref = refAnalysis(PH_A);
const NON_OK = (f: string): boolean => f !== 'ok' && f !== 'ornament';

describe('references from full songs', () => {
  const att = attemptAnalysis({ notes: PH_A, key: -2, lead: 1.4 });

  it('a lead-vocal-extraction analysis (mode "mix") is a mix reference, like one flagged "accompaniment"', () => {
    const viaMode: VoiceAnalysis = { ...ref, mode: 'mix' };
    const viaIssue: VoiceAnalysis = { ...ref, issues: [...ref.issues, 'accompaniment'] };
    expect(isMixReference(viaMode)).toBe(true);
    expect(isMixReference(viaIssue)).toBe(true);
    expect(isMixReference(ref)).toBe(false);
    for (const mix of [viaMode, viaIssue]) {
      const r = scoreAttempt(mix, att);
      expect(r.skills.tone).toBeNull();
      expect(r.skills.pitch).not.toBeNull();
      expect(r.skills.timing).not.toBeNull();
      expect(r.skills.expression).not.toBeNull();
      expect(r.components.some((c) => c.id.startsWith('tone.') || c.id === 'expr.dynamics' || c.id === 'expr.attack')).toBe(false);
      expect(r.trust.level).toBe('caution');
      expect(r.diagnostics.refMix).toBe(true);
    }
  });
});

describe('short phrases', () => {
  it('under five notes or four seconds of singing is short; the exact number is kept', () => {
    expect(isShortPhrase(refAnalysis(PH_SHORT))).toBe(true);
    expect(isShortPhrase(ref)).toBe(false);
    const r = scoreAttempt(refAnalysis(PH_SHORT), attemptAnalysis({ notes: PH_SHORT, key: 0, lead: 1.2 }));
    expect(r.diagnostics.shortPhrase).toBe(true);
    expect(r.trust.reasons.join(' ')).toMatch(/short/);
    expect(r.trust.reasons.join(' ')).toMatch(/nearest 5/);
    expect(Number.isInteger(r.overall)).toBe(true);
  });
});

describe('flags are charges', () => {
  const takes = [
    I.detuneAll(PH_A, 40), I.jitterOnsets(PH_A, 120), I.wrongNote(PH_A, 2, 2), I.wrongNote(PH_A, 7, -3), I.cutShort(PH_A, 3, 0.5), I.heightSlope(PH_A, 10),
    I.undershootLeaps(PH_A, 45), I.tempo(PH_A, 1.25), I.dropNote(PH_A, 4), humanize(PH_A, HUMAN.good, 2), humanize(PH_A, HUMAN.weak, 3),
  ];

  it('a soft flag (flat, sharp, late, early, short, long) only stays on a note that belongs to a ranked fix of that skill', () => {
    for (const notes of takes) {
      const r = scoreAttempt(ref, attemptAnalysis({ notes, key: -3, lead: 1.4, seed: 91 }));
      if (r.status !== 'ok') continue;
      const pitch = new Set(r.fixes.filter((f) => f.skill === 'pitch').flatMap((f) => f.notes));
      const timing = new Set(r.fixes.filter((f) => f.skill === 'timing').flatMap((f) => f.notes));
      for (const n of r.perNote) {
        if (n.flags.includes('flat') || n.flags.includes('sharp')) expect(pitch.has(n.refIndex)).toBe(true);
        if (n.flags.some((f) => ['late', 'early', 'short', 'long'].includes(f))) expect(timing.has(n.refIndex)).toBe(true);
        // a wrong note has lost (almost) all of its pitch credit
        if (n.flags.includes('wrong-note')) expect(n.pitchScore ?? 100).toBeLessThan(25);
        // 'ok' is only ever alone (or with the ornament mark)
        if (n.flags.includes('ok')) expect(n.flags.filter(NON_OK)).toEqual([]);
        // every matched note ends up with either real flags or 'ok'
        if (n.matched) expect(n.flags.length).toBeGreaterThan(0);
      }
    }
  }, 120_000);

  it('a take that scores 99 or 100 has no flagged note', () => {
    for (const key of [0, -12, 5]) {
      const r = scoreAttempt(ref, attemptAnalysis({ notes: PH_A, key, lead: 1.2 }));
      expect(r.overall as number).toBeGreaterThanOrEqual(99);
      expect(r.perNote.every((n) => n.flags.filter(NON_OK).length === 0)).toBe(true);
      expect(r.fixes).toEqual([]);
    }
  });

  it('a wrong note makes the score lower than the same take without it', () => {
    const good = scoreAttempt(ref, attemptAnalysis({ notes: PH_A, key: -3, lead: 1.4 }));
    for (const [k, semis] of [[2, 2], [7, -3], [5, 1]] as const) {
      const r = scoreAttempt(ref, attemptAnalysis({ notes: I.wrongNote(PH_A, k, semis), key: -3, lead: 1.4 }));
      if (!r.perNote[k].flags.includes('wrong-note')) continue; // a one-semitone slip may read as flat or sharp instead
      expect(r.overall as number).toBeLessThan(good.overall as number);
    }
  }, 60_000);

  it('the ranked fixes carry the finding text, in words', () => {
    const r = scoreAttempt(ref, attemptAnalysis({ notes: I.wrongNote(PH_A, 2, 2), key: -3, lead: 1.4 }));
    const wrong = r.fixes.find((f) => f.id === 'pitch.wrong-notes');
    expect(wrong).toBeDefined();
    expect(fixEvidence(r, 'pitch.wrong-notes')).toMatch(/note 3/);
    expect(fixEvidence(r, 'nonexistent')).toBeNull();
    const half = scoreAttempt(ref, attemptAnalysis({ notes: I.sliceNotes(PH_A, 0, 6), lead: 1.4 }));
    expect(half.fixes[0].id).toBe('coverage');
    // the evidence ("what we heard") and the advice ("how to fix") are different sentences
    expect(fixEvidence(half, 'coverage')).toMatch(/Only \d+% of the original was sung/);
    expect(half.fixes[0].advice).not.toMatch(/Only \d+%/);
  });

  it('a take that does not match gets no fixes and no per-note claims', () => {
    const r = scoreAttempt(ref, attemptAnalysis({ notes: I.PH_RUN, lead: 1.5 }));
    expect(r.status).toBe('no-match');
    expect(r.fixes).toEqual([]);
    expect(r.overall as number).toBeLessThanOrEqual(20);
  });
});

describe('speaker bleed', () => {
  it('reports it in the diagnostics (not only as a trust level), only when a guide was playing', () => {
    const ph = renderPhrase(PH_A, undefined, { leadIn: 0.15, tail: 0.2, noiseRms: 0 });
    const r0 = analyse(roomNoise(ph, 0.0012, 3));
    const leaked = analyse(roomNoise(concat(silence(2.18, SR), ph, silence(0.6, SR)), 0.0012, 8));
    const along = scoreAttempt(r0, leaked, { mode: 'sing-along', refStartInCaptureSec: 2, latencyMs: 120 });
    expect(along.diagnostics.bleedSuspect).toBe(true);
    expect(along.trust.level).toBe('invalid');
    const alone = scoreAttempt(r0, leaked, { mode: 'turn-taking' });
    expect(alone.diagnostics.bleedSuspect).toBe(false);
    const person = scoreAttempt(ref, attemptAnalysis({ notes: humanize(PH_A, HUMAN.good, 4), key: -5, lead: 2.3 }), { mode: 'sing-along', refStartInCaptureSec: 2 });
    expect(person.diagnostics.bleedSuspect).toBe(false);
  });
});

describe('the pitch tracker range', () => {
  it('names the reference notes that would sit outside 65 Hz .. 1400 Hz in the singer\'s key', () => {
    const low = refAnalysis(PH_A.map((n) => ({ ...n, midi: n.midi - 8 })), DEFAULT_TONE, 11, 'baritone');
    expect(untrackableNotes(low, 0)).toEqual([]);
    const down = untrackableNotes(low, -12);
    expect(down.length).toBeGreaterThanOrEqual(1);
    expect(down.every((k) => low.notes[k].midi - 12 < 37)).toBe(true);
    expect(untrackableNotes(low, 60).length).toBe(low.notes.length);
  });

  it('a silent take of a low reference suggests the other octave', () => {
    const low = refAnalysis(PH_A.map((n) => ({ ...n, midi: n.midi - 8 })), DEFAULT_TONE, 11, 'baritone');
    const r = scoreAttempt(low, analyse(roomNoise(new Float32Array(SR * 3), 0.001, 2)));
    expect(r.status).toBe('low-evidence');
    expect(r.notes.join(' ')).toMatch(/microphone/);
    expect(r.notes.join(' ')).toMatch(/C2/);
    // a comfortable reference gets no range talk
    const plain = scoreAttempt(ref, analyse(roomNoise(new Float32Array(SR * 3), 0.001, 2)));
    expect(plain.notes.join(' ')).not.toMatch(/C2/);
  });
});

describe('lag against the schedule', () => {
  it('is reported in sing-along only, minus the known latency, and never without evidence', () => {
    const att = attemptAnalysis({ notes: PH_A, key: -2, lead: 2 + 0.15 + 0.3, seed: 12 });
    const withLatency = scoreAttempt(ref, att, { mode: 'sing-along', refStartInCaptureSec: 2, latencyMs: 100 });
    const without = scoreAttempt(ref, att, { mode: 'sing-along', refStartInCaptureSec: 2 });
    expect(without.timing.lagMs).not.toBeNull();
    expect(Math.abs((without.timing.lagMs as number) - 300)).toBeLessThan(40);
    expect(Math.abs((withLatency.timing.lagMs as number) - 200)).toBeLessThan(40);
    expect(scoreAttempt(ref, att, { mode: 'turn-taking' }).timing.lagMs).toBeNull();
  });
});

describe('tone differences and the singer\'s own offsets', () => {
  const style = (over: Partial<StyleVector>): StyleVector => ({
    breathiness: 0.4, brightness: 0.5, rasp: 0.05, vibratoPresence: null, vibratoRateHz: null, vibratoExtentCents: null, chestInUpperRange: null, mixInUpperRange: null,
    headInUpperRange: null, loudnessClimbDbPerSemitone: null, agility: null, dynamicRangeDb: null, softOnsetRatio: null, pitchAccuracyCents: null, flipsPerMinute: null, ...over,
  });

  it('only the three normalised indices are compared, with the key effect and the dead zone', () => {
    const d = toneIndexDiffs(style({ breathiness: 0.62, brightness: 0.5 }), style({}), 0);
    expect(d.map((x) => x.key)).toEqual(['breathiness', 'brightness']); // both clean: rasp carries no information
    expect(d[0].corrected).toBeCloseTo(0.22, 5);
    expect(d[0].dead).toBeCloseTo(0.12, 5);
    // an octave lower: breathiness is expected 0.132 lower, and the dead zone is wider
    const octave = toneIndexDiffs(style({ breathiness: 0.4 - 0.132 }), style({}), -12);
    expect(Math.abs(octave[0].corrected)).toBeLessThan(0.01);
    expect(octave[0].dead).toBeGreaterThan(0.2);
    // an index one of the takes did not measure is skipped
    expect(toneIndexDiffs(style({ breathiness: null }), style({}), 0).map((x) => x.key)).not.toContain('breathiness');
  });

  it('the reference\'s grit is capped: a very rasping original is never asked for', () => {
    const d = toneIndexDiffs(style({ rasp: 0.0 }), style({ rasp: 0.9 }), 0).find((x) => x.key === 'rasp');
    expect(d?.ref).toBe(0.25);
  });

  it('a tone bias needs enough attempts, is capped, and never covers rasp', () => {
    const hist = (v: number, n: number) => Array.from({ length: n }, () => ({ diffs: { breathiness: v, brightness: -v, rasp: 0.3 } }));
    expect(estimateToneBias(hist(0.1, 5))).toEqual({});
    const b = estimateToneBias(hist(0.1, 6));
    expect(b.breathiness).toBeCloseTo(0.1, 5);
    expect(b.brightness).toBeCloseTo(-0.1, 5);
    expect('rasp' in b).toBe(false);
    expect(estimateToneBias(hist(0.4, 8)).breathiness).toBe(TONE_BIAS_MAX);
    expect(estimateToneBias(hist(-0.4, 8)).breathiness).toBe(-TONE_BIAS_MAX);
  });

  it('is estimated from stored attempts against their phrase\'s measured style', () => {
    const items = Array.from({ length: 6 }, () => ({ transposeSemitones: 0, style: style({ breathiness: 0.5 }), refStyle: style({ breathiness: 0.4 }) }));
    expect(toneBiasFromAttempts(items).breathiness).toBeCloseTo(0.1, 5);
    // attempts against a phrase with no tone measurement (a full mix) are skipped
    const mixed = [...items.slice(0, 5), { transposeSemitones: 0, style: style({ breathiness: 0.9 }), refStyle: null }];
    expect(toneBiasFromAttempts(mixed)).toEqual({});
    // the key effect is taken out first: an octave lower is expected to read 0.132 lower
    const down = Array.from({ length: 6 }, () => ({ transposeSemitones: -12, style: style({ breathiness: 0.4 - 0.132 }), refStyle: style({ breathiness: 0.4 }) }));
    expect(Math.abs(toneBiasFromAttempts(down).breathiness ?? 9)).toBeLessThan(0.01);
    // an AttemptRecord supplies exactly the fields needed
    const rec: Pick<AttemptRecord, 'transposeSemitones' | 'style'> = { transposeSemitones: 0, style: style({}) };
    expect(toneBiasFromAttempts([{ ...rec, refStyle: style({}) }])).toEqual({});
  });
});

describe('robustness of the numbers', () => {
  it('never returns NaN or an out-of-range number, however broken the analysis', () => {
    const att = attemptAnalysis({ notes: PH_A, key: -4, lead: 1.5 });
    const broken: VoiceAnalysis = {
      ...att,
      frames: att.frames.map((f, i) => (i % 5 === 0 ? { ...f, rmsDb: NaN, midi: i % 10 === 0 ? NaN : f.midi } : f)),
      notes: att.notes.map((n): NoteSegment => ({ ...n, meanRmsDb: Number.NaN })),
    };
    const r = scoreAttempt(ref, broken);
    for (const v of [r.overall, r.overallOnSung, ...Object.values(r.skills)]) if (v !== null) expect(v >= 0 && v <= 100 && Number.isFinite(v)).toBe(true);
    for (const f of r.fixes) expect(Number.isFinite(f.gainPoints)).toBe(true);
    expect(r.notes.every((s) => !s.includes('NaN') && !s.includes('undefined'))).toBe(true);
    for (const n of r.perNote) for (const v of [n.cents, n.onsetMs, n.durRatio, n.levelDeltaDb]) if (v !== null) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('fuzz: damaged takes never throw and never return an impossible number', () => {
  function sane(r: AttemptScore): void {
    for (const v of [r.overall, r.overallOnSung, ...Object.values(r.skills)]) if (v !== null) expect(v >= 0 && v <= 100 && Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(r.coverage)).toBe(true);
    expect(r.notes.every((n) => typeof n === 'string' && !n.includes('NaN') && !n.includes('undefined'))).toBe(true);
    for (const f of r.fixes) expect(Number.isFinite(f.gainPoints)).toBe(true);
    for (const n of r.perNote) for (const v of [n.cents, n.onsetMs, n.durRatio, n.levelDeltaDb]) if (v !== null) expect(Number.isFinite(v)).toBe(true);
    if (r.status !== 'ok') expect(r.fixes).toEqual([]);
  }

  it('25 takes with stretches unvoiced, levels missing and notes dropped', () => {
    const att = attemptAnalysis({ notes: PH_A, key: -4, lead: 1.5 });
    const rng = makeRng(5);
    for (let trial = 0; trial < 25; trial++) {
      const frames = att.frames.map((f) => ({ ...f }));
      for (let k = 0; k < 6; k++) {
        const a = Math.floor(rng() * frames.length);
        const len = Math.floor(rng() * 80);
        for (let i = a; i < Math.min(frames.length, a + len); i++) Object.assign(frames[i], { voiced: false, f0: NaN, midi: NaN });
      }
      if (trial % 3 === 0) for (const f of frames) if (rng() < 0.05) f.rmsDb = NaN;
      const notes = att.notes.filter(() => rng() > 0.25).map((x) => ({ ...x }));
      sane(scoreAttempt(ref, { ...att, frames, notes }));
    }
  }, 60_000);

  it('tiny, empty and reversed inputs', () => {
    const empty = analyse(new Float32Array(SR));
    const att = attemptAnalysis({ notes: PH_A, lead: 1 });
    sane(scoreAttempt(empty, att));
    sane(scoreAttempt(ref, empty));
    sane(scoreAttempt(ref, ref));
    sane(scoreAttempt(ref, { ...att, frames: [...att.frames].reverse().map((f, i) => ({ ...f, t: i * att.hopSec })) }));
    sane(scoreAttempt(ref, { ...att, frames: [], notes: [] }));
  });

  it.skipIf(!hasRealVoice('karissa.wav'))('a 60 s full song as the attempt or as the reference gates cleanly and fast', () => {
    const w = loadRealVoice('karissa.wav', 60);
    const mix = analyzeTake(w.samples, w.sampleRate, { voiceType: 'soprano' });
    const att = attemptAnalysis({ notes: PH_A, key: -4, lead: 1.5 });
    const t0 = performance.now();
    const asAttempt = scoreAttempt(ref, mix);
    const asRef = scoreAttempt(mix, att);
    const ms = performance.now() - t0;
    sane(asAttempt);
    sane(asRef);
    expect(asAttempt.status).not.toBe('ok');
    expect(ms).toBeLessThan(3000);
  }, 120_000);
});
