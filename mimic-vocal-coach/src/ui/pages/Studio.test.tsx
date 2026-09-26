// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecorder, microphoneUnavailableReason, RecorderError } from '../../audio/recorder';
import { AppContext, type AppController } from '../../state/context';
import { createInitialState, type AppState, type ReferenceClip } from '../../state/reducer';
import { makeFakeAnalysis, makeFakeProfile } from '../../testing/fixtures';
import type { AppSettings } from '../../types';
import { StudioPage } from './Studio';

// Other engineers' modules are replaced so this test pins down only the Studio's own behaviour.
vi.mock('../../analysis/passaggio', () => ({
  passaggioFor: () => ({ lowMidi: 62, highMidi: 67 }),
  // The real labels carry a gloss in parentheses; the plain names are for running text.
  VOICE_TYPE_LABELS: {
    bass: 'Bass (lowest male voice)',
    baritone: 'Baritone (most male pop voices)',
    tenor: 'Tenor (higher male voice)',
    alto: 'Alto (lowest female voice)',
    mezzo: 'Mezzo-soprano (most female pop voices)',
    soprano: 'Soprano (highest female voice)',
  },
  VOICE_TYPE_NAMES: { bass: 'Bass', baritone: 'Baritone', tenor: 'Tenor', alto: 'Alto', mezzo: 'Mezzo-soprano', soprano: 'Soprano' },
}));
vi.mock('../../audio/recorder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audio/recorder')>();
  return { ...actual, microphoneUnavailableReason: vi.fn(actual.microphoneUnavailableReason), createRecorder: vi.fn(actual.createRecorder) };
});
vi.mock('../../coach/exercises', () => ({
  getExercise: (id: string) => (id === 'straw' ? { id, name: 'Straw phonation', goal: 'Balance airflow.' } : undefined),
  EXERCISES: [],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' };
const BUILTINS = [
  makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes', tagline: 'Bright pop tenor mix', color: '#b97a12' }),
  makeFakeProfile({ id: 'daniel-caesar', name: 'Daniel Caesar', tagline: 'Airy, intimate R&B', color: '#3a7556' }),
  makeFakeProfile({ id: 'jalen-ngonda', name: 'Jalen Ngonda', tagline: 'Soul falsetto', color: '#b23c49' }),
];

function controller(overrides: Partial<AppState> = {}, fns: Partial<AppController> = {}): AppController {
  const state = { ...createInitialState(SETTINGS, [], BUILTINS), ...overrides };
  return {
    state,
    dispatch: vi.fn(),
    builtins: BUILTINS,
    profiles: BUILTINS,
    profile: BUILTINS.find((b) => b.id === state.selectedProfileId) ?? null,
    route: 'studio',
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
    measureClips: vi.fn(async () => ({ added: 0, rejected: [] })),
    removeMeasuredClip: vi.fn(),
    clearMeasuredClips: vi.fn(),
    openPractice: vi.fn(),
    recordDrill: vi.fn(),
    theme: 'system',
    setTheme: vi.fn(),
    ...fns,
  };
}

let container: HTMLDivElement;
let root: Root;

const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

function referenceClip(overrides: Partial<ReferenceClip> = {}): ReferenceClip {
  return {
    name: 'song-mix',
    samples: new Float32Array(1),
    sampleRate: 22050,
    analysis: makeFakeAnalysis(),
    profile: makeFakeProfile({ id: 'reference', name: 'song-mix', source: 'reference' }),
    baseProfileId: 'shawn-mendes',
    opts: { voiceType: 'baritone', a4Hz: 440 },
    artistVoiceType: null,
    usable: true,
    unusableReason: null,
    notices: [],
    ...overrides,
  };
}

function render(app: AppController) {
  act(() => {
    root.render(
      <AppContext.Provider value={app}>
        <StudioPage />
      </AppContext.Provider>,
    );
  });
}

function button(text: RegExp): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll('button')).find((el) => text.test(el.textContent ?? ''));
  if (!b) throw new Error(`No button matching ${text}`);
  return b;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('StudioPage', () => {
  it('renders the three singers plus the reference card, with the selected one pressed', () => {
    render(controller());
    const cards = Array.from(container.querySelectorAll<HTMLButtonElement>('.singer-card'));
    expect(cards.map((c) => c.querySelector('.singer-card-name')?.textContent)).toEqual(['Shawn Mendes', 'Daniel Caesar', 'Jalen Ngonda', 'Reference clip']);
    expect(cards[0].getAttribute('aria-pressed')).toBe('true');
    expect(cards[1].getAttribute('aria-pressed')).toBe('false');
    expect(cards[0].style.getPropertyValue('--card-color')).toBe('var(--singer-shawn)');
    // Selected singer panel: description, traits and study songs.
    expect(container.querySelector('#singer-panel-name')?.textContent).toBe('Shawn Mendes');
    expect(container.textContent).toContain('Example Song');
  });

  it('offers to measure the selected singer from real recordings', async () => {
    const measureClips = vi.fn(async () => ({ added: 1, rejected: [{ name: 'full-mix', reason: 'This clip sounds like a full song mix.' }] }));
    render(controller({}, { measureClips }));
    expect(container.querySelector('#measure-heading')?.textContent).toBe('Measure Shawn from real recordings');
    expect(container.textContent).toContain('These targets are estimates from listening');
    const input = container.querySelector<HTMLInputElement>('.measure input[type="file"]')!;
    expect(input.multiple).toBe(true);
    const files = [new File(['x'], 'stitches-vocal.wav', { type: 'audio/wav' }), new File(['x'], 'full-mix.mp3', { type: 'audio/mpeg' })];
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(measureClips).toHaveBeenCalledWith('shawn-mendes', files, expect.any(Function));
    expect(container.textContent).toContain('Added 1 clip.');
    expect(container.textContent).toContain('full song mix');
  });

  it('shows measured clips on the card and in the panel', () => {
    const clip = {
      id: 'c1',
      name: 'Stitches vocal',
      addedAt: '2026-09-26T10:00:00.000Z',
      durationSec: 30,
      voicedSec: 24,
      style: makeFakeAnalysis().style,
      pitch: { lowMidi: 50, highMidi: 70, tessituraLowMidi: 55, tessituraHighMidi: 65 },
    };
    const removeMeasuredClip = vi.fn();
    render(controller({ measurements: { 'shawn-mendes': [clip] } }, { removeMeasuredClip }));
    expect(container.querySelector('.singer-card .singer-card-footer')?.textContent).toBe('Measured from 1 clip');
    expect(container.textContent).toContain('Stitches vocal');
    act(() => button(/^Remove$/).click());
    expect(removeMeasuredClip).toHaveBeenCalledWith('shawn-mendes', 'c1');
  });

  it('selecting a singer goes through the controller', () => {
    const app = controller();
    render(app);
    act(() => button(/Daniel Caesar/).click());
    expect(app.selectProfile).toHaveBeenCalledWith('daniel-caesar');
  });

  it('points to upload when the microphone is unavailable (jsdom has no getUserMedia)', () => {
    render(controller());
    const record = button(/^Record$/);
    expect(record.disabled).toBe(true);
    expect(container.textContent).toMatch(/Recording is not available here/);
    expect(container.textContent).toMatch(/record a voice memo on your phone/i);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.accept).toContain('audio/*');
    expect(input?.accept).toContain('.m4a');
  });

  it('runs the demo take and opens the results', async () => {
    const app = controller();
    render(app);
    await act(async () => button(/Try a demo take/).click());
    expect(app.analyzeDemo).toHaveBeenCalledTimes(1);
    expect(app.go).toHaveBeenCalledWith('results');
  });

  it('uploads a chosen audio file and rejects non-audio files with a message', async () => {
    const app = controller();
    render(app);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = (file: File) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await act(async () => choose(new File(['x'], 'notes.pdf', { type: 'application/pdf' })));
    expect(app.analyzeFile).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/does not look like an audio file/);
    const memo = new File(['x'], 'memo.m4a', { type: 'audio/mp4' });
    await act(async () => choose(memo));
    expect(app.analyzeFile).toHaveBeenCalledWith(memo);
    expect(app.go).toHaveBeenCalledWith('results');
  });

  it('announces the job once in a live region (not every percentage) and disables capture while busy', () => {
    render(controller({ status: 'analyzing', job: 'take', progress: 0.4, progressLabel: 'Analysing Demo take' }));
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('40');
    const live = container.querySelector('.capture [role="status"][aria-live="polite"]');
    expect(live?.textContent).toBe('Analysing Demo take');
    expect(live?.contains(bar)).toBe(false);
    expect(button(/Try a demo take/).disabled).toBe(true);
  });

  it('keeps the progress live region mounted while idle so the first announcement is not lost', () => {
    render(controller());
    const live = container.querySelector('.capture [role="status"][aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe('');
  });

  it('shows errors as alerts that can be dismissed', () => {
    const app = controller({ error: 'Could not read song.mp3.' });
    render(app);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not read song.mp3.');
    act(() => (alert?.querySelector('button') as HTMLButtonElement).click());
    expect(app.dispatch).toHaveBeenCalledWith({ type: 'error/clear' });
  });

  it('shows an upload error next to the upload control, not at the top of the page', () => {
    render(controller({ error: '"fake.wav" could not be decoded.', errorJob: 'take' }));
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    const capture = container.querySelector('.capture')!;
    expect(capture.contains(alerts[0])).toBe(true);
    // After the demo row, i.e. right under the upload box.
    const demoRow = capture.querySelector('.demo-row')!;
    expect(demoRow.compareDocumentPosition(alerts[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a reference-clip error inside the reference panel, opening it if needed', () => {
    render(controller({ error: 'Could not read clip.mp3.', errorJob: 'reference' }));
    const panel = container.querySelector('.reference-panel');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain('Could not read clip.mp3.');
  });

  it('shows a rejected reference file in the reference panel', async () => {
    render(controller({ reference: referenceClip() }));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const refInput = inputs[inputs.length - 1];
    Object.defineProperty(refInput, 'files', { value: [new File(['x'], 'lyrics.txt', { type: 'text/plain' })], configurable: true });
    await act(async () => refInput.dispatchEvent(new Event('change', { bubbles: true })));
    const alert = container.querySelector('.reference-panel [role="alert"]');
    expect(alert?.textContent).toMatch(/does not look like an audio file/);
    expect(container.querySelector('.capture [role="alert"]')).toBeNull();
  });

  it('explains why a loaded reference clip cannot be used and does not offer it as a target', () => {
    const app = controller({
      reference: referenceClip({ usable: false, unusableReason: 'This clip sounds like a full song mix. Use an isolated vocal.' }),
    });
    render(app);
    const panel = container.querySelector('.reference-panel')!;
    expect(panel.textContent).toContain('Loaded: song-mix');
    expect(panel.textContent).toContain('can’t be used as a target');
    expect(panel.textContent).toContain('This clip sounds like a full song mix. Use an isolated vocal.');
    expect(Array.from(panel.querySelectorAll('button')).some((b) => /Use as target/.test(b.textContent ?? ''))).toBe(false);
    act(() => button(/Reference clip/).click());
    expect(app.selectProfile).not.toHaveBeenCalled();
    expect(button(/Reference clip/).textContent).toMatch(/can’t be used/);
  });

  it('lists a usable clip’s recording notes next to it', () => {
    render(controller({ reference: referenceClip({ analysis: { ...makeFakeAnalysis(), warnings: ['There is a lot of background noise.'] } }) }));
    expect(container.querySelector('.reference-panel')?.textContent).toContain('There is a lot of background noise.');
    expect(button(/Use as target/)).toBeTruthy();
  });

  it('writes voice types without nested parentheses and states the 5-minute clip limit', () => {
    render(controller({ reference: referenceClip() }));
    const text = container.textContent ?? '';
    expect(text).toContain('for a baritone), so there is mix');
    expect(text).not.toContain('))');
    expect(container.querySelector('#ref-voice option')?.textContent).toBe('Not sure (analyse as baritone, like my voice)');
    expect(text).toContain('up to 5 minutes');
    expect(text).not.toContain('6 minutes');
  });

  it('the reference card opens the reference-clip panel', () => {
    render(controller());
    expect(container.querySelector('#ref-heading')).toBeNull();
    act(() => button(/Reference clip/).click());
    expect(container.querySelector('#ref-heading')).not.toBeNull();
    expect(container.textContent).toMatch(/never leaves this device/);
  });

  it('links back to the last result', () => {
    const app = controller({
      analysis: makeFakeAnalysis(),
      take: { samples: new Float32Array(1), sampleRate: 22050, source: 'demo', name: 'Demo take', durationSec: 12 },
    });
    render(app);
    act(() => button(/View results/).click());
    expect(app.go).toHaveBeenCalledWith('results');
  });

  it('announces a drill picked on the Practice page and moves focus to the capture controls', async () => {
    render(controller({ drillExerciseId: 'straw' }));
    expect(container.textContent).toContain('Recording a drill: Straw phonation');
    expect(container.textContent).toContain('Record or upload it below');
    await nextFrame();
    // jsdom has no microphone, so the upload control gets focus instead of Record.
    expect(document.activeElement).toBe(container.querySelector('.capture input[type="file"]'));
  });

  it('moves focus to Stop when recording starts and back to Record after Discard, announcing each', async () => {
    vi.mocked(microphoneUnavailableReason).mockReturnValue(null);
    vi.mocked(createRecorder).mockReturnValueOnce({
      start: () => Promise.resolve(),
      stop: () => Promise.resolve({ samples: new Float32Array(0), sampleRate: 48000 }),
      cancel: () => undefined,
      analyser: null,
    });
    render(controller());
    const live = () => container.querySelector('.record-block [role="status"]')?.textContent;
    await act(async () => button(/^Record$/).click());
    expect(document.activeElement?.textContent).toMatch(/Stop and analyse/);
    expect(live()).toMatch(/Recording started/);
    expect(container.querySelector('[role="timer"]')).not.toBeNull();
    act(() => button(/Discard/).click());
    await nextFrame();
    expect(document.activeElement?.textContent).toBe('Record');
    expect(live()).toBe('Recording discarded.');
    vi.mocked(microphoneUnavailableReason).mockReset();
  });

  it('explains a refused microphone and points to upload instead of dead-ending', async () => {
    vi.mocked(microphoneUnavailableReason).mockReturnValueOnce(null);
    vi.mocked(createRecorder).mockReturnValueOnce({
      start: () => Promise.reject(new RecorderError('denied', 'Microphone access was blocked.')),
      stop: () => Promise.resolve({ samples: new Float32Array(0), sampleRate: 48000 }),
      cancel: () => undefined,
      analyser: null,
    });
    render(controller());
    const record = button(/^Record$/);
    expect(record.disabled).toBe(false);
    await act(async () => record.click());
    expect(container.textContent).toContain('The microphone did not start');
    expect(container.textContent).toContain('Microphone access was blocked.');
    expect(container.textContent).toMatch(/record a voice memo on your phone, then upload it/i);
    expect(button(/^Record$/).disabled).toBe(false);
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });
});
