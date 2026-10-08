// A reference made from a full song can contain the band: it then has more notes than the singer sang. The score must say so
// ("rough guide"), not blame the singer for notes nobody was meant to sing, and a take against an uncertain reference is not counted.
// The mixes are synthetic (testing/songMix.ts): a sung line over chords, bass, arpeggio and drums at a chosen vocal-to-band level.
import { describe, expect, it } from 'vitest';
import { analyzeTake } from '../../analysis/analyze';
import { makeSongStems, mixSong } from '../../testing/songMix';
import { concat, silence } from '../../testing/synth';
import type { VoiceAnalysis } from '../../types';
import { comparePhrase } from '../compare';
import { buildFixes } from '../feedback';
import { segmentPhrases } from '../segment';
import { scoreAttempt } from './score';
import { DEFAULT_TONE, PH_A, SR as TESTKIT_SR, analyse, attemptAnalysis, refAnalysis, renderPhrase, roomNoise, sliceNotes, wrongNote } from './testkit';

const SR = 22050;
/** The two sung lines of the synthetic song (songMix.ts), as [midi, seconds]. */
const LINES = [
  { start: 0.5, notes: [[57, 0.9], [60, 0.5], [64, 0.6], [62, 0.9], [60, 0.6], [57, 0.7], [55, 0.8], [57, 1.5]] },
  { start: 9, notes: [[59, 0.8], [62, 0.6], [64, 0.9], [67, 0.7], [64, 0.6], [62, 0.8], [60, 0.6], [57, 1.6]] },
];
interface Sung { t0: number; t1: number; midi: number }
function truth(): Sung[] {
  const out: Sung[] = [];
  for (const ln of LINES) {
    let t = ln.start;
    for (const [m, d] of ln.notes) {
      out.push({ t0: t, t1: t + d, midi: m });
      t += d;
    }
  }
  return out;
}
/** A singer who sings the given notes (a different synthetic voice from the song's). */
const singer = (part: Sung[]): VoiceAnalysis =>
  analyse(roomNoise(concat(silence(1.6, SR), renderPhrase(part.map((n) => ({ midi: n.midi, durSec: n.t1 - n.t0 })), DEFAULT_TONE, { seed: 77, leadIn: 0, tail: 0, noiseRms: 0 }), silence(0.6, SR)), 0.0012, 82));
const turn = { mode: 'turn-taking' as const, rate: 1, keyMode: 'free' as const };

/** Per-note claims: the fixes a rough guide must not make, because the note they name may belong to the band. */
const PER_NOTE_FIX = /^(coverage|pitch\.(wrong-notes|flat|sharp|leaps)|timing\.(late|early|entrances|short-notes|long-notes))$/;

describe('a full-song reference that has more notes than were sung', () => {
  const stems = makeSongStems({ transpose: 0 });
  const sung = truth();
  for (const db of [0, -3, -6]) {
    it(`vocal ${db} dB against the band: a near-exact copy is never blamed for the band's notes; a half-sung take still is told to finish`, () => {
      const mono = mixSong(stems, db).mono;
      const clip = analyzeTake(mono, SR, { voiceType: 'tenor', mode: 'mix' });
      let judged = 0;
      for (const p of segmentPhrases(clip).filter((q) => !q.fragment)) {
        const ref = analyzeTake(mono.slice(Math.round(p.start * SR), Math.round(p.end * SR)), SR, { voiceType: 'tenor', mode: 'mix' });
        const part = sung.filter((n) => n.t0 >= p.voicedStart - 0.3 && n.t1 <= p.voicedEnd + 0.5);
        if (part.length < 6) continue;
        judged++;
        const exact = comparePhrase(singer(part), ref, turn);
        const s = exact.score;
        if (s.diagnostics.roughGuide === true) {
          // labelled, with the plain caution, and nothing said about single notes
          expect(s.trust.level).not.toBe('ok');
          expect(s.trust.reasons.join(' ')).toMatch(/rough guide/);
          expect(s.fixes.map((f) => f.id).filter((id) => PER_NOTE_FIX.test(id)), `${db} dB phrase ${p.start}`).toEqual([]);
          expect(buildFixes(exact).map((f) => f.id)).not.toContain('coverage');
          if (s.status === 'no-match') expect(s.diagnostics.noMatchWhy).toBe('rough-reference');
          else expect(s.overall as number, `${db} dB phrase ${p.start}`).toBeGreaterThanOrEqual(65);
        } else if (s.status === 'ok') {
          expect(s.overall as number, `${db} dB phrase ${p.start}`).toBeGreaterThanOrEqual(80);
        }
        // a half-sung take is short on the original's span: whatever the reference is, nothing is forgiven and it is told to finish the phrase
        const half = comparePhrase(singer(part.slice(0, Math.floor(part.length / 2))), ref, turn);
        if (half.score.status === 'ok') {
          expect(half.score.fixes.map((f) => f.id), `half ${db} dB`).toContain('coverage');
          expect(half.score.overall as number).toBeLessThan(75);
        }
      }
      expect(judged).toBeGreaterThanOrEqual(1);
    }, 120_000);
  }
});

describe('an uncertain reference (low extractor confidence)', () => {
  const base = refAnalysis(PH_A);
  const withConfidence = (c: number): VoiceAnalysis => ({ ...base, mode: 'mix', leadExtraction: { confidence: c, sideToMidDb: null } } as VoiceAnalysis);
  const exact = attemptAnalysis({ notes: PH_A, seed: 77, lead: 1.6 });

  it('is a rough guide that is not counted toward mastery, and says so; a confident one is neither', () => {
    const low = scoreAttempt(withConfidence(0.7), exact);
    expect(low.diagnostics.roughGuide).toBe(true);
    expect(low.diagnostics.refLowConfidence).toBe(true);
    expect(low.diagnostics.refConfidence).toBe(0.7);
    expect(low.trust.reasons.join(' ')).toMatch(/uncertain.*rough guide.*not counted toward mastery/);
    expect(low.trust.level).toBe('caution');
    // the score itself is still the closeness of pitch and timing (a perfect copy of the extracted melody)
    expect(low.status).toBe('ok');
    expect(low.overall as number).toBeGreaterThanOrEqual(95);
    const fine = scoreAttempt(withConfidence(0.92), exact);
    expect(fine.diagnostics.roughGuide).toBe(false);
    expect(fine.diagnostics.refLowConfidence).toBe(false);
    expect(fine.trust.reasons.join(' ')).toMatch(/full mix/);
    expect(fine.trust.reasons.join(' ')).not.toMatch(/rough guide/);
  }, 60_000);

  it('a reference without a confidence (a solo clip) is never low-confidence', () => {
    const solo = scoreAttempt(base, exact);
    expect(solo.diagnostics.roughGuide).toBe(false);
    expect(solo.diagnostics.refConfidence).toBeNull();
    expect(TESTKIT_SR).toBe(SR);
  }, 60_000);
});

describe('notes the extractor doubts (leadExtraction.noteTrust)', () => {
  const base = refAnalysis(PH_A);
  const withTrust = (trust: number[], extra: Record<string, unknown> = {}): VoiceAnalysis =>
    ({ ...base, mode: 'mix', leadExtraction: { confidence: 0.92, sideToMidDb: null, noteTrust: trust, trustedNotes: trust.reduce((a, b) => a + b, 0), purity: 0.85, roughGuide: false, ...extra } }) as VoiceAnalysis;
  const sure = base.notes.map(() => 0.95);
  const doubtfulAt = (...ks: number[]): number[] => sure.map((t, k) => (ks.includes(k) ? 0.1 : t));

  it('a take that ends before notes the extractor doubts is not told it missed them; the same gap against trusted notes is', () => {
    // the first 8 of 11 notes: two thirds of the phrase, so the doubt about the last three is the extractor's, not an excuse for stopping
    const att = attemptAnalysis({ notes: sliceNotes(PH_A, 0, 8), seed: 77, lead: 1.6 });
    const trusted = scoreAttempt(withTrust(sure), att);
    expect(trusted.fixes.map((f) => f.id)).toContain('coverage');
    const doubted = scoreAttempt(withTrust(doubtfulAt(8, 9, 10)), att);
    expect(doubted.fixes.map((f) => f.id)).not.toContain('coverage');
    expect(doubted.coverage).toBeGreaterThan(trusted.coverage);
    expect(doubted.coverage).toBeGreaterThan(0.9);
    expect(doubted.diagnostics.doubtfulNotes).toBe(3);
  }, 60_000);

  it('...but a take that stops halfway is told so, whatever the extractor thinks of the notes it did not get to', () => {
    const att = attemptAnalysis({ notes: sliceNotes(PH_A, 0, 6), seed: 77, lead: 1.6 });
    const r = scoreAttempt(withTrust(doubtfulAt(6, 7, 8, 9, 10)), att);
    expect(r.fixes.map((f) => f.id)).toContain('coverage');
    expect(r.coverage).toBeLessThan(0.7);
    expect(r.diagnostics.doubtfulNotes).toBe(0);
  }, 60_000);

  it('a far-off answer to a doubtful note is not a wrong note; to a trusted note it is', () => {
    const att = attemptAnalysis({ notes: wrongNote(PH_A, 2, 2), seed: 77, lead: 1.6 });
    expect(scoreAttempt(withTrust(sure), att).fixes.map((f) => f.id)).toContain('pitch.wrong-notes');
    const doubted = scoreAttempt(withTrust(doubtfulAt(2)), att);
    expect(doubted.fixes.map((f) => f.id)).not.toContain('pitch.wrong-notes');
    expect(doubted.perNote[2].flags).not.toContain('wrong-note');
  }, 60_000);

  it('the extractor saying "rough guide" (too much of the line is the band) makes the reference one even when its confidence is high', () => {
    const att = attemptAnalysis({ notes: PH_A, seed: 77, lead: 1.6 });
    const r = scoreAttempt(withTrust(sure, { purity: 0.5, roughGuide: true }), att);
    expect(r.diagnostics.roughGuide).toBe(true);
    expect(r.diagnostics.refLowConfidence).toBe(true);
    expect(r.diagnostics.refPurity).toBe(0.5);
    expect(r.trust.reasons.join(' ')).toMatch(/rough guide/);
  }, 60_000);
});
