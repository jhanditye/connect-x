// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCoachingPlan } from '../../coach/coach';
import { compareToProfile } from '../../coach/compare';
import { SINGERS } from '../../coach/profiles';
import { AppContext, type AppController } from '../../state/context';
import { createInitialState, saveKey, type Action, type AppState, type ReferenceClip } from '../../state/reducer';
import { makeFakeAnalysis, makeFakeProfile, makeFakeReferenceComparison } from '../../testing/fixtures';
import type { AppSettings, VoiceAnalysis } from '../../types';
import { hintWithoutFirstStep, measuredTuningCents, ResultsPage } from './Results';

vi.mock('../../coach/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../coach/ai')>();
  return {
    ...actual,
    askAiCoach: vi.fn(async (_input: unknown, _settings: unknown, onText: (d: string) => void) => {
      onText('Work on the top notes.');
      return 'Work on the top notes.';
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' };
const SHAWN = SINGERS[0];

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
});

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

/** A controller around a real scored result for `analysis` against Shawn. */
function controller(analysis: VoiceAnalysis, overrides: Partial<AppState> = {}, fns: Partial<AppController> = {}): AppController {
  const comparison = compareToProfile(analysis, SHAWN);
  const plan = buildCoachingPlan(analysis, comparison, SHAWN);
  const state: AppState = {
    ...createInitialState(SETTINGS, [], SINGERS),
    take: { samples: new Float32Array(10), sampleRate: 22050, source: 'upload', name: 'My take', durationSec: 12 },
    analysis,
    comparison,
    plan,
    takeSerial: 1,
    ...overrides,
  };
  const profiles = state.reference?.usable ? [...SINGERS, state.reference.profile] : SINGERS;
  return {
    state,
    dispatch: vi.fn(),
    builtins: SINGERS,
    profiles,
    profile: SHAWN,
    route: 'results',
    go: vi.fn(),
    analyzeSamples: vi.fn(async () => true),
    analyzeFile: vi.fn(async () => true),
    analyzeDemo: vi.fn(async () => true),
    loadReferenceFile: vi.fn(async () => true),
    setReferenceVoiceType: vi.fn(),
    clearReference: vi.fn(),
    selectProfile: vi.fn(),
    updateSettings: vi.fn(),
    saveSession: vi.fn(() => null),
    deleteSession: vi.fn(),
    clearSessions: vi.fn(),
    clearAllData: vi.fn(),
    openPractice: vi.fn(),
    recordDrill: vi.fn(),
    theme: 'system',
    setTheme: vi.fn(),
    ...fns,
  };
}

function render(app: AppController) {
  act(() => {
    root.render(
      <AppContext.Provider value={app}>
        <ResultsPage />
      </AppContext.Provider>,
    );
  });
}

function saveButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) => /Save/.test(b.textContent ?? ''));
}

function silentAnalysis(): VoiceAnalysis {
  const a = makeFakeAnalysis();
  const style = Object.fromEntries(Object.keys(a.style).map((k) => [k, null])) as unknown as VoiceAnalysis['style'];
  return {
    ...a,
    voicedSec: 0,
    voicedRatio: 0,
    style,
    warnings: ['No clear singing was detected.'],
    issues: ['too-little-singing'],
  };
}

function usableReference(): ReferenceClip {
  return {
    name: 'isolated-vocal',
    samples: new Float32Array(1),
    sampleRate: 22050,
    analysis: makeFakeAnalysis(),
    profile: makeFakeProfile({ id: 'reference', name: 'isolated-vocal', source: 'reference' }),
    baseProfileId: 'shawn-mendes',
    opts: { voiceType: 'baritone', a4Hz: 440 },
    artistVoiceType: null,
    usable: true,
    unusableReason: null,
    notices: [],
  };
}

describe('ResultsPage', () => {
  it('scores a normal take, with the key labelled as voice-type advice and save actions near the top', () => {
    const app = controller(makeFakeAnalysis());
    render(app);
    expect(container.querySelector('.dial')).not.toBeNull();
    expect(container.textContent).toContain('Key for your voice type');
    // Save and "Record another take" appear under the header facts as well as at the bottom.
    const quick = container.querySelector('.results-head .results-quick-actions');
    expect(quick?.textContent).toMatch(/Save to progress/);
    expect(quick?.textContent).toMatch(/Record another take/);
    const tabScores = Array.from(container.querySelectorAll('.singer-tab-score')).map((s) => s.textContent);
    expect(tabScores.every((t) => /^\d+$/.test(t ?? ''))).toBe(true);
    act(() => saveButtons()[0].click());
    expect(app.saveSession).toHaveBeenCalledWith('My take');
  });

  it('shows "Not scored" instead of a 0/100 dial for a take with no measurable singing, and cannot be saved', () => {
    const app = controller(silentAnalysis());
    render(app);
    expect(container.querySelector('.dial')).toBeNull();
    expect(container.querySelector('.not-scored')?.textContent).toContain('Not scored');
    expect(container.textContent).not.toMatch(/0 \/ 100|0 out of 100/);
    // Every tab shows a dash, not 0.
    const tabScores = Array.from(container.querySelectorAll('.singer-tab-score')).map((s) => s.textContent);
    expect(tabScores).toHaveLength(SINGERS.length);
    for (const t of tabScores) expect(t).toBe('–not scored');
    // The reasons and the recording advice are shown; the style meters are not.
    expect(container.textContent).toContain('No clear singing was detected.');
    expect(container.querySelectorAll('.coach-card').length).toBeGreaterThan(0);
    expect(container.querySelector('#style-heading')).toBeNull();
    for (const b of saveButtons()) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
      act(() => b.click());
    }
    expect(app.saveSession).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/can’t be scored, so there is nothing to save/);
  });

  it('shows a not-scored take’s recording warning once (in the notice), not again in the coaching card', () => {
    const warning = 'No clear singing was detected. Sing at least 10 seconds of sustained notes and try again.';
    render(controller({ ...silentAnalysis(), warnings: [warning] }));
    expect(container.querySelector('.notice')?.textContent).toContain(warning);
    expect(container.textContent!.split(warning).length - 1).toBe(1);
  });

  it('shows tuning as not measured, not 0¢, for a take with no pitched singing', () => {
    const silent: VoiceAnalysis = {
      ...silentAnalysis(),
      notes: [],
      pitch: { medianMidi: null, lowMidi: null, highMidi: null, tessituraLowMidi: null, tessituraHighMidi: null, tuningOffsetCents: 0 },
    };
    render(controller(silent));
    const tuning = Array.from(container.querySelectorAll('.facts > div')).find((d) => d.querySelector('dt')?.textContent === 'Tuning');
    expect(tuning?.querySelector('dd')?.textContent).toBe('–not measured');
    expect(container.querySelector('.results-head')?.textContent).not.toContain('0¢');
  });

  it('shows the measured tuning offset for a sung take', () => {
    render(controller(makeFakeAnalysis()));
    const tuning = Array.from(container.querySelectorAll('.facts > div')).find((d) => d.querySelector('dt')?.textContent === 'Tuning');
    expect(tuning?.querySelector('dd')?.textContent).toBe('+6¢');
  });

  it('lists the take’s own decode notes with the recording warnings, even after other jobs cleared state notices', () => {
    const note = 'Only the first 5 minutes of long (7.0 minutes long) were analysed.';
    render(
      controller(makeFakeAnalysis(), {
        notices: [],
        take: { samples: new Float32Array(10), sampleRate: 22050, source: 'upload', name: 'long', durationSec: 300, notices: [note] },
      }),
    );
    expect(container.querySelector('.notice')?.textContent).toContain(note);
  });

  it('reads a take already saved for this singer as saved, from app state', () => {
    const base = controller(makeFakeAnalysis());
    const app = controller(makeFakeAnalysis(), { savedKeys: [saveKey(base.state, SHAWN)] });
    render(app);
    const [top] = saveButtons();
    expect(top.textContent).toMatch(/Saved to Progress/);
    expect(top.getAttribute('aria-disabled')).toBe('true');
    act(() => top.click());
    expect(app.saveSession).not.toHaveBeenCalled();
  });

  it('does not print NaN or claim the pitch lined up when there was nothing to align', () => {
    const empty = { ...makeFakeReferenceComparison(), path: [], meanAbsCents: NaN, withinFiftyCents: 0, segments: [] };
    render(controller(makeFakeAnalysis(), { reference: usableReference(), referenceComparison: empty }));
    const section = container.querySelector('#ref-heading')?.closest('section');
    expect(section?.textContent).toContain('not enough pitched singing');
    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toContain('lined up');
    expect(container.textContent).not.toContain('dashed line');
  });

  it('shows share differences in percentage points', () => {
    const comp = { ...makeFakeReferenceComparison(), styleDiff: { vibratoPresence: -0.54, headInUpperRange: -0.71, breathiness: 0.12 } };
    render(controller(makeFakeAnalysis(), { reference: usableReference(), referenceComparison: comp }));
    const rows = Array.from(container.querySelectorAll('.diff-list li')).map((li) => li.textContent);
    expect(rows).toContain('Vibrato on held notes−54 percentage points, toward straight');
    expect(rows).toContain('Falsetto/head above the passaggio−71 percentage points, toward little falsetto');
    expect(rows).toContain('Breathiness+0.12, toward airy');
    expect(container.textContent).toContain('Your pitch lined up with');
  });

  it('stores the AI conversation in app state and shows it again from there', async () => {
    const withKey = { ...SETTINGS, anthropicApiKey: 'sk-ant-test' };
    const analysis = makeFakeAnalysis();
    const app = controller(analysis, { settings: withKey });
    render(app);
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((b) => /Ask the AI coach/.test(b.textContent ?? ''))!
        .click();
    });
    const calls = vi.mocked(app.dispatch).mock.calls.map(([a]) => a).filter((a) => a.type === 'ai/thread');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const last = calls[calls.length - 1] as Extract<Action, { type: 'ai/thread' }>;
    expect(last.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(last.turns[1].text).toBe('Work on the top notes.');
    // Coming back to Results (a fresh mount) shows the stored conversation for the same result...
    act(() => root.unmount());
    root = createRoot(container);
    render(controller(analysis, { settings: withKey, aiThread: { key: last.key, turns: last.turns } }));
    expect(container.querySelector('.ai-thread')?.textContent).toContain('Work on the top notes.');
    // ...but not one stored for a different result.
    act(() => root.unmount());
    root = createRoot(container);
    render(controller(analysis, { settings: withKey, aiThread: { key: 'another-take', turns: last.turns } }));
    expect(container.querySelector('.ai-thread')).toBeNull();
  });
});

describe('measuredTuningCents', () => {
  it('is null without pitched singing or with under a second of held notes, where the analysis reports 0', () => {
    const a = makeFakeAnalysis();
    expect(measuredTuningCents(a)).toBe(6);
    expect(measuredTuningCents({ ...a, pitch: { ...a.pitch, medianMidi: null } })).toBeNull();
    expect(measuredTuningCents({ ...a, notes: a.notes.slice(0, 1).map((n) => ({ ...n, end: n.start + 0.6 })) })).toBeNull();
  });
});

describe('hintWithoutFirstStep', () => {
  it('drops a trailing "Start here" that repeats the first numbered step', () => {
    expect(hintWithoutFirstStep('Try it on the chorus. Start here: sing the top note softly.', 'Sing the top note softly.')).toBe('Try it on the chorus.');
    expect(hintWithoutFirstStep('Try it. Start here: something else.', 'Sing softly.')).toBe('Try it. Start here: something else.');
    expect(hintWithoutFirstStep('No marker here.', 'Sing softly.')).toBe('No marker here.');
  });
});
