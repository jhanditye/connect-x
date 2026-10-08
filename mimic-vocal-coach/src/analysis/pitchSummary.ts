// Pitch summary shared by the solo pipeline (analyze.ts) and mix mode (mixMode.ts).

import { median, percentile } from '../dsp/stats';
import type { FrameFeatures, VoiceAnalysis } from '../types';

/** Median, 5th / 95th and 25th / 75th percentile of the voiced MIDI values; all null with under 20 voiced frames. */
export function pitchSummary(frames: FrameFeatures[], tuningOffsetCents: number): VoiceAnalysis['pitch'] {
  const midi = frames.filter((f) => f.voiced).map((f) => f.midi);
  if (midi.length < 20) {
    return { medianMidi: null, lowMidi: null, highMidi: null, tessituraLowMidi: null, tessituraHighMidi: null, tuningOffsetCents };
  }
  return {
    medianMidi: median(midi),
    lowMidi: Math.round(percentile(midi, 5)),
    highMidi: Math.round(percentile(midi, 95)),
    tessituraLowMidi: Math.round(percentile(midi, 25)),
    tessituraHighMidi: Math.round(percentile(midi, 75)),
    tuningOffsetCents,
  };
}
