import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeFakePhraseComparison } from '../../testing/trainerFixtures';
import type { PhraseComparison, ToneFinding } from '../../types';
import { TonePanel } from './TonePanel';

const html = (c: PhraseComparison, kind?: 'solo' | 'mix'): string => renderToStaticMarkup(<TonePanel comparison={c} referenceKind={kind} />);
const withTone = (tone: ToneFinding[]): PhraseComparison => ({ ...makeFakePhraseComparison('perfect'), tone });

describe('TonePanel and an isolated original', () => {
  const htmlIso = (c: PhraseComparison, kind?: 'solo' | 'mix'): string => renderToStaticMarkup(<TonePanel comparison={c} referenceKind={kind} isolatedReference />);

  it('says the tone numbers are estimates when the original is a vocal pulled out of a song, next to the numbers', () => {
    const h = htmlIso(makeFakePhraseComparison('flat'));
    expect(h).toContain('Airier than the original');
    expect(h).toContain('isolated-tone-note');
    expect(h).toMatch(/pulled out of a song by AI on this phone/);
    expect(h).toMatch(/rough estimates/);
  });

  it('does not add the note to an ordinary original, or where tone is not compared at all', () => {
    expect(html(makeFakePhraseComparison('flat'))).not.toContain('isolated-tone-note');
    expect(htmlIso(makeFakePhraseComparison('flat'), 'mix')).not.toContain('isolated-tone-note');
  });
});

describe('TonePanel', () => {
  it('tells the airy, straight take in plain words relative to the original, with a meter', () => {
    const h = html(makeFakePhraseComparison('flat'));
    expect(h).toContain('Airier than the original');
    expect(h).toContain('a little');
    expect(h).toContain('+0.14');
    expect(h).toContain('yours stayed straight');
    expect(h).toMatch(/aria-label="airier than the original by 0\.14 on a scale where 0\.5 is a big difference"/);
    expect(h).toContain('tp-meter-fill--high');
    expect(h).not.toContain('NaN');
  });

  it('a clean take says its tone is close to the original', () => {
    expect(html(makeFakePhraseComparison('perfect'))).toContain('Your tone is close to the original, within what the app can measure.');
  });

  it('always carries the caveat that these are estimates and not better or worse', () => {
    for (const c of [makeFakePhraseComparison('flat'), makeFakePhraseComparison('perfect'), makeFakePhraseComparison('no-match')]) {
      expect(html(c)).toMatch(/These are estimates/);
      expect(html(c)).toMatch(/never mean better or worse/);
    }
  });

  it('a full-song original explains that tone is not compared and what to use instead', () => {
    const h = html(makeFakePhraseComparison('flat'), 'mix');
    expect(h).toContain('Tone is not compared here');
    expect(h).toContain('isolated vocal');
    expect(h).not.toContain('Airier');
    const viaReason: PhraseComparison = { ...makeFakePhraseComparison('perfect'), score: { ...makeFakePhraseComparison('perfect').score, trust: { level: 'caution', reasons: ['The reference is a full mix: pitch and timing are compared.'] } } };
    expect(html(viaReason)).toContain('Tone is not compared here');
  });

  it('a take that did not line up, or had too little voice, names the next step', () => {
    expect(html(makeFakePhraseComparison('no-match'))).toMatch(/Tone is compared once a take lines up/);
    const c = makeFakePhraseComparison('perfect');
    const quiet: PhraseComparison = { ...c, score: { ...c.score, skills: { ...c.score.skills, tone: null } } };
    expect(html(quiet)).toMatch(/longer, steadier take/);
  });

  it('grit is described, never asked for; softer is never fixed by pushing; the phrase start is low confidence', () => {
    const h = html(withTone([
      { key: 'rasp', diff: -0.12, strength: 1.5 },
      { key: 'level', diff: -5, strength: 1, detail: 'E3,F3' },
      { key: 'onset', diff: 0, strength: 1, detail: 'breathy>balanced' },
    ]));
    expect(h).toContain("The original has an edge here; don&#x27;t force it");
    expect(h).toContain('Details (low confidence)');
    expect(h).toMatch(/no need to push to match/);
    expect(h).toMatch(/Phrase start/);
    expect(h).not.toMatch(/more rasp|more grit|sing louder|louder/i);
    // every finding here is detail only: the main list says nothing needs changing
    expect(h).toContain('Nothing here needs changing.');
  });

  it('the index meters point the right way, and the sizes grow with the strength', () => {
    const h = html(withTone([
      { key: 'brightness', diff: -0.35, strength: 3.1 },
      { key: 'rasp', diff: 0.1, strength: 1.2 },
    ]));
    expect(h).toContain('darker than the original by 0.35');
    expect(h).toContain('tp-meter-fill--low');
    expect(h).toContain('much');
    expect(h).toContain('grittier than the original by 0.10');
    expect(h).toContain('width:35.0%');
  });

  it('never shows raw measurements (dB, Hz of the spectrum, alpha ratio, CPP)', () => {
    const everything = withTone([
      { key: 'breathiness', diff: 0.3, strength: 2 }, { key: 'brightness', diff: 0.3, strength: 2 }, { key: 'rasp', diff: 0.2, strength: 2 },
      { key: 'vibratoPresence', diff: -1, strength: 2 }, { key: 'vibratoStart', diff: 0.9, strength: 3 }, { key: 'vibratoRateHz', diff: 1.4, strength: 1.4 },
      { key: 'vibratoExtentCents', diff: -25, strength: 1.3 }, { key: 'level', diff: 6, strength: 2, detail: 'E3,F3' }, { key: 'register', diff: 0, strength: 1, detail: 'D3:mix>chest,E3:mix>chest' },
    ]);
    const h = html(everything);
    expect(h).not.toMatch(/\bdB\b|alpha|CPP|cepstral|H1|centroid|tilt/i);
    expect(h).toMatch(/original mix, yours chest|original mix; yours chest|original mix.*yours chest/);
  });
});
