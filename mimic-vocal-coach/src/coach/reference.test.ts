import { describe, expect, it } from 'vitest';
import { compareToReference, describeStyleTraits, profileFromReference, REFERENCE_PROFILE_COLOR } from './reference';
import { makeFakeAnalysis, makeFakeProfile } from '../testing/fixtures';
import { makeRng } from '../testing/synth';
import type { FrameFeatures, Phrase, VoiceAnalysis } from '../types';

interface Transform {
  /** Semitones added to every voiced frame. */
  shift?: number;
  /** Time-stretch factor (> 1 = user slower). */
  stretch?: number;
  /** Extra cents added to frames whose ORIGINAL time lies in [start, end). */
  offset?: { start: number; end: number; cents: number };
}

function withMidi(f: FrameFeatures, midi: number): FrameFeatures {
  return { ...f, midi, f0: Number.isFinite(midi) ? 440 * Math.pow(2, (midi - 69) / 12) : NaN };
}

/** Derive a "user take" from an analysis by transposing, re-timing and detuning its frames. */
function transform(a: VoiceAnalysis, tr: Transform): VoiceAnalysis {
  const shift = tr.shift ?? 0;
  const stretch = tr.stretch ?? 1;
  const n = Math.round(a.frames.length * stretch);
  const frames: FrameFeatures[] = [];
  for (let k = 0; k < n; k++) {
    const src = a.frames[Math.min(a.frames.length - 1, Math.round(k / stretch))];
    let midi = src.midi + shift;
    if (tr.offset && src.t >= tr.offset.start && src.t < tr.offset.end) midi += tr.offset.cents / 100;
    frames.push({ ...withMidi(src, midi), t: k * a.hopSec });
  }
  const scale = (p: Phrase): Phrase => ({ start: p.start * stretch, end: p.end * stretch });
  return { ...a, frames, durationSec: a.durationSec * stretch, phrases: a.phrases.map(scale) };
}

/** Cut the analysis to [start, end) seconds and re-time it to start at 0. */
function excerpt(a: VoiceAnalysis, start: number, end: number): VoiceAnalysis {
  const frames = a.frames.filter((f) => f.t >= start && f.t < end).map((f) => ({ ...f, t: f.t - start }));
  const phrases = a.phrases
    .filter((p) => p.end > start && p.start < end)
    .map((p) => ({ start: Math.max(0, p.start - start), end: Math.min(end, p.end) - start }));
  return { ...a, frames, durationSec: end - start, phrases };
}

/** A long take with a random (seeded) melody: notes of 0.2-0.8 s, short gaps, vibrato on long notes. */
function longAnalysis(seconds: number, seed: number): VoiceAnalysis {
  const rng = makeRng(seed);
  const hop = 0.01;
  const base = makeFakeAnalysis();
  const frames: FrameFeatures[] = [];
  const phrases: Phrase[] = [];
  let t = 0;
  let midi = 60;
  let phraseStart = 0;
  let notesInPhrase = 0;
  while (t < seconds) {
    const dur = 0.2 + rng() * 0.6;
    midi = Math.max(50, Math.min(72, midi + Math.round((rng() - 0.5) * 8)));
    const noteFrames = Math.round(dur / hop);
    for (let k = 0; k < noteFrames && t < seconds; k++, t += hop) {
      const inNote = k * hop;
      const vib = dur > 0.5 && inNote > 0.3 ? 0.3 * Math.sin(2 * Math.PI * 5.5 * t) : 0;
      frames.push(withMidi({ ...base.frames[100], t, voiced: true }, midi + vib));
    }
    notesInPhrase++;
    const gap = notesInPhrase >= 8 ? 0.5 : 0.06;
    if (notesInPhrase >= 8) {
      phrases.push({ start: phraseStart, end: t });
      notesInPhrase = 0;
    }
    for (let k = 0; k < Math.round(gap / hop) && t < seconds; k++, t += hop) {
      frames.push(withMidi({ ...base.frames[0], t, voiced: false, register: null }, NaN));
    }
    if (notesInPhrase === 0) phraseStart = t;
  }
  return { ...base, frames, durationSec: seconds, phrases, voicedSec: frames.filter((f) => f.voiced).length * hop };
}

describe('profileFromReference', () => {
  it('centres targets on the measured style with clamped bands', () => {
    const ref = makeFakeAnalysis({ breathiness: 0.95, brightness: 0.3, vibratoRateHz: null });
    const p = profileFromReference(ref, 'My clip');
    expect(p.id).toBe('reference');
    expect(p.name).toBe('My clip');
    expect(p.source).toBe('reference');
    expect(p.color).toBe(REFERENCE_PROFILE_COLOR);
    expect(p.targets.breathiness).toMatchObject({ ideal: 0.95, high: 1 });
    expect(p.targets.breathiness!.low).toBeCloseTo(0.85, 10);
    expect(p.targets.brightness!.ideal).toBe(0.3);
    expect(p.targets.brightness!.low).toBeCloseTo(0.2, 10);
    expect(p.targets.brightness!.high).toBeCloseTo(0.4, 10);
    expect(p.targets.vibratoRateHz).toBeUndefined();
    expect(p.targets.dynamicRangeDb).toMatchObject({ ideal: 14, low: 10, high: 18 });
    for (const band of Object.values(p.targets)) {
      expect(band.low).toBeLessThanOrEqual(band.ideal);
      expect(band.high).toBeGreaterThanOrEqual(band.ideal);
      expect(band.tolerance).toBeGreaterThan(0);
      expect(band.weight).toBeGreaterThan(0);
    }
  });

  it('always targets clean pitch because references are often pitch-corrected', () => {
    const p = profileFromReference(makeFakeAnalysis({ pitchAccuracyCents: 32 }), 'Clip');
    expect(p.targets.pitchAccuracyCents).toMatchObject({ ideal: 5, low: 0, high: 15 });
  });

  it('takes weights, colour, songs and moves from a base profile', () => {
    const base = makeFakeProfile({ color: '#b97a12' });
    const p = profileFromReference(makeFakeAnalysis(), 'Test Singer (clip)', base);
    expect(p.color).toBe('#b97a12');
    expect(p.targets.mixInUpperRange!.weight).toBe(1);
    expect(p.targets.brightness!.weight).toBe(0.6);
    expect(p.targets.brightness!.ideal).toBe(0.48);
    expect(p.studySongs).toEqual(base.studySongs);
    expect(p.signatureMoves).toEqual(base.signatureMoves);
    const bare = profileFromReference(makeFakeAnalysis(), 'Clip');
    expect(bare.studySongs).toEqual([]);
    expect(bare.signatureMoves).toEqual([]);
  });

  it('uses the clip range, falling back to the base profile', () => {
    const ref = makeFakeAnalysis();
    expect(profileFromReference(ref, 'Clip').typicalRange).toEqual({ lowMidi: 55, highMidi: 69, tessituraLowMidi: 59, tessituraHighMidi: 65 });
    const noPitch = { ...ref, pitch: { ...ref.pitch, lowMidi: null, highMidi: null } };
    const base = makeFakeProfile();
    expect(profileFromReference(noPitch, 'Clip', base).typicalRange).toEqual(base.typicalRange);
  });

  it('describes the measured sound in plain English with caveats', () => {
    const ref = makeFakeAnalysis({ breathiness: 0.7, brightness: 0.25, rasp: 0.05 });
    const p = profileFromReference(ref, 'Clip');
    expect(p.description).toMatch(/airy/);
    expect(p.description).toMatch(/dark, warm/);
    expect(p.description).toMatch(/G3 to A4/);
    expect(p.sourceNote).toMatch(/isolated vocal/);
    expect(p.sourceNote).toMatch(/pitch-corrected/);
    expect(p.traits.some((t) => /55% chest, 30% mix, 15% head/.test(t))).toBe(true);
    expect(p.traits.some((t) => /louder as the line climbs/.test(t))).toBe(true);
    const short = profileFromReference({ ...ref, voicedSec: 8, warnings: ['The recording clips.'] }, 'Clip');
    expect(short.sourceNote).toMatch(/under 15 s/);
    expect(short.sourceNote).toMatch(/The recording clips\./);
  });

  it('skips traits that were not measured', () => {
    const traits = describeStyleTraits({ ...makeFakeAnalysis().style, vibratoPresence: null, chestInUpperRange: null, agility: 3.2 });
    expect(traits.some((t) => /Vibrato/.test(t))).toBe(false);
    expect(traits.some((t) => /passaggio/.test(t))).toBe(false);
    expect(traits.some((t) => /3\.2 notes per second/.test(t))).toBe(true);
  });
});

describe('compareToReference', () => {
  const ref = makeFakeAnalysis();

  it('aligns a take with itself perfectly', () => {
    const c = compareToReference(ref, ref);
    expect(c.transposeSemitones).toBe(0);
    expect(c.meanAbsCents).toBeLessThan(2);
    expect(c.withinFiftyCents).toBe(1);
    expect(c.segments).toHaveLength(2);
    for (const s of c.segments) expect(s.note).toMatch(/On pitch/);
  });

  it('detects an octave transposition', () => {
    const user = transform(ref, { shift: -12 });
    const c = compareToReference(user, ref);
    expect(c.transposeSemitones).toBe(-12);
    expect(c.meanAbsCents).toBeLessThan(2);
    expect(c.withinFiftyCents).toBe(1);
  });

  it('detects a non-octave key change', () => {
    const c = compareToReference(transform(ref, { shift: 3 }), ref);
    expect(c.transposeSemitones).toBe(3);
    expect(c.meanAbsCents).toBeLessThan(2);
  });

  it('stays aligned through a 10% time-stretch and reports the slower timing', () => {
    const user = transform(ref, { stretch: 1.1 });
    const c = compareToReference(user, ref);
    expect(c.transposeSemitones).toBe(0);
    expect(c.meanAbsCents).toBeLessThan(15);
    expect(c.withinFiftyCents).toBeGreaterThan(0.9);
    expect(c.segments).toHaveLength(2);
    for (const s of c.segments) {
      expect(s.note).toMatch(/On pitch/);
      expect(s.note).toMatch(/longer than the reference.*behind/);
    }
    expect(c.segments[1].userStart).toBeGreaterThan(6.08 * 1.1 - 0.1);
    expect(c.segments[1].userStart).toBeLessThan(6.08 * 1.1 + 0.1);
    expect(c.segments[1].userEnd).toBeCloseTo(11.92 * 1.1, 0);
  });

  it('reports faster timing when the user rushes', () => {
    const c = compareToReference(transform(ref, { stretch: 0.85 }), ref);
    for (const s of c.segments) expect(s.note).toMatch(/faster than the reference.*ahead/);
  });

  it('localises a +30 cent error to the phrase where it happened', () => {
    const user = transform(ref, { offset: { start: 6, end: 12, cents: 30 } });
    const c = compareToReference(user, ref);
    expect(c.transposeSemitones).toBe(0);
    const [first, second] = c.segments;
    expect(Math.abs(first.meanSignedCents)).toBeLessThan(5);
    expect(first.note).toMatch(/On pitch/);
    expect(second.meanSignedCents).toBeGreaterThan(24);
    expect(second.meanSignedCents).toBeLessThan(36);
    expect(second.note).toMatch(/\b(2[5-9]|3[0-5]) cents sharp/);
  });

  it('handles transposition, stretch and a local detune together', () => {
    const user = transform(ref, { shift: -12, stretch: 1.1, offset: { start: 6, end: 12, cents: -30 } });
    const c = compareToReference(user, ref);
    expect(c.transposeSemitones).toBe(-12);
    expect(c.segments).toHaveLength(2);
    expect(c.segments[0].note).toMatch(/On pitch/);
    expect(c.segments[1].meanSignedCents).toBeLessThan(-20);
    expect(c.segments[1].note).toMatch(/flat/);
  });

  it('says the melody differs when the notes are wrong', () => {
    // Every other second of the first phrase is sung two semitones high.
    const frames = ref.frames.map((f) => (f.t < 6 && Math.floor(f.t) % 2 === 1 ? withMidi(f, f.midi + 2) : f));
    const c = compareToReference({ ...ref, frames }, ref);
    expect(c.segments[0].note).toMatch(/melody or ornaments differ/);
    expect(c.segments[1].note).toMatch(/On pitch/);
  });

  it('aligns a user who sang only part of the reference', () => {
    const user = transform(excerpt(ref, 6, 12), { shift: -12 });
    const c = compareToReference(user, ref);
    expect(c.transposeSemitones).toBe(-12);
    expect(c.meanAbsCents).toBeLessThan(5);
    expect(c.segments).toHaveLength(1);
    expect(c.segments[0].refStart).toBeGreaterThan(5.9);
    expect(c.segments[0].userStart).toBeLessThan(0.2);
  });

  it('returns a monotonic path with at most 1500 points', () => {
    const c = compareToReference(transform(ref, { stretch: 1.1 }), ref);
    expect(c.path.length).toBeGreaterThan(100);
    expect(c.path.length).toBeLessThanOrEqual(1500);
    for (let i = 1; i < c.path.length; i++) {
      expect(c.path[i].userT).toBeGreaterThanOrEqual(c.path[i - 1].userT);
      expect(c.path[i].refT).toBeGreaterThanOrEqual(c.path[i - 1].refT);
    }
    for (const p of c.path) expect(Math.abs(p.centsDiff)).toBeLessThanOrEqual(300);
  });

  it('falls back to fixed windows when the reference has no phrases', () => {
    const c = compareToReference(ref, { ...ref, phrases: [] });
    expect(c.segments.length).toBeGreaterThanOrEqual(2);
    for (const s of c.segments) expect(s.refEnd - s.refStart).toBeLessThanOrEqual(5.001);
  });

  it('computes style differences for dimensions both takes measured', () => {
    const user = makeFakeAnalysis({ breathiness: 0.3, agility: null });
    const reference = makeFakeAnalysis({ breathiness: 0.7 });
    const c = compareToReference(user, reference);
    expect(c.styleDiff.breathiness).toBeCloseTo(-0.4, 10);
    expect(c.styleDiff.brightness).toBe(0);
    expect(c.styleDiff.agility).toBeUndefined();
  });

  it('returns an empty comparison when there is too little singing', () => {
    const silent = { ...ref, frames: ref.frames.map((f) => ({ ...f, voiced: false, midi: NaN, f0: NaN })) };
    const c = compareToReference(silent, ref);
    expect(c.path).toEqual([]);
    expect(c.segments).toEqual([]);
    expect(Number.isNaN(c.meanAbsCents)).toBe(true);
    expect(c.withinFiftyCents).toBe(0);
  });

  it('aligns a 3-minute take against a 3-minute reference in under 2 seconds', () => {
    const longRef = longAnalysis(180, 7);
    const user = transform(longRef, { shift: -12, stretch: 1.05 });
    const t0 = performance.now();
    const c = compareToReference(user, longRef);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(c.transposeSemitones).toBe(-12);
    expect(c.withinFiftyCents).toBeGreaterThan(0.85);
    expect(c.path.length).toBeLessThanOrEqual(1500);
    expect(c.segments.length).toBeGreaterThan(20);
  });
});
