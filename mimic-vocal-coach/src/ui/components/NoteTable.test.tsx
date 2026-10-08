// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPARISON_SCENARIOS, makeFakePhraseComparison } from '../../testing/trainerFixtures';
import type { PhraseComparison } from '../../types';
import { NoteTable } from './NoteTable';
import { flagWord, formatMs, keyCaption, noteSummary } from './noteWords';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = (c: PhraseComparison, props: Partial<Parameters<typeof NoteTable>[0]> = {}): string => renderToStaticMarkup(<NoteTable comparison={c} {...props} />);
const words = (h: string): string[] => [...h.matchAll(/<span class="nt-word">([^<]*)<\/span>/g)].map((m) => m[1]);

describe('NoteTable (server markup, canned comparisons)', () => {
  it('has the five columns and one row per original note, for every scenario', () => {
    for (const s of COMPARISON_SCENARIOS) {
      const c = makeFakePhraseComparison(s, { shift: -12 });
      const h = html(c);
      expect(h, s).not.toContain('NaN');
      expect(h, s).not.toContain('undefined');
      if (s === 'no-match') continue;
      expect([...h.matchAll(/<th scope="col"/g)], s).toHaveLength(5);
      expect([...h.matchAll(/<th scope="row"/g)], s).toHaveLength(8);
      for (const head of ['Note', 'You', 'Pitch', 'Timing', 'Length']) expect(h, s).toContain(`>${head}</th>`);
    }
  });

  it('a perfect take has no flag words, only "ok" marks', () => {
    const h = html(makeFakePhraseComparison('perfect', { shift: -12 }));
    expect(words(h)).toEqual([]);
    expect((h.match(/nt-word--ok/g) ?? []).length).toBe(8);
  });

  it('a flat take says "flat" on the two notes, with the figure and a tint, not colour alone', () => {
    const h = html(makeFakePhraseComparison('flat', { shift: -12 }));
    expect(words(h)).toEqual(['flat', 'flat']);
    expect(h).toContain('−38¢');
    expect(h).toContain('−46¢');
    expect((h.match(/nt-cell--warn/g) ?? []).length).toBe(2);
  });

  it('a late take says "late" with the milliseconds', () => {
    const h = html(makeFakePhraseComparison('late', { shift: 0 }));
    expect(words(h)).toEqual(['late', 'late', 'late']);
    expect(h).toContain('+165 ms');
    expect(h).toContain('+180 ms');
  });

  it('a wrong note shows what was sung; the note it ran into is "ran together" with no timing figures', () => {
    const c = makeFakePhraseComparison('wrong-note', { shift: -12 });
    const h = html(c);
    expect(words(h)).toContain('wrong note');
    expect(words(h)).toContain('ran together');
    expect(h).toContain('nt-cell--bad');
    expect(h).toContain('>E3<'); // what was sung on D3
    expect(h).toContain('+204¢');
  });

  it('a half-sung take lists the missed notes', () => {
    const h = html(makeFakePhraseComparison('partial', { shift: -12 }));
    expect(words(h).filter((w) => w === 'missed')).toHaveLength(4);
    expect((h.match(/nt-cell--bad/g) ?? []).length).toBe(4);
  });

  it('a note outside the range the app can follow in the singer\'s key is "out of range", not "missed"', () => {
    const h = html(makeFakePhraseComparison('partial', { shift: -30 }));
    expect(words(h).filter((w) => w === 'out of range')).toHaveLength(4);
    expect(words(h)).not.toContain('missed');
    const note = makeFakePhraseComparison('partial', { shift: -30 }).notes[6];
    expect(noteSummary(note)).toMatch(/outside the range the app can follow/);
    expect(noteSummary(makeFakePhraseComparison('partial', { shift: 0 }).notes[6])).toMatch(/not sung$/);
  });

  it('a take that did not line up has an empty state that names the next step', () => {
    const h = html(makeFakePhraseComparison('no-match'));
    expect(h).not.toContain('<table');
    expect(h).toMatch(/did not line up with the phrase/);
    expect(h).toMatch(/try again/);
    const low: PhraseComparison = { ...makeFakePhraseComparison('perfect'), score: { ...makeFakePhraseComparison('perfect').score, status: 'low-evidence' } };
    expect(html(low)).toMatch(/too little singing/);
    expect(html(low)).toMatch(/microphone/);
  });

  it('a phrase with no notes says what to do', () => {
    expect(html({ ...makeFakePhraseComparison('perfect'), notes: [] })).toMatch(/phrase editor/);
  });

  it('a speech-like phrase says only rhythm and melody shape are compared and leaves out the pitch figures', () => {
    const c = makeFakePhraseComparison('perfect');
    const speech: PhraseComparison = { ...c, score: { ...c.score, kind: 'speech-like' } };
    const h = html(speech);
    expect(h).toContain('Speech-like phrase');
    expect(h).not.toContain('¢');
  });

  it('rows are static text without a handler and buttons with one; the selected row is pressed', () => {
    const c = makeFakePhraseComparison('flat', { shift: -12 });
    expect(html(c)).not.toContain('<button');
    const h = html(c, { onSelect: () => undefined, selected: 3, actionHint: 'Loops this note at 75 percent' });
    expect((h.match(/<button/g) ?? []).length).toBe(8);
    expect((h.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(h).toContain('Loops this note at 75 percent');
    expect(h).toContain('nt-row--selected');
  });

  it('has a caption for screen readers that counts what needs work', () => {
    expect(html(makeFakePhraseComparison('flat'))).toContain('2 of 8 to work on');
    expect(html(makeFakePhraseComparison('perfect'))).toContain('0 of 8 to work on');
  });
});

describe('NoteTable (interaction)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('a tap on a row hands that note to the parent', () => {
    const onSelect = vi.fn();
    act(() => root.render(<NoteTable comparison={makeFakePhraseComparison('flat', { shift: -12 })} onSelect={onSelect} />));
    const buttons = container.querySelectorAll('button.nt-button');
    expect(buttons).toHaveLength(8);
    act(() => (buttons[3] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].refIndex).toBe(3);
    expect(buttons[3].getAttribute('aria-label')).toBe('Note 4. E3: flat 46 cents');
  });
});

describe('note words', () => {
  it('flags have words; ok and ornament have none', () => {
    expect(flagWord('sharp')).toBe('sharp');
    expect(flagWord('wrong-note')).toBe('wrong note');
    expect(flagWord('ok')).toBeNull();
    expect(flagWord('ornament')).toBeNull();
  });

  it('milliseconds keep their sign with a true minus', () => {
    expect(formatMs(125.4)).toBe('+125 ms');
    expect(formatMs(-120)).toBe('−120 ms');
    expect(formatMs(0.2)).toBe('0 ms');
    expect(formatMs(null)).toBe('–');
    expect(formatMs(Number.NaN)).toBe('–');
  });

  it('a note is summarised in one line, never empty', () => {
    const c = makeFakePhraseComparison('wrong-note', { shift: -12 });
    expect(noteSummary(c.notes[2])).toBe('D3: wrong note, you sang E3');
    expect(noteSummary(c.notes[3])).toBe('E3: ran into the next note');
    expect(noteSummary(makeFakePhraseComparison('perfect').notes[0])).toMatch(/: on target$/);
    expect(noteSummary(makeFakePhraseComparison('partial').notes[6])).toMatch(/: not sung$/);
    for (const s of COMPARISON_SCENARIOS) for (const n of makeFakePhraseComparison(s).notes) expect(noteSummary(n).length).toBeGreaterThan(3);
  });

  it('the key line says what is shown and what was not marked down', () => {
    expect(keyCaption(0, 3)).toBe('Shown in the original key.');
    expect(keyCaption(-12, 0)).toBe('Shown in your key: an octave lower than the original.');
    expect(keyCaption(-24, 0)).toBe('Shown in your key: 2 octaves lower than the original.');
    expect(keyCaption(1, 0)).toBe('Shown in your key: 1 semitone higher than the original.');
    expect(keyCaption(3, 25)).toMatch(/3 semitones higher than the original\. You sang about 25 cents over/);
    expect(keyCaption(3, 25, 'locked')).toBe('Shown in your key: 3 semitones higher than the original.');
  });
});

describe('note table styles', () => {
  const rules = readFileSync(join(import.meta.dirname, 'phraseCompare.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('use tokens only', () => {
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\brgba?\(/);
  });
  it('rows are 44 px touch targets with a visible focus ring, and the table cannot widen the page', () => {
    expect(rules).toMatch(/\.nt-button,\s*\.nt-static\s*\{[^}]*min-height: 44px/);
    expect(rules).toMatch(/\.nt-button:focus-visible\s*\{[^}]*outline: 2px solid var\(--accent\)/);
    expect(rules).toMatch(/table-layout: fixed/);
    expect(rules).toMatch(/\.nt-table\s*\{[^}]*width: 100%/);
  });
  it('no hover-only affordances, and reduced motion is respected', () => {
    expect(rules).not.toMatch(/:hover/);
    expect(rules).toMatch(/prefers-reduced-motion: reduce/);
  });
});
