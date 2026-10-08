// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_CHECKLIST, QUICK_DIAGNOSTICS, type DiagnosticId, type DiagnosticProgress, type DiagnosticResult } from '../../audio/diagnostics';
import { saveFile } from '../components/download';
import { TrainerDiagnostics, TrainerDiagnosticsPage, type DiagnosticsRunner } from './TrainerDiagnostics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../components/download', async (importOriginal) => ({ ...(await importOriginal<typeof import('../components/download')>()), saveFile: vi.fn(async () => undefined) }));

let container: HTMLDivElement;
let root: Root;

const result = (id: DiagnosticId, over: Partial<DiagnosticResult> = {}): DiagnosticResult => ({
  id,
  label: `Label for ${id}`,
  status: 'ok',
  summary: `Summary of ${id}.`,
  details: { alpha: 1, beta: 'two' },
  ...over,
});

interface Runner extends DiagnosticsRunner {
  quickCalls: { signal?: AbortSignal; onResult?: (r: DiagnosticResult) => void }[];
  runCalls: { id: DiagnosticId; signal?: AbortSignal; onProgress?: (p: DiagnosticProgress) => void; resolve: (r: DiagnosticResult) => void }[];
  finishQuick: () => void;
}

/** A runner whose checks stay pending until the test settles them. */
function makeRunner(): Runner {
  const quickCalls: Runner['quickCalls'] = [];
  const runCalls: Runner['runCalls'] = [];
  let finishers: (() => void)[] = [];
  return {
    quickCalls,
    runCalls,
    finishQuick: () => finishers.splice(0).forEach((f) => f()),
    runQuickDiagnostics: vi.fn((o = {}) => {
      quickCalls.push(o);
      return new Promise<DiagnosticResult[]>((resolve) => finishers.push(() => resolve([])));
    }),
    runDiagnostic: vi.fn((id: DiagnosticId, o = {}) => {
      return new Promise<DiagnosticResult>((resolve) => runCalls.push({ id, signal: o.signal, onProgress: o.onProgress, resolve }));
    }),
  } as unknown as Runner;
}

const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')];
const byText = (text: string): HTMLButtonElement => {
  const b = buttons().find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}" in: ${buttons().map((x) => x.textContent).join(' | ')}`);
  return b;
};
const click = (el: Element): void => act(() => (el as HTMLElement).click());
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(saveFile).mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('TrainerDiagnostics: first view', () => {
  it('says what it is for, that no audio is kept, and what to tap first', () => {
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    expect(container.querySelector('h2')?.textContent).toBe('Device check');
    expect(container.textContent).toMatch(/Nothing here records or keeps\s+audio/);
    expect(container.textContent).toContain('Nothing has run yet. Tap the button above');
    expect(byText('Run the quick checks')).toBeTruthy();
    expect(container.textContent).toContain('The report is nearly empty because nothing has run yet');
  });

  it('has the four steps in order, and the page wrapper', () => {
    act(() => root.render(<TrainerDiagnosticsPage runner={makeRunner()} />));
    expect([...container.querySelectorAll('.td-step')].map((h) => h.textContent?.replace(/^\d\s*/, ''))).toEqual(['Quick checks', 'Microphone and sound', 'On your iPhone', 'Share the report']);
    expect(container.querySelector('.page--diagnostics')).not.toBeNull();
  });
});

describe('quick checks', () => {
  it('start from the tap, show results as they arrive with a word and an icon, and keep sensitive numbers out', async () => {
    const runner = makeRunner();
    act(() => root.render(<TrainerDiagnostics runner={runner} />));
    click(byText('Run the quick checks'));
    expect(runner.runQuickDiagnostics).toHaveBeenCalledTimes(1); // called inside the click, not after an await
    expect(byText('Checking…').getAttribute('aria-disabled')).toBe('true');
    expect(byText('Stop')).toBeTruthy();
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/Running the quick checks/);

    act(() => runner.quickCalls[0].onResult?.(result('audio-context', { status: 'warn', summary: 'Did not start.' })));
    act(() => runner.quickCalls[0].onResult?.(result('route', { status: 'fail', summary: 'No microphone.', details: { count: 0, 'microphone.1.name': "Sam's Zed Buds" }, sensitive: ['microphone.1.name'] })));
    const rows = [...container.querySelectorAll('.td-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Check this');
    expect(rows[1].textContent).toContain('Problem');
    expect(rows[1].textContent).toContain('No microphone.');
    expect(rows[1].querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toContain('Zed Buds');
    expect(rows[1].querySelector('details summary')?.textContent).toBe('The numbers');

    act(() => runner.finishQuick());
    await flush();
    expect(byText('Run the quick checks again').getAttribute('aria-disabled')).toBeNull();
    expect(container.textContent).not.toContain('Stop');
  });

  it('Stop aborts the run', () => {
    const runner = makeRunner();
    act(() => root.render(<TrainerDiagnostics runner={runner} />));
    click(byText('Run the quick checks'));
    expect(runner.quickCalls[0].signal?.aborted).toBe(false);
    click(byText('Stop'));
    expect(runner.quickCalls[0].signal?.aborted).toBe(true);
  });

  it('a rejecting runner does not leave the page stuck', async () => {
    const runner = makeRunner();
    runner.runQuickDiagnostics = vi.fn(() => Promise.reject(new Error('boom')));
    act(() => root.render(<TrainerDiagnostics runner={runner} />));
    click(byText('Run the quick checks'));
    await flush();
    await flush();
    expect(byText('Run the quick checks').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('microphone and click tests', () => {
  it('the level check starts from the tap, shows the meter and the words, then the verdict', async () => {
    const runner = makeRunner();
    act(() => root.render(<TrainerDiagnostics runner={runner} />));
    click(byText('Start the 10 second check'));
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0].id).toBe('mic-level');
    // The other tests are off while one runs.
    expect(byText('Start the click test').getAttribute('aria-disabled')).toBe('true');
    expect(byText('Run the quick checks').getAttribute('aria-disabled')).toBe('true');
    act(() => runner.runCalls[0].onProgress?.({ fraction: 0.4, level: 0.55, message: 'Good level' }));
    const meter = container.querySelector('[role="meter"]') as HTMLElement;
    expect(meter.getAttribute('aria-valuenow')).toBe('55');
    expect(container.textContent).toContain('Good level');
    expect((container.querySelector('[role="progressbar"]') as HTMLElement).getAttribute('aria-valuenow')).toBe('40');

    act(() => runner.runCalls[0].resolve(result('mic-level', { summary: 'Singing level -20 dBFS.' })));
    await flush();
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(container.textContent).toContain('Singing level -20 dBFS.');
    expect(byText('Run it again').getAttribute('aria-disabled')).toBeNull();
    expect(byText('Start the click test').getAttribute('aria-disabled')).toBeNull();
  });

  it('the click test and Stop', async () => {
    const runner = makeRunner();
    act(() => root.render(<TrainerDiagnostics runner={runner} />));
    click(byText('Start the click test'));
    expect(runner.runCalls[0].id).toBe('click-probe');
    expect(container.textContent).toContain('Starting the microphone. Allow it if asked.');
    act(() => runner.runCalls[0].onProgress?.({ fraction: 0.3, message: 'Playing four clicks.' }));
    expect(container.textContent).toContain('Playing four clicks.');
    click(byText('Stop'));
    expect(runner.runCalls[0].signal?.aborted).toBe(true);
    act(() => runner.runCalls[0].resolve(result('click-probe', { status: 'info', summary: 'Stopped before it finished.' })));
    await flush();
    expect(container.textContent).toContain('Stopped before it finished.');
  });

  it('unmounting during a test aborts it and nothing is updated afterwards', async () => {
    const runner = makeRunner();
    act(() => root.render(<TrainerDiagnostics runner={runner} />));
    click(byText('Start the 10 second check'));
    const signal = runner.runCalls[0].signal;
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runner.runCalls[0].resolve(result('mic-level'));
    await Promise.resolve();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
    root = createRoot(container); // so afterEach can unmount
  });
});

describe('checklist', () => {
  it('has every item as a group with steps, what should happen and three answers', () => {
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    const items = container.querySelectorAll('fieldset.td-item');
    expect(items).toHaveLength(DEVICE_CHECKLIST.length);
    for (const it of items) {
      expect(it.querySelector('legend')?.textContent?.length).toBeGreaterThan(5);
      expect(it.querySelectorAll('ol li').length).toBeGreaterThan(0);
      expect(it.textContent).toContain('What should happen:');
      expect([...it.querySelectorAll('label.td-answer span')].map((s) => s.textContent)).toEqual(['It did', 'It did not', 'Skipped']);
    }
  });

  it('answers go into the report and the count shows', () => {
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    const first = container.querySelectorAll('fieldset.td-item')[0];
    const second = container.querySelectorAll('fieldset.td-item')[1];
    click(first.querySelectorAll('input')[0]);
    click(second.querySelectorAll('input')[1]);
    expect(container.textContent).toContain(`2 of ${DEVICE_CHECKLIST.length} answered.`);
    const report = container.querySelector('.td-report')?.textContent ?? '';
    expect(report).toContain('Checklist on the device:');
    expect(report).toMatch(/PASS\s+The guide plays with the side switch on silent/);
    expect(report).toMatch(/FAIL\s+Sound goes to the headphones/);
    expect(container.textContent).not.toContain('The report is nearly empty');
  });
});

describe('the report', () => {
  function stubClipboard(write: (t: string) => Promise<void>): void {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
  }

  it('copies the report text, says so, and includes notes', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    const notes = container.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(notes, 'iPhone 15, EarPods');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(byText('Copy the report'));
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain('Mimic Vocal Coach: device report');
    expect(text).toContain('iPhone 15, EarPods');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied. Paste it into a message to whoever is helping you.');
  });

  it('when copying is refused it opens the report and names the way out', async () => {
    stubClipboard(async () => Promise.reject(new Error('NotAllowedError')));
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    click(byText('Copy the report'));
    await flush();
    expect(container.textContent).toContain('Could not copy by itself');
    expect(container.textContent).toContain('select all of it');
    expect(container.querySelector('details.td-preview')?.hasAttribute('open')).toBe(true);
  });

  it('with no clipboard API at all it says the same', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    click(byText('Copy the report'));
    await flush();
    expect(container.textContent).toContain('Could not copy by itself');
  });

  it('microphone names are out of the report until the box is ticked', () => {
    const runner = makeRunner();
    act(() => root.render(<TrainerDiagnostics runner={runner} />));
    click(byText('Run the quick checks'));
    act(() => runner.quickCalls[0].onResult?.(result('route', { details: { 'microphone.1.name': "Sam's Zed Buds" }, sensitive: ['microphone.1.name'] })));
    expect(container.querySelector('.td-report')?.textContent).not.toContain('Zed Buds');
    expect(container.querySelector('.td-report')?.textContent).toContain('Microphone names are left out');
    click(container.querySelector('.td-check input')!);
    expect(container.querySelector('.td-report')?.textContent).toContain("Sam's Zed Buds");
  });

  it('Share appears only where the browser can share, and Save goes through the app saver', async () => {
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    expect(buttons().some((b) => b.textContent?.includes('Share'))).toBe(false);
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    act(() => root.render(<TrainerDiagnostics key="again" runner={makeRunner()} />));
    click(byText('Share…'));
    await flush();
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mimic device report', text: expect.stringContaining('device report') }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Shared.');
    click(byText('Save as a file'));
    await flush();
    expect(saveFile).toHaveBeenCalledTimes(1);
    const [blob, name] = vi.mocked(saveFile).mock.calls[0];
    expect(name).toBe('mimic-device-report.txt');
    expect(blob.type).toBe('text/plain');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Saved. Share the file with whoever is helping you.');
  });

  it('closing the share sheet is not an error', async () => {
    vi.stubGlobal('navigator', { ...navigator, share: vi.fn(async () => Promise.reject(Object.assign(new Error('cancel'), { name: 'AbortError' }))) });
    act(() => root.render(<TrainerDiagnostics runner={makeRunner()} />));
    click(byText('Share…'));
    await flush();
    expect(container.textContent).not.toContain('Could not copy by itself');
  });
});

describe('stylesheet', () => {
  const css = readFileSync(join(import.meta.dirname, 'trainerDiagnostics.css'), 'utf8');

  it('uses tokens only: no hex or rgb colours', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it('keeps touch targets at 44px, the notes field at the 16px body size and honours reduced motion', () => {
    for (const sel of ['.td-answer span', '.td-numbers summary', '.td-preview summary', '.td-check']) {
      const block = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*min-height:\\s*44px`).test(css);
      expect(block, sel).toBe(true);
    }
    expect(css).toMatch(/\.td-notes\s*\{[^}]*font-size:\s*var\(--fs-md\)/);
    expect(css).toMatch(/prefers-reduced-motion: no-preference/);
    expect(css).toMatch(/:focus-visible/);
  });

  it('is imported by the page', () => {
    const tsx = readFileSync(join(import.meta.dirname, 'TrainerDiagnostics.tsx'), 'utf8');
    expect(tsx).toContain("import './trainerDiagnostics.css'");
    expect(QUICK_DIAGNOSTICS.length).toBeGreaterThan(5);
  });
});
