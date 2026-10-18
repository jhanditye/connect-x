import { describe, expect, it } from 'vitest';
import { parseSequence, placeDegrees, sequenceText, tokenizeSequence } from './sequence';

function semis(text: string, mode: Parameters<typeof parseSequence>[1] = 'major'): number[] {
  const r = parseSequence(text, mode);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.notes.map((n) => n.semitones);
}

describe('parseSequence: the singer\'s examples', () => {
  it('"7 6 5 4 3 2" walks down from the leading tone in the home octave', () => {
    expect(semis('7 6 5 4 3 2')).toEqual([11, 9, 7, 5, 4, 2]);
    const r = parseSequence('7 6 5 4 3 2');
    expect(r.ok && r.notes.map((n) => n.degree)).toEqual([7, 6, 5, 4, 3, 2]);
  });

  it('"2 7 6 5": the 7 is BELOW the 2 (nearest octave), and the line keeps going down', () => {
    expect(semis('2 7 6 5')).toEqual([2, -1, -3, -5]);
    const r = parseSequence('2 7 6 5');
    expect(r.ok && r.normalized).toBe('2 7- 6- 5-');
  });

  it('"1 3 5 8" and "1 3 5 8 5 3 1"', () => {
    expect(semis('1 3 5 8')).toEqual([0, 4, 7, 12]);
    expect(semis('1 3 5 8 5 3 1')).toEqual([0, 4, 7, 12, 7, 4, 0]);
  });

  it('"8 7 6 5 4 3 2 1" starts on the upper tonic', () => {
    expect(semis('8 7 6 5 4 3 2 1')).toEqual([12, 11, 9, 7, 5, 4, 2, 0]);
  });

  it('commas, extra spaces and run-together digits all work', () => {
    expect(semis('7,6,5,4,3,2')).toEqual([11, 9, 7, 5, 4, 2]);
    expect(semis(' 7, 6 ,  5 ')).toEqual([11, 9, 7]);
    expect(semis('765432')).toEqual([11, 9, 7, 5, 4, 2]);
  });
});

describe('parseSequence: octave marks', () => {
  it('"-" and "_" put a degree in the octave below; "+" and "\'" above; marks stack', () => {
    expect(semis('1 7- 1 2 1')).toEqual([0, -1, 0, 2, 0]);
    expect(semis('5_ 1')).toEqual([-5, 0]);
    expect(semis("1 3+ 5'")).toEqual([0, 16, 19]);
    expect(semis('1 5--')).toEqual([0, -17]);
  });

  it('marks are absolute (relative to the home octave), not relative to the previous note', () => {
    // 4- is always 7 semitones below the tonic, even though the plain 4 nearest to 1 would be above.
    expect(semis('1 4-')).toEqual([0, -7]);
    expect(semis('1 4')).toEqual([0, 5]);
    // After the line climbs, "3+" is still the 3 one octave up.
    expect(semis('1 3 5 8 3+')).toEqual([0, 4, 7, 12, 16]);
  });

  it('a first degree with a mark starts in that octave', () => {
    expect(semis('7- 1')).toEqual([-1, 0]);
    expect(semis('5+ 3')).toEqual([19, 16]);
  });

  it('8 is always the upper tonic, even after a low note', () => {
    expect(semis('4 8')).toEqual([5, 12]);
    expect(semis('1 8')).toEqual([0, 12]);
    expect(semis('8 8')).toEqual([12, 12]);
  });
});

describe('parseSequence: tritone ties', () => {
  it('a tie follows the overall line direction', () => {
    // F to B in C major is 6 semitones either way.
    expect(semis('4 7')).toEqual([5, 11]); // line goes up (4 -> 7)
    expect(semis('7 4')).toEqual([11, 5]); // line goes down
  });

  it('a tie prefers the octave nearer the first note, so "4 7 4 7" does not climb', () => {
    expect(semis('4 7 4 7')).toEqual([5, 11, 5, 11]);
  });

  it('a flat line goes down on the tie and comes back home', () => {
    expect(semis('4 7 4')).toEqual([5, -1, 5]);
  });

  it('the mode changes the scale steps: natural minor 2 -> 6 is a tritone', () => {
    // 2 = 2, 6 = 8 in natural minor: tie; line goes up -> 8.
    expect(semis('2 6', 'natural-minor')).toEqual([2, 8]);
    expect(semis('1 3 5 3 1', 'natural-minor')).toEqual([0, 3, 7, 3, 0]);
    expect(semis('7 1', 'harmonic-minor')).toEqual([11, 12]);
    expect(semis('7 1', 'natural-minor')).toEqual([10, 12]);
  });
});

describe('parseSequence: bad input gives a clear error with a position', () => {
  const cases: [string, RegExp, number | null][] = [
    ['', /Type some scale degrees/, null],
    ['   ', /Type some scale degrees/, null],
    ['0', /0 isn't a scale degree/, 0],
    ['1 2 0', /0 isn't a scale degree/, 4],
    ['9', /beyond the octave: write 2\+/, 0],
    ['1 10', /10 is beyond the octave: write 3\+/, 2],
    ['20', /0 isn't a scale degree/, 1],
    ['do re mi', /Letters aren't scale degrees/, 0],
    ['1 2 x', /Letters aren't scale degrees/, 4],
    ['b7 6', /Sharps and flats/, 0],
    ['+3', /Put octave marks after the degree/, 0],
    ['1 - 2', /Put octave marks after the degree/, 2],
    ['1---', /At most 2 octave marks/, 1],
    ['1 ? 2', /isn't understood/, 2],
  ];
  for (const [text, err, at] of cases) {
    it(JSON.stringify(text), () => {
      const r = parseSequence(text);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(err);
        expect(r.at).toBe(at);
      }
    });
  }

  it('more than 16 notes is refused', () => {
    const r = parseSequence('1 2 3 4 5 6 7 8 7 6 5 4 3 2 1 2 3');
    expect(r.ok).toBe(false);
  });

  it('a line wider than two octaves is refused', () => {
    expect(parseSequence('1-- 8+').ok).toBe(false);
  });
});

describe('canonical text', () => {
  it('round-trips: parsing the normalized text gives the same pitches', () => {
    for (const text of ['7 6 5 4 3 2', '2 7 6 5', '1 3 5 8 5 3 1', '1 7- 1 2 1', '4 7 4', '5+ 3', '8 7 6 5 4 3 2 1', '1 5-- 1']) {
      const a = parseSequence(text);
      expect(a.ok).toBe(true);
      if (!a.ok) continue;
      const b = parseSequence(a.normalized);
      expect(b.ok && b.notes.map((n) => n.semitones)).toEqual(a.notes.map((n) => n.semitones));
    }
  });

  it('odd mark combinations keep the typed text when the canonical form would read differently', () => {
    const r = parseSequence('5- 4+-');
    expect(r.ok && r.notes.map((n) => n.semitones)).toEqual([-5, 5]);
    expect(r.ok && r.normalized).toBe('5- 4+-');
  });

  it('sequenceText marks octaves relative to the home octave, with 8 as written', () => {
    expect(sequenceText(placeDegrees([{ written: 8, marks: null }, { written: 7, marks: null }], 'major'))).toBe('8 7');
    expect(sequenceText(placeDegrees([{ written: 1, marks: null }, { written: 5, marks: -1 }], 'major'))).toBe('1 5-');
  });

  it('tokenizer records explicit marks and positions', () => {
    const t = tokenizeSequence("1 7- 3'");
    expect(t.ok && t.tokens).toEqual([
      { written: 1, marks: null, at: 0 },
      { written: 7, marks: -1, at: 2 },
      { written: 3, marks: 1, at: 5 },
    ]);
  });
});
