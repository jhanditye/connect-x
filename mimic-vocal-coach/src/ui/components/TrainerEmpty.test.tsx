// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainerEmpty } from './TrainerEmpty';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('TrainerEmpty', () => {
  it('explains the three steps and offers two ways forward', () => {
    const onAdd = vi.fn();
    act(() => root.render(<TrainerEmpty onAdd={onAdd} />));
    const steps = Array.from(container.querySelectorAll('.te-step-title')).map((e) => e.textContent);
    expect(steps).toEqual(['Get a file into Files', 'Add it here', 'Practise phrase by phrase']);
    act(() => (container.querySelector('.te-add') as HTMLButtonElement).click());
    expect(onAdd).toHaveBeenCalledOnce();
    const help = Array.from(container.querySelectorAll('a')).find((a) => /How do I get a vocal/.test(a.textContent ?? ''));
    expect(help?.getAttribute('href')).toBe('#guide/guide-vocal');
    expect(Array.from(container.querySelectorAll('a')).some((a) => a.getAttribute('href') === '#studio')).toBe(true);
  });

  it('says how to get a vocal onto a phone: Files, Voice Memos, DRM-free purchases, stems, video', () => {
    act(() => root.render(<TrainerEmpty onAdd={() => undefined} />));
    const text = container.textContent ?? '';
    expect(text).toMatch(/Files app/);
    expect(text).toMatch(/Voice Memos/);
    expect(text).toMatch(/Save to Files/);
    expect(text).toMatch(/without copy protection/);
    expect(text).toMatch(/Apple Music/);
    expect(text).toMatch(/Vocal stems/);
    expect(text).toMatch(/Encode Media/);
    expect(text).toMatch(/Stays on this device|stays on this device|stay on this device/i);
  });

  it('keeps the guidance for people who have no clip, and says nothing is uploaded', () => {
    act(() => root.render(<TrainerEmpty onAdd={() => undefined} />));
    expect(container.textContent).toMatch(/Nothing is uploaded/);
    expect(container.querySelector('h2')?.textContent).toBe('No clips yet');
  });

  it('disables Add clips and says why while the library cannot take clips', () => {
    act(() => root.render(<TrainerEmpty onAdd={() => undefined} disabledReason="The library is still opening." />));
    expect((container.querySelector('.te-add') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('The library is still opening.');
  });
});
