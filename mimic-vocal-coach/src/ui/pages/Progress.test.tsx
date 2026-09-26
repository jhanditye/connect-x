// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareToProfile } from '../../coach/compare';
import { SINGERS } from '../../coach/profiles';
import { profileFromReference } from '../../coach/reference';
import { sessionFromResults } from '../../storage/history';
import { makeFakeAnalysis, makeFakeSessions } from '../../testing/fixtures';
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

function buttonIn(el: ParentNode, re: RegExp): HTMLButtonElement {
  const b = Array.from(el.querySelectorAll('button')).find((x) => re.test(x.textContent ?? ''));
  if (!b) throw new Error(`No button matching ${re}`);
  return b;
}

function button(re: RegExp): HTMLButtonElement {
  return buttonIn(container, re);
}

/** ProgressPage wired like the app: deleting and clearing change the sessions it is given. */
function Harness(props: { initial: SessionRecord[] }) {
  const [list, setList] = useState(props.initial);
  return <ProgressPage sessions={list} onDelete={(id) => setList((l) => l.filter((s) => s.id !== id))} onClear={() => setList([])} />;
}

function rowFor(re: RegExp): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.hist-row')).find((r) => re.test(r.textContent ?? ''));
  if (!row) throw new Error(`No row matching ${re}`);
  return row;
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

  it('lists every session newest first and deletes one after an in-page confirmation', () => {
    const onDelete = vi.fn();
    act(() => root.render(<ProgressPage sessions={sessions()} onDelete={onDelete} onClear={() => {}} />));
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.hist-row'));
    expect(rows).toHaveLength(6);
    expect(rows[0].textContent).toContain('Jalen Ngonda');
    expect(rows[0].textContent).toContain('Chorus');
    // One tap only opens the prompt; nothing is deleted yet.
    const del = rows[0].querySelector<HTMLButtonElement>('.hist-row-delete')!;
    act(() => del.click());
    expect(onDelete).not.toHaveBeenCalled();
    expect(del.getAttribute('aria-expanded')).toBe('true');
    expect(rows[0].textContent).toContain('Delete this take?');
    expect(document.activeElement?.textContent).toBe('Keep');
    // Keep closes the prompt and puts focus back on the row's Delete.
    act(() => buttonIn(rows[0], /^Keep$/).click());
    expect(rows[0].textContent).not.toContain('Delete this take?');
    expect(document.activeElement).toBe(del);
    expect(onDelete).not.toHaveBeenCalled();
    // Escape also keeps it.
    act(() => del.click());
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(rows[0].textContent).not.toContain('Delete this take?');
    expect(onDelete).not.toHaveBeenCalled();
    act(() => del.click());
    act(() => buttonIn(rows[0], /Yes, delete/).click());
    expect(onDelete).toHaveBeenCalledWith('jas1');
  });

  it('moves focus to the next row after a delete, and to the heading when the list ends', () => {
    act(() => root.render(<Harness initial={sessions().slice(3)} />));
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('.hist-row'));
    expect(rows()).toHaveLength(3);
    const secondDelete = rows()[1].querySelector<HTMLButtonElement>('.hist-row-delete')!;
    act(() => rows()[0].querySelector<HTMLButtonElement>('.hist-row-delete')!.click());
    act(() => buttonIn(rows()[0], /Yes, delete/).click());
    expect(rows()).toHaveLength(2);
    expect(document.activeElement).toBe(secondDelete);
    // Deleting the last row focuses the row above it.
    const last = rows()[1];
    const firstDelete = rows()[0].querySelector<HTMLButtonElement>('.hist-row-delete')!;
    act(() => last.querySelector<HTMLButtonElement>('.hist-row-delete')!.click());
    act(() => buttonIn(last, /Yes, delete/).click());
    expect(document.activeElement).toBe(firstDelete);
    // The very last take: focus lands on the empty-state message, not <body>.
    act(() => firstDelete.click());
    act(() => buttonIn(rows()[0], /Yes, delete/).click());
    expect(container.textContent).toContain('No saved takes yet');
    expect(document.activeElement).toBe(container.querySelector('.hist-empty-title'));
  });

  it('keeps focus in the page when clearing is cancelled or done', () => {
    act(() => root.render(<Harness initial={sessions()} />));
    act(() => button(/Clear history/).click());
    act(() => button(/Cancel/).click());
    expect(document.activeElement).toBe(button(/Clear history/));
    act(() => button(/Clear history/).click());
    act(() => button(/Delete all/).click());
    expect(container.textContent).toContain('History cleared');
    expect(document.activeElement).toBe(container.querySelector('.hist-empty-title'));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('gives each reference clip its own trend, labelled with the clip name', () => {
    const clip = (id: string, name: string, day: number) => ({
      ...makeFakeSessions(1)[0],
      id,
      profileId: `reference:${name}`,
      profileName: name,
      createdAt: new Date(Date.UTC(2026, 8, day, 12)).toISOString(),
    });
    const list = [clip('a', 'Get You (stem)', 1), clip('b', 'Get You (stem)', 2), clip('c', 'Stitches (stem)', 3)];
    act(() => root.render(<ProgressPage sessions={list} onDelete={() => {}} onClear={() => {}} />));
    const tabs = Array.from(container.querySelectorAll('.hist-tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(['Get You (stem) 2', 'Stitches (stem) 1']);
    expect(container.querySelector('.hist-singer')?.textContent).toBe('Against Stitches (stem), your reference clip');
    expect(chartLabels()[0]).toContain('one session');
    act(() => (tabs[0] as HTMLButtonElement).click());
    expect(chartLabels()[0]).toContain('Overall match over 2 sessions');
    expect(container.querySelector('.hist-singer')?.textContent).toBe('Against Get You (stem), your reference clip');
  });

  it('shows unscored takes in the list but leaves them out of the stats and trend', () => {
    const base = makeFakeSessions(3, 'shawn-mendes').map((s) => ({ ...s, profileName: 'Shawn Mendes' }));
    // An old save of a silent take: nothing measured, overall 0.
    const silent = { ...base[2], id: 'silent', overall: 0, dimensionScores: {} };
    act(() => root.render(<ProgressPage sessions={[base[0], base[1], silent]} onDelete={() => {}} onClear={() => {}} />));
    const stats = container.querySelector('.hist-stats')!.textContent;
    expect(stats).toContain('Takes3');
    expect(stats).toContain('Latest59');
    expect(stats).toContain('Since first+4');
    expect(container.textContent).toContain('One take had too little clear singing to score');
    expect(chartLabels()[0]).toContain('Overall match over 2 sessions');
    const row = rowFor(/Not scored/);
    expect(row.querySelector('.hist-row-score')?.textContent).toBe('Not scored–');
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

  it('keeps sessions against different reference clips apart (end to end through storage)', () => {
    const a = makeFakeAnalysis();
    const p1 = profileFromReference(makeFakeAnalysis({ breathiness: 0.7 }), 'Daniel - Get You (stem)', SINGERS[1]);
    const p2 = profileFromReference(makeFakeAnalysis({ breathiness: 0.2 }), 'Shawn - Stitches (stem)', SINGERS[0]);
    const s1 = sessionFromResults(a, compareToProfile(a, p1), p1);
    const s2 = { ...sessionFromResults(a, compareToProfile(a, p2), p2), createdAt: new Date(Date.now() + 1000).toISOString() };
    expect(profileTabs([s1, s2]).map((t) => t.name)).toEqual(['Daniel - Get You (stem)', 'Shawn - Stitches (stem)']);
  });

  it('finds the measures that have scores', () => {
    expect(availableMetrics(makeFakeSessions(2))).toEqual(['breathiness', 'mixInUpperRange']);
    expect(availableMetrics([])).toEqual([]);
  });
});
