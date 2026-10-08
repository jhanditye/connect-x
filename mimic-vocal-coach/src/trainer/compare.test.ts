// comparePhrase on synthetic singing with known ground truth: the per-note table, the sync model, the key handling, the
// tone findings, the gates and the ONE score (scoreAttempt) must all agree. Sing-along takes are made human-like (a little
// scatter in pitch and timing), because an exact copy of the playback is, by design, flagged as speaker bleed.
// Real-voice cases need clips that live outside the repository and are skipped when they are not there.

import { describe, expect, it } from 'vitest';
import { compareToReference } from '../coach/reference';
import { concat, silence } from '../testing/synth';
import type { NoteCompare, PlayTiming, VoiceAnalysis } from '../types';
import { buildFixes } from './feedback';
import { comparePhrase, scoreIsRounded, scoresOf, toneBiasFromCalibration, toneBiasToCalibration, vibratoStartDelay } from './compare';
import { hasRealVoice, loadRealVoice } from './score/realVoice';
import { untrackableNotes } from './score/score';
import * as T from './score/testkit';
import { DEFAULT_TONE, HUMAN, PH_A, PH_SHORT, SR, analyse, attemptAnalysis, humanize, refAnalysis, type AttemptSpec } from './score/testkit';

const COUNTIN = 2;
const along = (rate = 1): PlayTiming => ({ mode: 'sing-along', rate, refStartInCaptureSec: COUNTIN, keyMode: 'free' });
const turn: PlayTiming = { mode: 'turn-taking', rate: 1, keyMode: 'free' };
/** A take in the sing-along clock: the phrase body starts COUNTIN + 0.15 (the reference's own lead-in) + lag after the capture starts. */
const sung = (spec: AttemptSpec, lag = 0.18, rate = 1): VoiceAnalysis => attemptAnalysis({ seed: 77, ...spec, lead: COUNTIN + 0.15 / rate + lag });
const ref = refAnalysis(PH_A);
const person = (seed = 3) => humanize(PH_A, HUMAN.pro, seed);
const flagsOf = (n: NoteCompare): string[] => n.flags.filter((f) => f !== 'ok' && f !== 'ornament');

describe('one authority: the table, the sync model and the score agree', () => {
  it('an octave-down copy 180 ms late: key and lag found, every note ok, flat numbers are the scorer numbers', () => {
    const c = comparePhrase(sung({ notes: person(), key: -12 }), ref, along());
    expect(c.transposeSemitones).toBe(-12);
    expect(Math.abs((c.syncOffsetMs ?? 999) - 180)).toBeLessThan(40);
    expect(c.syncConfidence).toBe('high');
    expect(c.score.status).toBe('ok');
    expect(c.score.overall).toBeGreaterThanOrEqual(92);
    expect(c.scores).toEqual(scoresOf(c.score));
    expect(c.scores.overall).toBe(c.score.overall);
    expect(c.coverage).toBe(c.score.coverage);
    expect(c.biasCents).toBe(c.score.keyOffsetCents);
    expect(c.notes).toHaveLength(PH_A.length);
    expect(c.bleedSuspect).toBe(false);
    expect(c.notes.every((n) => n.matched)).toBe(true);
    expect(c.notes.filter((n) => flagsOf(n).length > 0).length).toBeLessThanOrEqual(2);
  });

  it('a perfect copy in your own key scores 99-100 and no note carries a flag', () => {
    const c = comparePhrase(sung({ notes: PH_A, key: -5 }), ref, turn);
    expect(c.scores.overall).toBeGreaterThanOrEqual(99);
    expect(c.notes.every((n) => flagsOf(n).length === 0)).toBe(true);
    expect(c.score.fixes).toEqual([]);
    expect(c.tone).toEqual([]);
    expect(c.transposeSemitones).toBe(-5);
  });

  it('a perfect copy in any key tells nothing: no tone finding, no flag, no fix', () => {
    for (const key of [-12, -7, -3, 5, 12]) {
      const c = comparePhrase(attemptAnalysis({ notes: PH_A, key, lead: 1.4, seed: 91 }), ref, turn);
      expect(c.transposeSemitones, `key ${key}`).toBe(key);
      expect(c.tone, `key ${key}`).toEqual([]);
      expect(c.notes.every((n) => flagsOf(n).length === 0), `key ${key}`).toBe(true);
      expect(buildFixes(c), `key ${key}`).toEqual([]);
      expect(c.scores.overall, `key ${key}`).toBeGreaterThanOrEqual(98);
    }
  }, 60_000);

  it('a flag is a charge: every flat / sharp / late / early / short / long note belongs to a ranked fix, every wrong note costs points', () => {
    const takes: AttemptSpec[] = [
      { notes: T.detuneAll(PH_A, 40), key: 0 },
      { notes: T.jitterOnsets(PH_A, 120), key: -3 },
      { notes: T.wrongNote(PH_A, 2, 2), key: -12 },
      { notes: T.cutShort(PH_A, 3, 0.5), key: 2 },
      { notes: T.heightSlope(PH_A, 10), key: 0 },
      { notes: person(5), key: -7 },
    ];
    for (const spec of takes) {
      const c = comparePhrase(sung(spec), ref, along());
      const pitchFix = new Set(c.score.fixes.filter((f) => f.skill === 'pitch').flatMap((f) => f.notes));
      const timingFix = new Set(c.score.fixes.filter((f) => f.skill === 'timing').flatMap((f) => f.notes));
      for (const n of c.notes) {
        if (n.flags.includes('flat') || n.flags.includes('sharp')) expect(pitchFix.has(n.refIndex), `pitch flag on note ${n.refIndex}`).toBe(true);
        if (n.flags.some((f) => f === 'late' || f === 'early' || f === 'short' || f === 'long')) expect(timingFix.has(n.refIndex), `timing flag on note ${n.refIndex}`).toBe(true);
        if (n.flags.includes('wrong-note')) expect(c.score.perNote[n.refIndex].pitchScore ?? 100, 'wrong note costs the note its pitch credit').toBeLessThan(25);
      }
      if (c.score.fixes.length === 0) expect(c.notes.every((n) => flagsOf(n).length === 0 || n.flags.includes('wrong-note') || n.flags.includes('missed') || n.flags.includes('merged'))).toBe(true);
    }
  }, 120_000);

  it('a wrong note is named, flagged and costs points; the note it ran into is merged, not "too long"', () => {
    const wrong = T.wrongNote(PH_A, 2, 2); // D4 -> E4, the same pitch as the next note
    const c = comparePhrase(sung({ notes: wrong, key: -12 }), ref, along());
    const n = c.notes[2];
    expect(n.flags).toContain('wrong-note');
    expect(Math.abs((n.cents ?? 0) - 200)).toBeLessThan(40);
    expect(n.userName).toBe(c.notes[3].refName);
    const perfect = comparePhrase(sung({ notes: PH_A, key: -12 }), ref, turn);
    expect(c.scores.overall).toBeLessThan(perfect.scores.overall);
    expect(c.scores.pitch).toBeLessThan(perfect.scores.pitch);
  });

  it('half a phrase: coverage near one half, the missed notes are listed, the score drops, the fix says to finish', () => {
    const c = comparePhrase(sung({ notes: T.sliceNotes(PH_A, 0, 6), key: -12 }), ref, along());
    expect(c.coverage).toBeGreaterThan(0.4);
    expect(c.coverage).toBeLessThan(0.65);
    expect(c.notes.slice(6).every((n) => n.flags.includes('missed') && !n.matched)).toBe(true);
    expect(c.notes.slice(0, 5).every((n) => n.matched)).toBe(true);
    expect(c.scores.overall).toBeLessThan(75);
    expect(c.score.fixes[0].id).toBe('coverage');
  });

  it('lead-in silence, a breath and a trailing remark do not matter', () => {
    const body = T.attemptAudio({ notes: PH_A, key: -3, lead: 0.5, tail: 0.5, seed: 77 });
    const talk = concat(silence(1.5, SR), T.renderPhrase([{ midi: 50, durSec: 0.8 }], undefined, { leadIn: 0, tail: 0 }), silence(1.2, SR), body, silence(0.6, SR), T.renderPhrase([{ midi: 48, durSec: 0.5 }], undefined, { leadIn: 0, tail: 0 }), silence(0.3, SR));
    const c = comparePhrase(analyse(T.roomNoise(talk, 0.0012, 5)), ref, turn);
    expect(c.score.status).toBe('ok');
    expect(c.scores.overall).toBeGreaterThanOrEqual(95);
    expect(c.transposeSemitones).toBe(-3);
  });
});

describe('the sync model and the time numbers', () => {
  it('turn-taking has no sync offset and still finds the key and tempo', () => {
    const c = comparePhrase(attemptAnalysis({ notes: PH_A, key: -12, lead: 3.4 }), ref, turn);
    expect(c.transposeSemitones).toBe(-12);
    expect(c.syncOffsetMs).toBeNull();
    expect(c.syncConfidence).toBe('none');
    expect(c.score.timing.lagMs).toBeNull();
    expect(Math.abs((c.tempoRatio ?? 0) - 1)).toBeLessThan(0.03);
    for (const n of c.notes) if (n.onsetMs !== null) expect(Math.abs(n.onsetMs)).toBeLessThan(60);
  });

  it('known faults: the right numbers come out of the table (detune, entrance, length), the sync is found', () => {
    const faulty = T.clone(PH_A);
    faulty[3].detuneCents = 40; // the long E4 sharp
    faulty[4].durSec += 0.12; // note 6 starts 120 ms late: its neighbour before it holds on
    faulty[5].durSec -= 0.12;
    const cut = T.cutShort(faulty, 9, 0.4); // the 0.7 s A3 cut 40 % short
    const c = comparePhrase(sung({ notes: cut, key: -12 }, 0.2), ref, along());
    expect(c.transposeSemitones).toBe(-12);
    expect(Math.abs((c.syncOffsetMs ?? 999) - 200)).toBeLessThan(45);
    expect(Math.abs((c.notes[3].cents ?? 0) - 40)).toBeLessThan(15);
    expect(c.notes[3].flags).toContain('sharp');
    expect(Math.abs((c.notes[5].onsetMs ?? 0) - 120)).toBeLessThan(45);
    expect(c.notes[5].flags).toContain('late');
    expect(c.score.status).toBe('ok');
  });

  it('a 25 % slower take: tempo ratio found, a tempo fix at the top, "keep up with the track"', () => {
    const c = comparePhrase(sung({ notes: T.tempo(PH_A, 1.25), key: 0 }), ref, along());
    expect(Math.abs((c.tempoRatio ?? 0) - 1.25)).toBeLessThan(0.05);
    expect(c.scores.timing as number).toBeLessThan(85);
    expect(c.score.fixes.map((f) => f.id)).toContain('timing.tempo');
  });

  it('reference played at 75 %: the sync offset is still found and nothing is called late', () => {
    const slow = T.tempo(PH_A, 1 / 0.75);
    const c = comparePhrase(sung({ notes: slow, key: -12 }, 0.2, 0.75), ref, along(0.75));
    expect(Math.abs((c.syncOffsetMs ?? 999) - 200)).toBeLessThan(45);
    expect(c.notes.filter((n) => n.flags.includes('late') || n.flags.includes('early')).length).toBeLessThanOrEqual(1);
    expect(c.scores.timing as number).toBeGreaterThanOrEqual(92);
  });
});

describe('vibrato', () => {
  // A short note, then a long held note whose vibrato starts `delay` seconds in.
  const phrase = (delay: number): T.PNote[] => [
    { midi: 57, durSec: 0.6 },
    { midi: 60, durSec: 3.6, vibrato: { rateHz: 5.5, extentCents: 50, delaySec: delay } },
  ];
  const make = (delay: number, lead: number): VoiceAnalysis => analyse(T.roomNoise(concat(silence(lead, SR), T.renderPhrase(phrase(delay), DEFAULT_TONE, { leadIn: 0, tail: 0.3, noiseRms: 0 })), 0.0012, 4), 'baritone');

  it('the start of the vibrato on a held note is read to within a quarter of a second', () => {
    const r = make(0.35, 0.15);
    const a = make(1.3, 2.4);
    const dRef = vibratoStartDelay(r, r.notes[r.notes.length - 1].start, r.notes[r.notes.length - 1].end);
    const dAtt = vibratoStartDelay(a, a.notes[a.notes.length - 1].start, a.notes[a.notes.length - 1].end);
    expect(Math.abs((dRef ?? 9) - 0.35)).toBeLessThan(0.25);
    expect(Math.abs((dAtt ?? 9) - 1.3)).toBeLessThan(0.25);
  });

  it('vibrato that starts a second later is told in words with the right size', () => {
    const r = make(0.35, 0.15);
    const a = make(1.3, 2.4);
    const c = comparePhrase(a, r, { mode: 'sing-along', rate: 1, refStartInCaptureSec: 2, keyMode: 'free' });
    const f = c.tone.find((t) => t.key === 'vibratoStart');
    expect(f, JSON.stringify(c.tone)).toBeDefined();
    expect(Math.abs((f?.diff ?? 0) - 0.95)).toBeLessThan(0.3);
  });
});

describe('tone findings use the same dead zones as the tone score', () => {
  it('airier and straighter: breathiness and vibrato are told; a clean copy tells nothing', () => {
    const airy = comparePhrase(sung({ notes: T.noVibrato(PH_A), key: -12, tone: { ...DEFAULT_TONE, breathNoise: 0.35, h1BoostDb: 6 } }), ref, along());
    expect(airy.tone.find((t) => t.key === 'breathiness')?.diff).toBeGreaterThanOrEqual(0.1);
    const vib = airy.tone.find((t) => t.key === 'vibratoPresence');
    expect(vib?.diff).toBeLessThan(-0.5);
    const clean = comparePhrase(sung({ notes: PH_A, key: -12 }), ref, turn);
    expect(clean.tone).toEqual([]);
  });

  it('a finding exists exactly when the tone score notices it (past the dead zone, key and microphone allowance included)', () => {
    for (const tone of [{ ...DEFAULT_TONE, tiltDbPerOct: -6 }, { ...DEFAULT_TONE, tiltDbPerOct: -9 }, { ...DEFAULT_TONE, breathNoise: 0.15 }]) {
      const c = comparePhrase(sung({ notes: PH_A, key: 0, tone }), ref, turn);
      const brightComp = c.score.components.find((x) => x.id === 'tone.brightness')?.score ?? 100;
      const f = c.tone.find((t) => t.key === 'brightness');
      if (f) expect(brightComp).toBeLessThan(100);
      else expect(brightComp).toBeGreaterThanOrEqual(99.9);
    }
  });

  it("a personal tone bias is taken out before the words are chosen (the same offset in both the score and the findings)", () => {
    const tone = { ...DEFAULT_TONE, tiltDbPerOct: -7 };
    const plain = comparePhrase(sung({ notes: PH_A, key: 0, tone }), ref, turn);
    const d = plain.tone.find((t) => t.key === 'brightness')?.diff;
    expect(d).toBeDefined();
    const biased = comparePhrase(sung({ notes: PH_A, key: 0, tone }), ref, turn, { toneBias: { brightness: d as number } });
    expect(biased.tone.find((t) => t.key === 'brightness')).toBeUndefined();
    expect(biased.scores.tone as number).toBeGreaterThan((plain.scores.tone as number) + 5);
  });

  it('the tone bias round-trips through the calibration record', () => {
    const cal = toneBiasToCalibration({ breathiness: 0.05, brightness: -0.04 });
    expect(cal).toEqual({ 'toneBias.breathiness': 0.05, 'toneBias.brightness': -0.04 });
    expect(toneBiasFromCalibration({ ...cal, other: 3, 'toneBias.rasp': Number.NaN })).toEqual({ breathiness: 0.05, brightness: -0.04 });
    expect(toneBiasFromCalibration(null)).toEqual({});
  });
});

describe('references that are mixes, speech, short or out of range', () => {
  it('a mix-derived reference: no tone, no dynamics, no attack; pitch, timing and expression remain, with a caution', () => {
    const mix: VoiceAnalysis = { ...ref, mode: 'mix' };
    const c = comparePhrase(sung({ notes: PH_A, key: -12, tone: { ...DEFAULT_TONE, tiltDbPerOct: -6, breathNoise: 0.3 } }), mix, turn);
    expect(c.score.status).toBe('ok');
    expect(c.scores.tone).toBeNull();
    expect(c.score.weights.tone).toBe(0);
    expect(c.score.weights.pitch + c.score.weights.timing + c.score.weights.expression).toBeCloseTo(1, 5);
    expect(c.score.components.some((x) => x.id === 'expr.dynamics' || x.id === 'expr.attack')).toBe(false);
    expect(c.score.trust.level).toBe('caution');
    expect(c.score.trust.reasons.join(' ')).toMatch(/full mix/);
    expect(c.tone.filter((t) => ['breathiness', 'brightness', 'rasp', 'level', 'onset', 'register'].includes(t.key))).toEqual([]);
  });

  it('a short phrase shows its overall rounded to the nearest 5, with the exact number kept in the score', () => {
    const short = refAnalysis(PH_SHORT);
    const notes = humanize(PH_SHORT, HUMAN.good, 7);
    const c = comparePhrase(attemptAnalysis({ notes, key: -3, lead: 1.2 }), short, turn);
    expect(c.score.diagnostics.shortPhrase).toBe(true);
    expect(c.scores.overall % 5).toBe(0);
    expect(Math.abs(c.scores.overall - (c.score.overall as number))).toBeLessThanOrEqual(2.5);
    expect(scoreIsRounded(c)).toBe(true);
    const long = comparePhrase(attemptAnalysis({ notes: person(), key: -3, lead: 1.2 }), ref, turn);
    expect(long.score.diagnostics.shortPhrase).toBe(false);
    expect(scoreIsRounded(long)).toBe(false);
    expect(long.scores.overall).toBe(long.score.overall);
  });

  it('rounding never rounds up to 100 below 98', () => {
    const base = comparePhrase(attemptAnalysis({ notes: PH_SHORT, key: 0, lead: 1 }), refAnalysis(PH_SHORT), turn).score;
    const fake = (overall: number) => scoresOf({ ...base, overall, diagnostics: { ...base.diagnostics, shortPhrase: true } }).overall;
    expect(fake(97.6)).toBe(95);
    expect(fake(98)).toBe(100);
    expect(fake(82)).toBe(80);
    expect(fake(83)).toBe(85);
  });

  it('a speech-like phrase is judged on rhythm and melody shape: no pitch figures per note, a caution', () => {
    const c = comparePhrase(attemptAnalysis({ notes: PH_A, key: -2, lead: 1.4 }), ref, turn, { forceSpeech: true });
    expect(c.score.kind).toBe('speech-like');
    expect(c.score.trust.reasons.join(' ')).toMatch(/speech-like/);
    expect(c.notes.every((n) => n.cents === null)).toBe(true);
    expect(c.notes.every((n) => flagsOf(n).length === 0)).toBe(true);
  });

  it('notes that fall under what the pitch tracker can follow in the singer\'s key are explained, with a way forward', () => {
    // A low voice's phrase (G2 to G3). Sung an octave lower its lowest notes fall under 65 Hz, where the tracker stops.
    const low = T.clone(PH_A).map((n) => ({ ...n, midi: n.midi - 8 }));
    const lowRef = refAnalysis(low, DEFAULT_TONE, 11, 'baritone');
    const c = comparePhrase(attemptAnalysis({ notes: low, key: -12, lead: 1.4, voiceType: 'baritone' }), lowRef, turn);
    const said = c.score.notes.join(' ');
    expect(said).toMatch(/outside the range the app can follow/);
    expect(said).toMatch(/C2/);
    expect(said).toMatch(/octave/);
    expect(c.score.trust.level).not.toBe('ok');
    expect(c.score.trust.reasons.join(' ')).toMatch(/outside the range/);
    expect(c.score.diagnostics.outOfRangeNotes).toBeGreaterThanOrEqual(1);
    // the notes nobody can hear are neither credited nor counted as missed: the take is judged on the rest
    const unhearable = new Set(untrackableNotes(lowRef, c.transposeSemitones));
    const coverageFix = c.score.fixes.find((f) => f.id === 'coverage');
    if (coverageFix) for (const k of coverageFix.notes) expect(unhearable.has(k), `note ${k} is out of range, not missed`).toBe(false);
    expect(c.coverage).toBeGreaterThan(0.85);
    // and the same phrase in a key that fits is not told anything about range
    const fine = comparePhrase(attemptAnalysis({ notes: low, key: 0, lead: 1.4, voiceType: 'baritone' }), lowRef, turn);
    expect(fine.score.notes.join(' ')).not.toMatch(/outside the range/);
    expect(fine.scores.overall).toBeGreaterThanOrEqual(98);
  }, 60_000);

  it('a take that cannot be tracked at all, of a low reference, says why and what to do', () => {
    const low = T.clone(PH_A).map((n) => ({ ...n, midi: n.midi - 16 }));
    const lowRef = refAnalysis(low, DEFAULT_TONE, 11, 'baritone');
    const c = comparePhrase(attemptAnalysis({ notes: low, key: -12, lead: 1.4, voiceType: 'baritone' }), lowRef, turn);
    if (c.score.status === 'ok') {
      expect(c.score.notes.join(' ')).toMatch(/outside the range/);
    } else {
      expect(c.score.notes.join(' ')).toMatch(/C2/);
      expect(c.score.notes.join(' ')).toMatch(/octave/);
    }
    expect(c.scores.overall).toBeLessThan(90);
  }, 60_000);

  it('an empty take is low evidence: no number, every note missed, the next step is named', () => {
    const c = comparePhrase(analyse(silence(3, SR)), ref, along());
    expect(c.score.status).toBe('low-evidence');
    expect(c.scores.overall).toBe(0);
    expect(c.notes.every((n) => n.flags.includes('missed') && !n.matched && n.cents === null)).toBe(true);
    expect(c.score.notes.join(' ')).toMatch(/microphone/i);
    expect(c.syncOffsetMs).toBeNull();
    expect(c.bleedSuspect).toBe(false);
  });

  it('a different melody is no-match: no per-note claims, no fixes, no tone', () => {
    const c = comparePhrase(attemptAnalysis({ notes: T.PH_RUN, lead: 1.5 }), ref, turn);
    expect(c.score.status).toBe('no-match');
    expect(c.scores.overall).toBeLessThanOrEqual(20);
    expect(c.notes.every((n) => !n.matched)).toBe(true);
    expect(c.score.fixes).toEqual([]);
    expect(c.tone).toEqual([]);
    expect(c.score.notes.join(' ')).toMatch(/right phrase/);
  });
});

describe('degenerate input', () => {
  it('an empty reference, an empty take and odd timing never throw and always say something', () => {
    const empty = analyse(silence(2, SR));
    const take = attemptAnalysis({ notes: PH_A, key: -2, lead: 1.4 });
    for (const [a, r] of [[take, empty], [empty, empty], [empty, ref]] as const) {
      const c = comparePhrase(a, r, along());
      expect(c.score.status).not.toBe('ok');
      expect(c.score.notes.length).toBeGreaterThan(0);
      expect(c.notes).toHaveLength(r.notes.length);
      expect(c.tone).toEqual([]);
      expect(c.scores.overall).toBeLessThanOrEqual(20);
    }
    // a rate that is not a number counts as 1; absurd ones are clamped to 0.25..1.5 (and then the take cannot match that speed)
    expect(comparePhrase(take, ref, { mode: 'turn-taking', rate: Number.NaN, keyMode: 'free' }).score.status).toBe('ok');
    for (const rate of [0, -1, 7]) {
      const c = comparePhrase(take, ref, { mode: 'turn-taking', rate, keyMode: 'free' });
      expect(Number.isFinite(c.scores.overall)).toBe(true);
      expect(c.score.notes.length).toBeGreaterThan(0);
    }
  });

  it('every number in a comparison is finite', () => {
    const c = comparePhrase(sung({ notes: T.detuneAll(PH_A, 30), key: -3 }), ref, along());
    const nums = [c.transposeSemitones, c.biasCents, c.coverage, c.withinFifty, c.extraNotes, ...Object.values(c.scores).filter((v): v is number => v !== null)];
    for (const n of c.notes) nums.push(...[n.cents, n.onsetMs, n.durationDeltaMs, n.levelDeltaDb, n.vibratoStartDeltaSec].filter((v): v is number => v !== null));
    for (const t of c.tone) nums.push(t.diff, t.strength);
    for (const v of nums) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('the reference leaking into the microphone', () => {
  it('a take that is the playback itself is flagged as bleed and invalid; the same audio with no guide playing is not', () => {
    const ph = T.renderPhrase(PH_A, undefined, { leadIn: 0.15, tail: 0.2, noiseRms: 0 });
    const r0 = analyse(T.roomNoise(ph, 0.0012, 3));
    const leaked = analyse(T.roomNoise(concat(silence(2.18, SR), ph, silence(0.6, SR)), 0.0012, 8));
    const c = comparePhrase(leaked, r0, along());
    expect(c.bleedSuspect).toBe(true);
    expect(c.score.trust.level).toBe('invalid');
    expect(comparePhrase(leaked, r0, turn).bleedSuspect).toBe(false);
  });

  it('a person following the guide, with natural scatter, is not flagged', () => {
    const c = comparePhrase(sung({ notes: humanize(PH_A, HUMAN.good, 4), key: -5 }), ref, along());
    expect(c.bleedSuspect).toBe(false);
    expect(c.score.trust.level).not.toBe('invalid');
  });
});

describe('the key', () => {
  it('own key or original key: the shift is the same and the detune is told, not marked down (free) or kept (locked)', () => {
    const notes = T.detuneConst(PH_A, 35);
    const a = attemptAnalysis({ notes, key: -5, lead: 1.4 });
    const free = comparePhrase(a, ref, turn);
    expect(free.transposeSemitones).toBe(-5);
    expect(Math.abs(free.biasCents - 35)).toBeLessThan(10);
    expect(free.scores.overall).toBeGreaterThanOrEqual(97);
    const locked = comparePhrase(a, ref, { ...turn, keyMode: 'locked' });
    expect(locked.scores.pitch).toBeLessThan(free.scores.pitch);
    expect(locked.score.notes.join(' ')).toMatch(/5 semitones? below the original key/);
  });

  it('with a transposed guide playing, the guide\'s key is the right one in locked mode (and an octave of it)', () => {
    const inGuideKey = attemptAnalysis({ notes: humanize(PH_A, HUMAN.pro, 6), key: -3, lead: 1.4 });
    const followed = comparePhrase(inGuideKey, ref, { mode: 'turn-taking', rate: 1, keyMode: 'locked' }, { guideShift: -3 });
    expect(followed.transposeSemitones).toBe(-3);
    expect(followed.scores.pitch).toBeGreaterThanOrEqual(92);
    expect(followed.score.notes.join(' ')).not.toMatch(/wrong notes/);
    const ignored = comparePhrase(inGuideKey, ref, { mode: 'turn-taking', rate: 1, keyMode: 'locked' });
    expect(ignored.scores.pitch).toBeLessThan(followed.scores.pitch - 40);
    expect(ignored.score.notes.join(' ')).toMatch(/original key/);
    const octave = comparePhrase(attemptAnalysis({ notes: humanize(PH_A, HUMAN.pro, 6), key: -15, lead: 1.4 }), ref, { mode: 'turn-taking', rate: 1, keyMode: 'locked' }, { guideShift: -3 });
    expect(octave.scores.pitch).toBeGreaterThanOrEqual(90);
    // singing the original key to a guide moved by -3 is told in terms of the guide's key
    const wrongKey = comparePhrase(attemptAnalysis({ notes: humanize(PH_A, HUMAN.pro, 6), key: 0, lead: 1.4 }), ref, { mode: 'turn-taking', rate: 1, keyMode: 'locked' }, { guideShift: -3 });
    expect(wrongKey.scores.pitch).toBeLessThan(60);
    expect(wrongKey.score.notes.join(' ')).toMatch(/guide's key/);
  }, 60_000);

  it('transposeHint narrows the key search to hint +/- 1 in the underlying alignment', () => {
    const att = attemptAnalysis({ notes: PH_A, key: -12, lead: 3.4 });
    expect(compareToReference(att, ref, { transposeHint: -12 }).transposeSemitones).toBe(-12);
    // A wrong hint is honoured by the first guess (the hint is a safety net against octave flips, so callers pass the last good shift only).
    expect(Math.abs(compareToReference(att, ref, { transposeHint: 0 }).transposeSemitones)).toBeLessThanOrEqual(1);
    expect(comparePhrase(att, ref, turn, { transposeHint: -12 }).transposeSemitones).toBe(-12);
  });

  it('a subharmonic-rich take flips the unhinted key guess; the hint and the scorer keep it at -12', () => {
    const att = attemptAnalysis({ notes: PH_A, key: -12, lead: 0.4, tone: { ...DEFAULT_TONE, subharmonic: 0.35 } });
    const hinted = comparePhrase(att, ref, turn, { transposeHint: -12 });
    expect(hinted.transposeSemitones).toBe(-12);
  });
});

describe('real a cappella singing, re-timed and re-pitched with PSOLA (clips outside the repository)', () => {
  it.skipIf(!hasRealVoice('vocadito10.wav'))('key found exactly, detune within 6 cents, sync within 30 ms, a copy scores high', () => {
    const w = loadRealVoice('vocadito10.wav', 30);
    const x = T.toAnalysisRate(w.samples, w.sampleRate);
    const refReal = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)));
    const cases: [string, number, number][] = [['self copy', 0, 0], ['+7', 7, 0], ['-5', -5, 0], ['+35 cents', 0, 35]];
    for (const [label, semis, cents] of cases) {
      const y = T.psolaHQ(x, { durationSec: x.length / SR, timeMap: (t) => t, pitchFactor: () => T.centsToFactor(semis * 100 + cents) });
      const take = analyse(T.roomNoise(concat(silence(COUNTIN + 0.15 + 0.2, SR), y, silence(0.5, SR)), 0.0012, 9));
      const c = comparePhrase(take, refReal, along());
      expect(c.transposeSemitones, label).toBe(semis);
      expect(Math.abs(c.biasCents - cents), label).toBeLessThan(8);
      expect(Math.abs((c.syncOffsetMs ?? 999) - 200), label).toBeLessThan(40);
      expect(c.scores.overall, label).toBeGreaterThanOrEqual(85);
    }
  }, 180_000);

  it.skipIf(!hasRealVoice('vocadito10.wav'))('an octave down puts the low notes under the tracker: it is explained, not scored as garbage', () => {
    const w = loadRealVoice('vocadito10.wav', 30);
    const x = T.toAnalysisRate(w.samples, w.sampleRate);
    const refReal = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)));
    const y = T.psolaHQ(x, { durationSec: x.length / SR, timeMap: (t) => t, pitchFactor: () => 0.5 });
    const take = analyse(T.roomNoise(concat(silence(1.4, SR), y, silence(0.5, SR)), 0.0012, 9));
    const c = comparePhrase(take, refReal, turn);
    const said = c.score.notes.join(' ');
    if (c.score.status === 'ok' && c.scores.overall >= 85) {
      // the tracker coped: then nothing needs explaining
      expect(c.transposeSemitones).toBe(-12);
    } else {
      expect(said).toMatch(/octave/i);
      expect(said).toMatch(/C2|range/);
    }
  }, 180_000);
});
