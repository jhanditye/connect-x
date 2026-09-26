import { describe, expect, it } from 'vitest';
import { concat, silence, synthMelody, synthVoice } from '../testing/synth';
import { analyzeTake } from './analyze';
import { tuningOffsetCents } from './notes';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };
const pad = () => silence(0.3, SR);

describe('tuningOffsetCents', () => {
  it('is the duration-weighted circular mean of the deviations', () => {
    expect(tuningOffsetCents([{ midi: 60.1, duration: 1 }, { midi: 62.1, duration: 1 }])).toBeCloseTo(10, 5);
    // -45 and +45 cents are 10 cents apart across the semitone boundary: the mean is +/-50.
    expect(Math.abs(tuningOffsetCents([{ midi: 59.55, duration: 1 }, { midi: 61.45, duration: 1 }]))).toBeCloseTo(50, 3);
    expect(tuningOffsetCents([{ midi: 60.2, duration: 3 }, { midi: 62, duration: 1 }])).toBeGreaterThan(10);
    expect(tuningOffsetCents([{ midi: 60.3, duration: 0.5 }])).toBe(0);
    expect(tuningOffsetCents([])).toBe(0);
  });
});

describe('note segmentation', () => {
  it('finds each note of a legato scale with its pitch', () => {
    const scale = [55, 57, 59, 60, 62, 60, 59, 57];
    const x = concat(pad(), synthMelody(scale.map((midi) => ({ midi, durSec: 0.5 })), { sampleRate: SR }), pad());
    const a = analyzeTake(x, SR, OPTS);
    expect(a.notes.map((n) => n.nearestMidi)).toEqual(scale);
    for (const n of a.notes) {
      expect(Math.abs(n.centsOff)).toBeLessThan(5);
      expect(n.end - n.start).toBeGreaterThan(0.35);
      expect(Number.isFinite(n.meanRmsDb)).toBe(true);
    }
    expect(a.phrases).toHaveLength(1);
  });

  it('keeps a held note with wide vibrato as one note', () => {
    const x = concat(pad(), synthVoice({ sampleRate: SR, durationSec: 2.5, f0: 196, vibrato: { rateHz: 5, extentCents: 100 } }), pad());
    const a = analyzeTake(x, SR, OPTS);
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0].nearestMidi).toBe(55);
  });

  it('reports a consistently sharp singer through the tuning offset, not note errors', () => {
    const melody = [55, 57, 59, 57, 55, 59].map((m) => ({ midi: m + 0.3, durSec: 0.5 }));
    const x = concat(pad(), synthMelody(melody, { sampleRate: SR }), pad());
    const a = analyzeTake(x, SR, OPTS);
    expect(a.pitch.tuningOffsetCents).toBeGreaterThan(25);
    expect(a.pitch.tuningOffsetCents).toBeLessThan(35);
    expect(a.notes.map((n) => n.nearestMidi)).toEqual([55, 57, 59, 57, 55, 59]);
    for (const n of a.notes) expect(Math.abs(n.centsOff)).toBeLessThan(6);
  });

  it('measures individual tuning errors after the global correction', () => {
    const offsets = [0, 20, -20, 0, 0, 0];
    const melody = [55, 57, 59, 60, 59, 57].map((m, i) => ({ midi: m + offsets[i] / 100, durSec: 0.5 }));
    const x = concat(pad(), synthMelody(melody, { sampleRate: SR }), pad());
    const a = analyzeTake(x, SR, OPTS);
    const cents = a.notes.map((n) => n.centsOff);
    expect(cents[1]).toBeGreaterThan(14);
    expect(cents[2]).toBeLessThan(-14);
    expect(a.style.pitchAccuracyCents).toBeGreaterThan(4);
    expect(a.style.pitchAccuracyCents).toBeLessThan(12);
  });

  it('splits phrases at breaths but not at short gaps', () => {
    const note = (midi: number) => synthMelody([{ midi, durSec: 0.6 }], { sampleRate: SR });
    const x = concat(pad(), note(57), silence(0.12, SR), note(59), silence(0.6, SR), note(60), pad());
    const a = analyzeTake(x, SR, OPTS);
    expect(a.phrases).toHaveLength(2);
    expect(a.notes.length).toBe(3);
    expect(a.phrases[1].start).toBeGreaterThan(a.phrases[0].end + 0.4);
  });
});
