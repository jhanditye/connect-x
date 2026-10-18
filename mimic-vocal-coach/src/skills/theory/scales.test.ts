import { describe, expect, it } from 'vitest';
import { midiToHz } from '../../dsp/music';
import {
  SCALE_STEPS,
  cadenceChords,
  degreeLabel,
  degreeOfMidi,
  degreeSemitones,
  keyName,
  lineLabels,
  noteHz,
  noteMidi,
  prettyAccidentals,
  spellDegree,
  spellDegreeWithOctave,
} from './scales';
import { parseSequence } from './sequence';

describe('scale tables', () => {
  it('major, natural minor and harmonic minor steps', () => {
    expect(SCALE_STEPS.major).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(SCALE_STEPS['natural-minor']).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(SCALE_STEPS['harmonic-minor']).toEqual([0, 2, 3, 5, 7, 8, 11]);
    expect(degreeSemitones(8, 'major')).toBe(12);
    expect(degreeSemitones(7, 'natural-minor')).toBe(10);
  });

  it('degreeOfMidi finds the degree in any octave, null for chromatic notes', () => {
    const key = { tonicMidi: 62, mode: 'major' as const }; // D major
    expect(degreeOfMidi(key, 61)).toBe(7); // C#4
    expect(degreeOfMidi(key, 73)).toBe(7); // C#5
    expect(degreeOfMidi(key, 60)).toBeNull(); // C natural
  });
});

describe('MIDI and Hz with the user\'s A4', () => {
  it('converts line notes through the key', () => {
    const key = { tonicMidi: 57, mode: 'major' as const }; // A3
    const r = parseSequence('1 3 5 8');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes.map((n) => noteMidi(key, n))).toEqual([57, 61, 64, 69]);
    expect(noteHz(key, r.notes[3], 440)).toBeCloseTo(440, 6);
    expect(noteHz(key, r.notes[3], 442)).toBeCloseTo(442, 6);
    expect(noteHz(key, r.notes[0], 442)).toBeCloseTo(midiToHz(57, 442), 6);
  });
});

describe('spelling and key names', () => {
  it('uses the right letters', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => spellDegree({ tonicMidi: 66, mode: 'major' }, d as 1))).toEqual(['F#', 'G#', 'A#', 'B', 'C#', 'D#', 'E#']);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => spellDegree({ tonicMidi: 63, mode: 'major' }, d as 1))).toEqual(['Eb', 'F', 'G', 'Ab', 'Bb', 'C', 'D']);
    expect(spellDegree({ tonicMidi: 57, mode: 'harmonic-minor' }, 7)).toBe('G#');
    expect(spellDegree({ tonicMidi: 57, mode: 'natural-minor' }, 7)).toBe('G');
    expect(spellDegree({ tonicMidi: 68, mode: 'harmonic-minor' }, 7)).toBe('F##');
    expect(spellDegree({ tonicMidi: 60, mode: 'natural-minor' }, 3)).toBe('Eb');
  });

  it('octave numbers follow the letter (E#4 is MIDI 65, B#3 is MIDI 60)', () => {
    expect(spellDegreeWithOctave({ tonicMidi: 66, mode: 'major' }, 7, 65)).toBe('E#4');
    expect(spellDegreeWithOctave({ tonicMidi: 61, mode: 'major' }, 7, 60)).toBe('C4'); // Db major: 7 = C
    expect(spellDegreeWithOctave({ tonicMidi: 61, mode: 'harmonic-minor' }, 7, 60)).toBe('B#3'); // C# harmonic minor
  });

  it('key names', () => {
    expect(keyName({ tonicMidi: 63, mode: 'major' })).toBe('E♭ major');
    expect(keyName({ tonicMidi: 57, mode: 'natural-minor' })).toBe('A minor');
    expect(keyName({ tonicMidi: 68, mode: 'harmonic-minor' })).toBe('G♯ harmonic minor');
    expect(keyName({ tonicMidi: 66, mode: 'major' })).toBe('F♯ major');
    expect(prettyAccidentals('Bb')).toBe('B♭');
    expect(prettyAccidentals('B')).toBe('B');
  });
});

describe('display labels', () => {
  const line = (text: string, mode: 'major' | 'natural-minor' | 'harmonic-minor' = 'major') => {
    const r = parseSequence(text, mode);
    if (!r.ok) throw new Error(r.error);
    return r.notes;
  };

  it('numbers keep 8 as 8 and mark notes outside the home octave', () => {
    expect(lineLabels(line('2 7 6 5'), 'major', 'numbers')).toEqual([
      { text: '2', octaveMark: 0 },
      { text: '7', octaveMark: -1 },
      { text: '6', octaveMark: -1 },
      { text: '5', octaveMark: -1 },
    ]);
    expect(degreeLabel(line('8')[0], 'major', 'numbers')).toEqual({ text: '8', octaveMark: 0 });
  });

  it('movable-do solfege, do-based minor', () => {
    expect(lineLabels(line('1 2 3 4 5 6 7'), 'major', 'solfege').map((l) => l.text)).toEqual(['do', 're', 'mi', 'fa', 'sol', 'la', 'ti']);
    expect(lineLabels(line('1 2 3 4 5 6 7', 'natural-minor'), 'natural-minor', 'solfege').map((l) => l.text)).toEqual(['do', 're', 'me', 'fa', 'sol', 'le', 'te']);
    expect(lineLabels(line('3 6 7', 'harmonic-minor'), 'harmonic-minor', 'solfege').map((l) => l.text)).toEqual(['me', 'le', 'ti']);
    expect(degreeLabel(line('8')[0], 'major', 'solfege')).toEqual({ text: 'do', octaveMark: 1 });
  });

  it('note names in the key', () => {
    const key = { tonicMidi: 62, mode: 'major' as const };
    expect(lineLabels(line('7 6 5 4 3 2'), 'major', 'names', key).map((l) => l.text)).toEqual(['C♯', 'B', 'A', 'G', 'F♯', 'E']);
  });
});

describe('cadence', () => {
  it('I-IV-V7-I in C, close voicing with a bass note', () => {
    expect(cadenceChords({ tonicMidi: 60, mode: 'major' })).toEqual([
      [48, 60, 64, 67],
      [53, 60, 65, 69],
      [55, 59, 62, 65, 67], // the bass moves up a step, F3 -> G3
      [48, 60, 64, 67],
    ]);
  });

  it('harmonic minor uses V7 (ti); natural minor uses v7 (te), the 7 its lines ask for', () => {
    const [i, iv, v7] = cadenceChords({ tonicMidi: 57, mode: 'natural-minor' });
    expect(i).toEqual([45, 57, 60, 64]); // A C E
    expect(iv).toEqual([50, 57, 62, 65]); // D A D F
    expect(v7).toContain(55); // G
    expect(v7).not.toContain(56);
    expect(cadenceChords({ tonicMidi: 57, mode: 'harmonic-minor' })[2]).toContain(56); // G#
  });

  it('voices the chords in a middle register whatever the singer\'s octave (no 40 Hz bass for a bass voice)', () => {
    for (let tonic = 33; tonic <= 80; tonic++) {
      for (const mode of ['major', 'natural-minor', 'harmonic-minor'] as const) {
        const notes = cadenceChords({ tonicMidi: tonic, mode }).flat();
        expect(Math.min(...notes)).toBeGreaterThanOrEqual(40); // E2
        expect(Math.max(...notes)).toBeLessThanOrEqual(75);
        // Same pitch classes as the key.
        expect(((cadenceChords({ tonicMidi: tonic, mode })[0][1] - tonic) % 12 + 12) % 12).toBe(0);
      }
    }
  });
});
