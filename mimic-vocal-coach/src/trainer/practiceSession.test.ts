import { describe, expect, it } from 'vitest';
import { RecorderError } from '../audio/recorder';
import { makeFakePhraseComparison } from '../testing/trainerFixtures';
import type { StyleVector } from '../types';
import type { ClickProbe } from './latency';
import {
  blendLatency,
  buildAttemptRecord,
  COPY,
  countInDisplay,
  flavourOf,
  interruptionMessage,
  isAbort,
  judgeTake,
  keyLooksUnclear,
  LEAD_KEEP_SEC,
  medianOfRecent,
  microphoneMessage,
  octaveFold,
  trimTake,
  withTrust,
  wrongNoteCount,
} from './practiceSession';

const SR = 1000;
const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i);

describe('trimTake', () => {
  it('sing-along: cuts the room tone and the clicks, keeps a little before the guide, and re-bases the guide start', () => {
    const t = trimTake({ samples: ramp(10_000), sampleRate: SR, refStartInCaptureSec: 2.25, guideEndInCaptureSec: 9 }, 'sing-along');
    expect(t.cutSec).toBeCloseTo(2.25 - LEAD_KEEP_SEC, 6);
    expect(t.samples[0]).toBe(Math.round((2.25 - LEAD_KEEP_SEC) * SR));
    expect(t.refStartSec).toBeCloseTo(LEAD_KEEP_SEC, 6);
    expect(t.samples.length).toBe(10_000 - 1950);
  });

  it('sing-along with the guide starting right away keeps everything', () => {
    const t = trimTake({ samples: ramp(500), sampleRate: SR, refStartInCaptureSec: 0.1, guideEndInCaptureSec: 5 }, 'sing-along');
    expect(t.cutSec).toBe(0);
    expect(t.samples.length).toBe(500);
    expect(t.refStartSec).toBeCloseTo(0.1, 6);
  });

  it('turn-taking: everything up to the end of the guide is the guide leaking in, so it is cut; there is no guide start', () => {
    const t = trimTake({ samples: ramp(10_000), sampleRate: SR, refStartInCaptureSec: null, guideEndInCaptureSec: 6.5 }, 'turn-taking');
    expect(t.cutSec).toBe(6.5);
    expect(t.samples.length).toBe(3500);
    expect(t.samples[0]).toBe(6500);
    expect(t.refStartSec).toBeUndefined();
  });

  it('a guide end beyond the recording leaves an empty take (the scorer then says there was not enough singing)', () => {
    const t = trimTake({ samples: ramp(100), sampleRate: SR, refStartInCaptureSec: null, guideEndInCaptureSec: 50 }, 'turn-taking');
    expect(t.samples.length).toBe(0);
  });

  it('missing or non-finite timing cuts nothing', () => {
    expect(trimTake({ samples: ramp(100), sampleRate: SR, refStartInCaptureSec: null, guideEndInCaptureSec: null }, 'sing-along').samples.length).toBe(100);
    expect(trimTake({ samples: ramp(100), sampleRate: SR, refStartInCaptureSec: Number.NaN, guideEndInCaptureSec: Number.NaN }, 'turn-taking').samples.length).toBe(100);
  });
});

describe('countInDisplay', () => {
  it('counts 3, 2, 1 on the clicks and never leaves 1..beats', () => {
    const pre = 0.45;
    const beat = 0.6;
    const at = (t: number): number => countInDisplay(t, 3, pre, beat);
    expect(at(0)).toBe(3);
    expect(at(0.449)).toBe(3);
    expect(at(0.45)).toBe(3); // the first click
    expect(at(0.45 + 0.59)).toBe(3);
    expect(at(0.45 + 0.61)).toBe(2);
    expect(at(0.45 + 1.21)).toBe(1);
    expect(at(0.45 + 1.79)).toBe(1);
    expect(at(10)).toBe(1);
    expect(at(-1)).toBe(3);
  });
});

describe('live pitch helpers', () => {
  it('octaveFold moves a note by octaves to the nearest one to the target', () => {
    expect(octaveFold(48, 60)).toBe(60);
    expect(octaveFold(72.3, 60)).toBeCloseTo(60.3, 6);
    expect(octaveFold(61, 60)).toBe(61);
  });

  it('medianOfRecent ignores a single octave flick and goes quiet when most readings are unvoiced', () => {
    expect(medianOfRecent([60, 72, 60])).toBe(60);
    expect(medianOfRecent([60, null, null])).toBeNull();
    expect(medianOfRecent([null, 61, 60])).toBe(61);
    expect(medianOfRecent([])).toBeNull();
  });
});

describe('words', () => {
  it('every interruption names what to tap next, in the words of a take or of playback', () => {
    for (const reason of ['audio-session', 'hidden', 'mic-ended', 'device-change', 'no-audio', null, undefined] as const) {
      expect(interruptionMessage(reason, 'take')).toMatch(/not scored/);
      expect(interruptionMessage(reason, 'take')).toMatch(/tap Sing/);
      expect(interruptionMessage(reason, 'playback')).toMatch(/tap Listen/);
      expect(interruptionMessage(reason, 'playback')).not.toMatch(/Sing/);
    }
    expect(interruptionMessage('hidden', 'take')).toMatch(/background/);
    expect(interruptionMessage('no-audio', 'take')).toMatch(/allowed to use it/);
  });

  it('microphone errors say Listen still works unless the browser cannot record at all', () => {
    expect(microphoneMessage(new RecorderError('denied', 'Microphone access was blocked.'))).toMatch(/Listen/);
    expect(microphoneMessage(new RecorderError('no-device', 'No microphone was found.'))).toMatch(/Listen/);
    expect(microphoneMessage(new RecorderError('unsupported', 'This browser does not give web pages microphone access.'))).toBe('This browser does not give web pages microphone access.');
    expect(microphoneMessage(new Error('boom'))).toMatch(/boom.*tap Sing/);
    expect(microphoneMessage('weird')).toMatch(/unknown reason/);
  });

  it('flavourOf maps the three singers and anything else is generic', () => {
    expect(flavourOf('shawn-mendes')).toBe('shawn');
    expect(flavourOf('daniel-caesar')).toBe('daniel');
    expect(flavourOf('jalen-ngonda')).toBe('jalen');
    expect(flavourOf(null)).toBe('generic');
    expect(flavourOf('someone')).toBe('generic');
  });

  it('isAbort recognises an AbortError by name', () => {
    expect(isAbort(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
    expect(isAbort(null)).toBe(false);
  });
});

const probe = (over: Partial<ClickProbe> = {}): ClickProbe => ({ bleed: false, roundTripMs: null, clickOverFloorDb: 0, floorDb: -70, clicksHeard: 0, clicksTried: 3, peakDb: -Infinity, spreadMs: null, consistent: false, ...over });
const leaking = probe({ bleed: true, roundTripMs: 120, clicksHeard: 3, peakDb: -30, spreadMs: 2, consistent: true });

describe('judgeTake', () => {
  const base = { mode: 'sing-along' as const, probe: null, headphonesLikely: true, keyHint: null, voicedSec: 6 };

  it('a good take counts and has no notice', () => {
    const v = judgeTake({ ...base, comparison: makeFakePhraseComparison('perfect') });
    expect(v).toMatchObject({ countable: true, notice: null });
    expect(v.comparison.score.trust.level).toBe(makeFakePhraseComparison('perfect').score.trust.level);
  });

  it('no-match and low-evidence are never counted, and say what to do', () => {
    const noMatch = judgeTake({ ...base, comparison: makeFakePhraseComparison('no-match') });
    expect(noMatch).toMatchObject({ countable: false, notice: COPY.noMatch });
    const c = makeFakePhraseComparison('perfect');
    const low = { ...c, score: { ...c.score, status: 'low-evidence' as const, overall: null } };
    expect(judgeTake({ ...base, comparison: low })).toMatchObject({ countable: false, notice: COPY.lowEvidence });
    expect(judgeTake({ ...base, comparison: low, voicedSec: 0.1 })).toMatchObject({ countable: false, notice: COPY.nothingHeard });
  });

  it('a reference with too little singing is said to be the phrase\'s problem, not the singer\'s', () => {
    const c = makeFakePhraseComparison('perfect');
    const low = { ...c, score: { ...c.score, status: 'low-evidence' as const, overall: null } };
    const v = judgeTake({ ...base, comparison: low, referenceUsable: false });
    expect(v).toMatchObject({ countable: false, notice: COPY.referenceTooShort });
    expect(v.notice).toMatch(/Edit the clip's phrases/);
  });

  it('the scorer\'s note about the range below C2 is kept next to the words for a take that did not match', () => {
    const c = makeFakePhraseComparison('no-match');
    const hint = 'If you sang this lower than the original: the app cannot follow pitches below about C2 (65 Hz), and this phrase would go below that an octave down.';
    const v = judgeTake({ ...base, comparison: { ...c, score: { ...c.score, notes: ['Nothing lines up.', hint] } } });
    expect(v.notice).toContain(COPY.noMatch);
    expect(v.notice).toContain('below about C2');
  });

  it('a take that sounds like the playback is never counted, and its trust is invalid', () => {
    const c = { ...makeFakePhraseComparison('perfect'), bleedSuspect: true };
    const v = judgeTake({ ...base, comparison: c });
    expect(v).toMatchObject({ countable: false, notice: COPY.bleedSuspect });
    expect(v.comparison.score.trust.level).toBe('invalid');
    expect(v.comparison.bleedSuspect).toBe(true);
  });

  it('clicks heard in the microphone: not counted without headphones, doubted on headphones, ignored when the guide is not playing during the take', () => {
    const c = makeFakePhraseComparison('perfect');
    expect(judgeTake({ ...base, comparison: c, probe: leaking, headphonesLikely: false })).toMatchObject({ countable: false, notice: COPY.speakerBleed });
    const caution = judgeTake({ ...base, comparison: c, probe: leaking });
    expect(caution).toMatchObject({ countable: true, notice: COPY.leakCaution });
    expect(caution.comparison.score.trust.level).toBe('caution');
    expect(judgeTake({ ...base, comparison: c, probe: leaking, mode: 'turn-taking', headphonesLikely: false })).toMatchObject({ countable: true, notice: null });
    // a hum that crossed the gate once is not a leak
    expect(judgeTake({ ...base, comparison: c, probe: probe({ bleed: true, consistent: false, clicksHeard: 2 }), headphonesLikely: false })).toMatchObject({ countable: true, notice: null });
  });

  it('a key that is not the last one and little matched is counted but flagged', () => {
    const partial = { ...makeFakePhraseComparison('partial'), transposeSemitones: 0, coverage: 0.5 };
    const v = judgeTake({ ...base, comparison: partial, keyHint: 7 });
    expect(v.countable).toBe(true);
    expect(v.notice).toBe(COPY.unclearKey(7, 0));
    expect(v.notice).toMatch(/7 semitones above the original last time/);
    expect(v.notice).toMatch(/the original key this time/);
  });
});

describe('keyLooksUnclear', () => {
  it('needs a remembered key that is not an octave away and a low coverage', () => {
    const c = (t: number, cov: number) => ({ transposeSemitones: t, coverage: cov });
    expect(keyLooksUnclear(c(0, 0.5), null)).toBe(false);
    expect(keyLooksUnclear(c(0, 0.5), 7)).toBe(true);
    expect(keyLooksUnclear(c(0, 0.9), 7)).toBe(false);
    expect(keyLooksUnclear(c(-12, 0.5), 0)).toBe(false);
    expect(keyLooksUnclear(c(12, 0.5), -12)).toBe(false);
    expect(keyLooksUnclear(c(-5, 0.5), 7)).toBe(false); // an octave and the same pitch class
    expect(keyLooksUnclear(c(-13, 0.5), 0)).toBe(true);
  });
});

describe('withTrust', () => {
  it('lowers the trust, never raises it, and does not repeat a reason', () => {
    const c = makeFakePhraseComparison('perfect');
    const invalid = withTrust(c, 'invalid', 'x');
    expect(invalid.score.trust.level).toBe('invalid');
    expect(withTrust(invalid, 'caution', 'y').score.trust.level).toBe('invalid');
    expect(withTrust(withTrust(c, 'caution', 'x'), 'caution', 'x').score.trust.reasons.filter((r) => r === 'x')).toHaveLength(1);
    expect(c.score.trust.level).not.toBe('invalid'); // the input is not mutated
  });
});

describe('buildAttemptRecord', () => {
  it('copies the scorer\'s numbers and counts wrong notes the way the sheet does', () => {
    const c = makeFakePhraseComparison('wrong-note', { shift: -12 });
    const a = buildAttemptRecord({ id: 'a1', at: 5, clipId: 'c', phraseId: 'p', mode: 'sing-along', keyMode: 'locked', rate: 0.75, comparison: c, routeKind: 'wired', style: {} as StyleVector, fixes: [] });
    expect(a).toMatchObject({ id: 'a1', at: 5, clipId: 'c', phraseId: 'p', mode: 'sing-along', keyMode: 'locked', rate: 0.75, route: 'wired', transposeSemitones: -12, hasAudio: false, analysisVersion: 1 });
    expect(a.scores).toEqual({ overall: c.scores.overall, pitch: c.scores.pitch, timing: c.scores.timing, tone: c.scores.tone, expression: c.scores.expression });
    expect(a.trust).toBe(c.score.trust.level);
    expect(a.wrongNotes).toBe(wrongNoteCount(c));
    expect(a.wrongNotes).toBeGreaterThan(0);
    expect(a.notes).toHaveLength(c.notes.length);
    expect(a.notes.every((n) => n.cents === null || Number.isInteger(n.cents))).toBe(true);
    expect(a.coverage).toBe(c.coverage);
  });
});

describe('blendLatency', () => {
  it('starts from the reading, nudges toward a new one, and jumps when the route clearly changed', () => {
    expect(blendLatency(undefined, 119.6)).toBe(120);
    expect(blendLatency(120, 138)).toBe(126);
    expect(blendLatency(120, 300)).toBe(300);
    expect(blendLatency(0, 50)).toBe(50);
    expect(blendLatency(Number.NaN, 80)).toBe(80);
  });
});
