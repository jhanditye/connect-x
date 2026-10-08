// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparePhrase } from '../../trainer/compare';
import { DEFAULT_TONE, HUMAN, PH_A, attemptAnalysis, humanize, refAnalysis } from '../../trainer/score/testkit';
import { COMPARISON_SCENARIOS, FAKE_PHRASE_NOTES, makeFakePhraseAnalysis, makeFakePhraseComparison } from '../../testing/trainerFixtures';
import { attemptFrames, describeOverlay, noteAtTime, nominalMidi, PhraseOverlayPlot, readoutFor, sungBars, timeModelOf } from './PhraseOverlayPlot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cssText = readFileSync(join(import.meta.dirname, 'phraseOverlay.css'), 'utf8');
const refFake = makeFakePhraseAnalysis();
const imgLabel = (html: string): string => {
  const m = /role="img"[^>]*aria-label="([^"]*)"|aria-label="([^"]*)"[^>]*role="img"/.exec(html);
  return (m?.[1] ?? m?.[2] ?? '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
};

describe('PhraseOverlayPlot (server markup, canned comparisons)', () => {
  it('draws a band per original note, the dashed original and a descriptive label, for every scenario', () => {
    for (const s of COMPARISON_SCENARIOS) {
      const html = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison(s, { shift: -12 })} />);
      expect(html, s).not.toContain('NaN');
      expect(html, s).not.toContain('undefined');
      expect((html.match(/class="pov-band/g) ?? []).length, s).toBe(FAKE_PHRASE_NOTES.length);
      expect(html, s).toContain('pov-ref');
      expect(imgLabel(html), s).toMatch(/^Your take against the original over \d+\.\d seconds, drawn in your key/);
    }
  });

  it('shows the key shift in words, and the detune when it is told', () => {
    const down = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('perfect', { shift: -12 })} />);
    expect(down).toContain('Shown in your key: an octave lower than the original.');
    const same = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('perfect', { shift: 0 })} />);
    expect(same).toContain('Shown in the original key.');
    const c = { ...makeFakePhraseComparison('perfect', { shift: -5 }), biasCents: -32 };
    expect(renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={c} />)).toMatch(/Shown in your key: 5 semitones lower than the original\. You sang about 32 cents under the original&#x27;s pitch grid/);
    expect(renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={c} keyMode="locked" />)).not.toContain('pitch grid');
  });

  it('marks what cost points with a shape: flat, wrong note, missed, and says so in the label', () => {
    const flat = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('flat', { shift: -12 })} />);
    expect((flat.match(/pov-mark pov-mark--warn/g) ?? []).length).toBe(2);
    expect(imgLabel(flat)).toMatch(/2 to work on: .*flat/);
    const wrong = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('wrong-note', { shift: -12 })} />);
    expect(wrong).toContain('pov-mark--line');
    expect(imgLabel(wrong)).toMatch(/wrong note/);
    const partial = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('partial', { shift: -12 })} />);
    expect((partial.match(/pov-band--missed/g) ?? []).length).toBe(4);
    expect((partial.match(/pov-mark--ring/g) ?? []).length).toBe(4);
    expect(imgLabel(partial)).toMatch(/4 missed/);
    const perfect = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('perfect', { shift: -12 })} />);
    expect(perfect).not.toContain('pov-mark');
    expect(imgLabel(perfect)).toContain('all sung notes on target');
  });

  it('draws the sung notes from the note table when there is no take analysis, and says so', () => {
    const html = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('late', { shift: 0 })} />);
    expect((html.match(/pov-take pov-take--bar/g) ?? []).length).toBe(FAKE_PHRASE_NOTES.length);
    expect(html).toContain('drawn from the note table');
  });

  it('a take that did not line up draws nothing of yours and says what to do', () => {
    const html = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('no-match')} />);
    expect(html).not.toContain('pov-take');
    expect(html).toContain('did not line up with the phrase');
    expect(imgLabel(html)).toContain('did not line up');
  });

  it('is a focusable group for the keyboard and a role=img for the picture', () => {
    const html = renderToStaticMarkup(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('flat')} />);
    expect(html).toMatch(/role="group"[^>]*tabindex="0"|tabindex="0"[^>]*role="group"/);
    expect(html).toContain('arrow keys');
    expect(html).toContain('role="img"');
  });
});

describe('the helpers', () => {
  it('noteAtTime picks the note under the time, or the nearest one', () => {
    const notes = makeFakePhraseComparison('perfect').notes;
    expect(noteAtTime(notes, 0.5)).toBe(0);
    expect(noteAtTime(notes, FAKE_PHRASE_NOTES[3].start + 0.2)).toBe(3);
    expect(noteAtTime(notes, 0)).toBe(0);
    expect(noteAtTime(notes, 99)).toBe(notes.length - 1);
    expect(noteAtTime([], 1)).toBeNull();
  });

  it('readout and label use plain words', () => {
    const c = makeFakePhraseComparison('flat', { shift: -12 });
    expect(readoutFor(c.notes[2])).toBe('Note 3, D3: flat 38 cents');
    expect(describeOverlay(c, 6.4)).toMatch(/8 notes, 8 sung; 2 to work on: D3: flat 38 cents; E3: flat 46 cents\.$/);
  });

  it('the original pitch in the singer\'s key is the reference note plus the shift', () => {
    const c = makeFakePhraseComparison('perfect', { shift: -12 });
    expect(nominalMidi(refFake, c.notes[0], -12)).toBeCloseTo(55 - 12, 5);
  });

  it('timeModelOf needs both numbers; bars sit at the sung pitch from the entrance for the length', () => {
    const c = makeFakePhraseComparison('late', { shift: 0 });
    expect(timeModelOf(c)).toBeNull();
    const bars = sungBars(refFake, c);
    expect(bars).toHaveLength(8);
    const n3 = c.notes[3];
    const bar = bars.find((b) => b.index === 3);
    expect(bar?.t0).toBeCloseTo(n3.refStart + 0.165, 3);
    expect(bar?.midi).toBeCloseTo(64 + 4 / 100, 3);
  });
});

describe('with a real take (synthetic singing through comparePhrase)', () => {
  const ref = refAnalysis(PH_A);
  const attempt = attemptAnalysis({ notes: humanize(PH_A, HUMAN.pro, 3), key: -5, lead: 1.7, tone: DEFAULT_TONE });
  const c = comparePhrase(attempt, ref, { mode: 'turn-taking', rate: 1, keyMode: 'free' });

  it('the take is mapped onto the original\'s clock through the fitted time model', () => {
    expect(c.score.status).toBe('ok');
    const model = timeModelOf(c);
    expect(model).not.toBeNull();
    const frames = attemptFrames(attempt, c);
    expect(frames.length).toBeGreaterThan(100);
    // the first sung note sits near the original's first note in the original's time
    const first = Math.min(...frames.map((f) => f.t));
    expect(Math.abs(first - c.notes[0].refStart)).toBeLessThan(0.3);
    // lead-in and tail silence are not drawn
    expect(Math.max(...frames.map((f) => f.t))).toBeLessThan(ref.durationSec + 0.5);
    expect(frames.every((f) => Number.isFinite(f.midi) && Number.isFinite(f.t))).toBe(true);
  });

  it('renders the take line and no table-bar fallback', () => {
    const html = renderToStaticMarkup(<PhraseOverlayPlot reference={ref} attempt={attempt} comparison={c} />);
    expect(html).toContain('pov-take"');
    expect(html).not.toContain('pov-take--bar');
    expect(html).not.toContain('NaN');
    expect(html).toContain('passaggio');
  });

  it('a gated comparison gives no frames', () => {
    const silent = comparePhrase(attemptAnalysis({ notes: [], lead: 1 }), ref, { mode: 'turn-taking', rate: 1, keyMode: 'free' });
    expect(attemptFrames(attempt, silent)).toEqual([]);
  });
});

describe('PhraseOverlayPlot (interaction)', () => {
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

  const fire = (el: Element, type: string, init: Record<string, unknown> = {}): void => {
    const ev = new MouseEvent(type, { bubbles: true, clientX: Number(init.clientX ?? 0) });
    Object.defineProperty(ev, 'pointerType', { value: init.pointerType ?? 'touch' }); // jsdom has no PointerEvent
    act(() => {
      el.dispatchEvent(ev);
    });
  };

  it('a touch reads out the note under it, and selects it', () => {
    const onSelect = vi.fn();
    act(() => root.render(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('flat', { shift: -12 })} onSelectNote={onSelect} />));
    const svg = container.querySelector('svg.pov-svg') as SVGSVGElement;
    expect(container.querySelector('.pov-readout')?.textContent).toMatch(/Touch/);
    // the plot is 300 px wide in jsdom (340 minus the axis): x = 150 is about the middle of the 6.45 s phrase
    fire(svg, 'pointerdown', { clientX: 150, pointerType: 'touch' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    const k = onSelect.mock.calls[0][0] as number;
    expect(k).toBeGreaterThanOrEqual(2);
    expect(k).toBeLessThanOrEqual(4);
    expect(container.querySelector('.pov-readout')?.textContent).toContain(`Note ${k + 1}`);
    expect(container.querySelector('.pov-cursor')).not.toBeNull();
    // a mouse leaving clears the readout; a finger lifting does not
    fire(svg, 'pointerout', { pointerType: 'touch' });
    expect(container.querySelector('.pov-cursor')).not.toBeNull();
    fire(svg, 'pointerout', { pointerType: 'mouse' });
    expect(container.querySelector('.pov-cursor')).toBeNull();
  });

  it('the arrow keys step through the notes, announce them, and Escape clears', () => {
    const onSelect = vi.fn();
    act(() => root.render(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('flat', { shift: -12 })} onSelectNote={onSelect} />));
    const group = container.querySelector('[role="group"]') as HTMLElement;
    const key = (k: string): void => {
      act(() => {
        group.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      });
    };
    key('ArrowRight');
    expect(onSelect).toHaveBeenLastCalledWith(0);
    key('ArrowRight');
    key('ArrowRight');
    expect(onSelect).toHaveBeenLastCalledWith(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Note 3, D3: flat 38 cents');
    expect(container.querySelector('.pov-readout')?.textContent).toBe('Note 3, D3: flat 38 cents');
    key('End');
    expect(onSelect).toHaveBeenLastCalledWith(7);
    key('Home');
    expect(onSelect).toHaveBeenLastCalledWith(0);
    key('ArrowLeft');
    expect(onSelect).toHaveBeenLastCalledWith(0);
    key('Escape');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('highlights the note the table selected', () => {
    act(() => root.render(<PhraseOverlayPlot reference={refFake} comparison={makeFakePhraseComparison('flat', { shift: -12 })} selectedNote={3} />));
    expect(container.querySelectorAll('.pov-band--selected')).toHaveLength(1);
  });
});

describe('phrase overlay styles', () => {
  const rules = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  it('use tokens only, no hard-coded colours', () => {
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\brgba?\(/);
  });
  it('keep a visible focus ring, let a vertical drag scroll the page, and respect reduced motion', () => {
    expect(rules).toMatch(/\.pov-scroll:focus-visible\s*\{[^}]*outline: 2px solid var\(--accent\)/);
    expect(rules).toMatch(/touch-action: pan-y/);
    expect(rules).toMatch(/prefers-reduced-motion: reduce/);
  });
  it('have no hover-only affordances', () => {
    expect(rules).not.toMatch(/:hover/);
  });
});
