// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSessions } from '../../testing/fixtures';
import type { SessionRecord } from '../../types';
import { availableMetrics, ProgressPage, profileTabs } from './Progress';

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

function sessions(): SessionRecord[] {
  const shawn = makeFakeSessions(4, 'shawn-mendes').map((s) => ({ ...s, id: `sh${s.id}`, profileName: 'Shawn Mendes' }));
  const jalen = makeFakeSessions(2, 'jalen-ngonda').map((s, i) => ({
    ...s,
    id: `ja${s.id}`,
    profileName: 'Jalen Ngonda',
    createdAt: new Date(Date.UTC(2026, 8, 20 + i, 18)).toISOString(),
    dimensionScores: { rasp: 50 + i },
    label: i === 1 ? 'Chorus' : undefined,
  }));
  return [...shawn, ...jalen];
}

function button(re: RegExp): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll('button')).find((el) => re.test(el.textContent ?? ''));
  if (!b) throw new Error(`No button matching ${re}`);
  return b;
}

function chartLabels(): string[] {
  return Array.from(container.querySelectorAll('[role="img"]')).map((el) => el.getAttribute('aria-label') ?? '');
}

describe('ProgressPage', () => {
  it('explains how to save a take when there is no history', () => {
    act(() => root.render(<ProgressPage sessions={[]} onDelete={() => {}} onClear={() => {}} />));
    expect(container.textContent).toContain('No saved takes yet');
    expect(container.textContent).toContain('Save to progress');
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it('shows tabs per singer, defaults to the newest take and switches', () => {
    act(() => root.render(<ProgressPage sessions={sessions()} onDelete={() => {}} onClear={() => {}} />));
    const tabs = Array.from(container.querySelectorAll('.hist-tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(['Shawn Mendes 4', 'Jalen Ngonda 2']);
    // Jalen's takes are the newest.
    expect(tabs[1].getAttribute('aria-pressed')).toBe('true');
    expect(chartLabels()[0]).toContain('Overall match over 2 sessions');
    expect(chartLabels()[1]).toContain('Rasp score');

    act(() => (tabs[0] as HTMLButtonElement).click());
    expect(chartLabels()[0]).toContain('Overall match over 4 sessions');
    const select = container.querySelector<HTMLSelectElement>('#hist-metric-select')!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['breathiness', 'mixInUpperRange']);
    act(() => {
      select.value = 'mixInUpperRange';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(chartLabels()[1]).toContain('Mix above the passaggio score over 4 sessions');
  });

  it('lists every session newest first and deletes one', () => {
    const onDelete = vi.fn();
    act(() => root.render(<ProgressPage sessions={sessions()} onDelete={onDelete} onClear={() => {}} />));
    const rows = Array.from(container.querySelectorAll('.hist-row'));
    expect(rows).toHaveLength(6);
    expect(rows[0].textContent).toContain('Jalen Ngonda');
    expect(rows[0].textContent).toContain('Chorus');
    act(() => rows[0].querySelector('button')!.click());
    expect(onDelete).toHaveBeenCalledWith('jas1');
  });

  it('asks for confirmation in the page before clearing', () => {
    const onClear = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    act(() => root.render(<ProgressPage sessions={sessions()} onDelete={() => {}} onClear={onClear} />));
    act(() => button(/Clear history/).click());
    expect(container.textContent).toContain('Delete all 6 saved takes?');
    act(() => button(/Cancel/).click());
    expect(onClear).not.toHaveBeenCalled();
    act(() => button(/Clear history/).click());
    act(() => button(/Delete all/).click());
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('pages long histories', () => {
    const many = makeFakeSessions(30, 'daniel-caesar');
    act(() => root.render(<ProgressPage sessions={many} onDelete={() => {}} onClear={() => {}} />));
    expect(container.querySelectorAll('.hist-row')).toHaveLength(25);
    expect(container.querySelector('.hist-tabs')).toBeNull();
    act(() => button(/Show all 30 takes/).click());
    expect(container.querySelectorAll('.hist-row')).toHaveLength(30);
  });
});

describe('Progress helpers', () => {
  it('orders builtin singers first and counts sessions', () => {
    const extra = { ...makeFakeSessions(1, 'reference')[0], id: 'r', profileName: 'My clip' };
    const tabs = profileTabs([extra, ...sessions()]);
    expect(tabs.map((t) => t.id)).toEqual(['shawn-mendes', 'jalen-ngonda', 'reference']);
    expect(tabs[0].count).toBe(4);
  });

  it('finds the measures that have scores', () => {
    expect(availableMetrics(makeFakeSessions(2))).toEqual(['breathiness', 'mixInUpperRange']);
    expect(availableMetrics([])).toEqual([]);
  });
});
