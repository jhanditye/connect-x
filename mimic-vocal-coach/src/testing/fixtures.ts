// Plausible hand-built data objects for tests and UI development. They satisfy the contracts in
// src/types.ts without running the analysis engine. Values are illustrative, not measured.

import type {
  CoachingPlan,
  Comparison,
  FrameFeatures,
  NoteSegment,
  ReferenceComparison,
  SessionRecord,
  SingerProfile,
  StyleVector,
  VoiceAnalysis,
} from '../types';

export const FAKE_STYLE: StyleVector = {
  breathiness: 0.42,
  brightness: 0.48,
  rasp: 0.12,
  vibratoPresence: 0.3,
  vibratoRateHz: 5.4,
  vibratoExtentCents: 45,
  chestInUpperRange: 0.55,
  mixInUpperRange: 0.3,
  headInUpperRange: 0.15,
  loudnessClimbDbPerSemitone: 1.1,
  agility: 0,
  dynamicRangeDb: 14,
  softOnsetRatio: 0.25,
  pitchAccuracyCents: 18,
  flipsPerMinute: 1.5,
};

/** A 12-second take: a phrase rising from G3 through the passaggio to A4, with vibrato on held notes. */
export function makeFakeAnalysis(style: Partial<StyleVector> = {}): VoiceAnalysis {
  const hop = 0.01;
  const duration = 12;
  const frames: FrameFeatures[] = [];
  const melody = [55, 57, 59, 60, 62, 64, 65, 67, 69, 67, 64, 62]; // one note per second
  for (let i = 0; i < duration / hop; i++) {
    const t = i * hop;
    const noteIdx = Math.min(melody.length - 1, Math.floor(t));
    const inNote = t - noteIdx;
    const voiced = inNote > 0.08 && inNote < 0.92;
    const vib = inNote > 0.45 ? 0.45 * Math.sin(2 * Math.PI * 5.4 * t) : 0;
    const midi = voiced ? melody[noteIdx] + vib : NaN;
    const register = !voiced ? null : midi >= 66 ? (midi >= 68.5 ? 'head' : 'mix') : 'chest';
    frames.push({
      t,
      f0: voiced ? 440 * Math.pow(2, (midi - 69) / 12) : NaN,
      midi,
      voiced,
      periodicity: voiced ? 0.93 : 0.2,
      rmsDb: voiced ? -24 + (melody[noteIdx] - 55) * 0.6 : -62,
      h1h2Db: voiced ? 4 : NaN,
      alphaRatioDb: voiced ? -14 : NaN,
      centroidHz: voiced ? 1400 : NaN,
      tiltDbPerOct: voiced ? -12 : NaN,
      cppDb: voiced ? 17 : NaN,
      hnrDb: voiced ? 18 : NaN,
      register,
    });
  }
  const notes: NoteSegment[] = melody.map((m, i) => ({
    start: i + 0.08,
    end: i + 0.92,
    midi: m + 0.1,
    nearestMidi: m,
    centsOff: (i % 3) * 8 - 8,
    vibrato: i >= 4 ? { rateHz: 5.4, extentCents: 45 } : null,
    register: m >= 66 ? (m >= 68.5 ? 'head' : 'mix') : 'chest',
    meanRmsDb: -24 + (m - 55) * 0.6,
  }));
  const voicedCount = frames.filter((f) => f.voiced).length;
  return {
    version: 1,
    durationSec: duration,
    sampleRate: 22050,
    hopSec: hop,
    frames,
    voicedRatio: voicedCount / frames.length,
    voicedSec: voicedCount * hop,
    pitch: {
      medianMidi: 62,
      lowMidi: 55,
      highMidi: 69,
      tessituraLowMidi: 59,
      tessituraHighMidi: 65,
      tuningOffsetCents: 6,
    },
    passaggio: { lowMidi: 62, highMidi: 67 },
    tone: { h1h2Db: 4, alphaRatioDb: -14, centroidHz: 1400, tiltDbPerOct: -12, cppDb: 17, hnrDb: 18 },
    registerShares: { chest: 0.6, mix: 0.25, head: 0.15 },
    notes,
    phrases: [
      { start: 0.08, end: 5.92 },
      { start: 6.08, end: 11.92 },
    ],
    onsets: [
      { t: 0.08, type: 'balanced' },
      { t: 6.08, type: 'breathy' },
    ],
    runs: [],
    style: { ...FAKE_STYLE, ...style },
    quality: { clippingRatio: 0, noiseFloorDb: -64, snrDb: 38 },
    warnings: [],
    issues: [],
  };
}

export function makeFakeProfile(overrides: Partial<SingerProfile> = {}): SingerProfile {
  return {
    id: 'test-singer',
    name: 'Test Singer',
    tagline: 'A made-up profile for tests.',
    description: 'Balanced, clear tone with a light mix through the passaggio.',
    traits: ['Light mix above the passaggio', 'Moderate vibrato on held notes'],
    studySongs: [{ title: 'Example Song', listenFor: 'The flip into head voice on the last chorus.' }],
    typicalRange: { lowMidi: 50, highMidi: 74, tessituraLowMidi: 57, tessituraHighMidi: 67 },
    targets: {
      breathiness: { ideal: 0.5, low: 0.4, high: 0.6, tolerance: 0.3, weight: 0.8 },
      brightness: { ideal: 0.6, low: 0.5, high: 0.7, tolerance: 0.3, weight: 0.6 },
      mixInUpperRange: { ideal: 0.5, low: 0.35, high: 0.65, tolerance: 0.35, weight: 1 },
      pitchAccuracyCents: { ideal: 5, low: 0, high: 15, tolerance: 25, weight: 0.5 },
    },
    signatureMoves: [
      { id: 'flip', name: 'Falsetto flip', description: 'Clean switch into falsetto on the top note.', howTo: ['Lighten the note before the leap.'] },
    ],
    color: '#50606f',
    source: 'builtin',
    sourceNote: 'Hand-authored test data.',
    ...overrides,
  };
}

export function makeFakeComparison(profileId = 'test-singer'): Comparison {
  return {
    profileId,
    overall: 68,
    dimensions: [
      {
        key: 'breathiness',
        label: 'Breathiness',
        value: 0.42,
        target: { ideal: 0.5, low: 0.4, high: 0.6, tolerance: 0.3, weight: 0.8 },
        score: 84,
        direction: 'ok',
        summary: 'Close to the target airiness (0.42 vs ~0.50).',
      },
      {
        key: 'mixInUpperRange',
        label: 'Mix above the passaggio',
        value: 0.3,
        target: { ideal: 0.5, low: 0.35, high: 0.65, tolerance: 0.35, weight: 1 },
        score: 55,
        direction: 'more',
        summary: 'Less mix than the target (30% vs ~50%); most high notes were chest-heavy.',
      },
    ],
    suggestedTransposeSemitones: -2,
    rangeNote: 'Your take sat about two semitones lower than this singer usually sits.',
  };
}

export function makeFakePlan(profileId = 'test-singer'): CoachingPlan {
  return {
    profileId,
    headline: 'A solid start: tone and pitch are close, but the top notes are carried in chest.',
    strengths: ['Pitch is steady on held notes.'],
    items: [
      {
        id: 'mix-more',
        priority: 1,
        dimension: 'mixInUpperRange',
        title: 'Lighten into mix above E4',
        whatWeHeard: 'About 55% of your notes above D4 read as chest, and loudness climbed 1.1 dB per semitone.',
        whyItMatters: 'The target sound stays easy and level through the passaggio.',
        howToFix: ['Narrow the vowel toward "uh" as you climb.', 'Keep volume level instead of getting louder.'],
        exerciseIds: ['lip-trill-siren'],
      },
    ],
    signatureFocus: [{ moveId: 'flip', hint: 'Your flips are already clean; add them on phrase peaks.' }],
    healthNotes: ['Stop if you feel scratchiness or tightness, and rest your voice.'],
    nextTake: 'Record the same phrase again after five minutes of lip-trill sirens.',
  };
}

export function makeFakeReferenceComparison(): ReferenceComparison {
  const path = Array.from({ length: 200 }, (_, i) => ({
    userT: i * 0.05,
    refT: i * 0.05 + 0.2,
    centsDiff: 30 * Math.sin(i / 15),
  }));
  return {
    transposeSemitones: -12,
    path,
    meanAbsCents: 22,
    withinFiftyCents: 0.82,
    segments: [
      { refStart: 0.2, refEnd: 5, userStart: 0, userEnd: 4.8, meanAbsCents: 18, meanSignedCents: -12, note: 'Slightly flat on the long notes.' },
    ],
    styleDiff: { breathiness: -0.2, vibratoPresence: 0.1 },
  };
}

export function makeFakeSessions(n = 6, profileId = 'test-singer'): SessionRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    createdAt: new Date(Date.UTC(2026, 8, 1 + i * 2, 18, 0, 0)).toISOString(),
    profileId,
    profileName: 'Test Singer',
    overall: 55 + i * 4,
    dimensionScores: { breathiness: 60 + i * 3, mixInUpperRange: 40 + i * 6 },
    style: { ...FAKE_STYLE, mixInUpperRange: 0.2 + i * 0.05 },
    durationSec: 30,
  }));
}
