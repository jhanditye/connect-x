// Approximate passaggio (register-transition) zones per voice type.
//
// These are the zones where the second passaggio / mix transition usually falls for each voice
// type, as commonly taught in voice pedagogy. They are approximate: individual singers vary by a
// few semitones either way, and the transition is a gradual zone rather than a single note. The
// analysis uses `lowMidi` as the start of the "upper range" (where mix coaching matters) and the
// zone as a prior for the register estimate.

import type { PassaggioZone, VoiceType } from '../types';

const ZONES: Record<VoiceType, PassaggioZone> = {
  bass: { lowMidi: 59, highMidi: 64 }, // B3-E4
  baritone: { lowMidi: 62, highMidi: 67 }, // D4-G4
  tenor: { lowMidi: 64, highMidi: 69 }, // E4-A4
  alto: { lowMidi: 67, highMidi: 74 }, // G4-D5
  mezzo: { lowMidi: 69, highMidi: 76 }, // A4-E5
  soprano: { lowMidi: 71, highMidi: 78 }, // B4-F#5
};

export const VOICE_TYPE_LABELS: Record<VoiceType, string> = {
  bass: 'Bass (lowest male voice)',
  baritone: 'Baritone (most male pop voices)',
  tenor: 'Tenor (higher male voice)',
  alto: 'Alto (lowest female voice)',
  mezzo: 'Mezzo-soprano (most female pop voices)',
  soprano: 'Soprano (highest female voice)',
};

/** Approximate mix/passaggio zone for a voice type (a fresh object; callers may keep it). */
export function passaggioFor(voiceType: VoiceType): PassaggioZone {
  const zone = ZONES[voiceType] ?? ZONES.baritone;
  return { lowMidi: zone.lowMidi, highMidi: zone.highMidi };
}
