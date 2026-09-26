// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContext, type AppController } from '../../state/context';
import { createInitialState } from '../../state/reducer';
import { GuidePage } from './Guide';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const app = {
    state: createInitialState({ voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' }, [], []),
  } as unknown as AppController;
  act(() =>
    root.render(
      <AppContext.Provider value={app}>
        <GuidePage />
      </AppContext.Provider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('GuidePage', () => {
  it('the table of contents moves keyboard focus to the chosen section heading', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const toc = Array.from(container.querySelectorAll('.guide-toc button')).find((b) => b.textContent === 'Look after your voice') as HTMLButtonElement;
    act(() => toc.click());
    expect(document.activeElement?.id).toBe('guide-health-h');
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
  });

  it('covers the safety, measurement and privacy caveats', () => {
    const text = container.textContent ?? '';
    expect(text).toMatch(/suddenly cuts out.*stop singing straight away/);
    expect(text).toMatch(/more than two weeks.*laryngologist/);
    expect(text).toMatch(/Falsetto and head voice/);
    expect(text).toMatch(/most reliable on open vowels/);
    expect(text).toMatch(/Compare your progress on the same device/);
    expect(text).toMatch(/contemporary pop and R&B singing.*higher\s+than the classical passaggio/);
    expect(text).toMatch(/fonts are bundled/);
    expect(text).toMatch(/github\.io/);
    // Plain voice-type names in the table, no nested parentheses.
    expect(text).not.toContain('))');
    expect(text).toContain('Baritone (yours)');
  });
});
