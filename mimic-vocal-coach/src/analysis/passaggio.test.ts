import { describe, expect, it } from 'vitest';
import type { VoiceType } from '../types';
import { passaggioFor, VOICE_TYPE_LABELS } from './passaggio';

const TYPES: VoiceType[] = ['bass', 'baritone', 'tenor', 'alto', 'mezzo', 'soprano'];

describe('passaggioFor', () => {
  it('returns the documented zones', () => {
    expect(passaggioFor('bass')).toEqual({ lowMidi: 59, highMidi: 64 });
    expect(passaggioFor('baritone')).toEqual({ lowMidi: 62, highMidi: 67 });
    expect(passaggioFor('tenor')).toEqual({ lowMidi: 64, highMidi: 69 });
    expect(passaggioFor('alto')).toEqual({ lowMidi: 67, highMidi: 74 });
    expect(passaggioFor('mezzo')).toEqual({ lowMidi: 69, highMidi: 76 });
    expect(passaggioFor('soprano')).toEqual({ lowMidi: 71, highMidi: 78 });
  });

  it('rises with the voice type within each group and returns fresh objects', () => {
    const zones = TYPES.map(passaggioFor);
    for (const z of zones) expect(z.highMidi).toBeGreaterThan(z.lowMidi);
    for (let i = 1; i < 3; i++) expect(zones[i].lowMidi).toBeGreaterThan(zones[i - 1].lowMidi);
    for (let i = 4; i < 6; i++) expect(zones[i].lowMidi).toBeGreaterThan(zones[i - 1].lowMidi);
    const a = passaggioFor('tenor');
    a.lowMidi = 0;
    expect(passaggioFor('tenor').lowMidi).toBe(64);
  });

  it('has a label for every voice type', () => {
    for (const t of TYPES) expect(VOICE_TYPE_LABELS[t].length).toBeGreaterThan(3);
    expect(VOICE_TYPE_LABELS.baritone).toBe('Baritone (most male pop voices)');
  });
});
