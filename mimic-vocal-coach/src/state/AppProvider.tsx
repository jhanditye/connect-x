// Wires the reducer to the side effects: decoding, analysis in the worker, persistence, routing
// and theme. Everything a page can do goes through the AppController built here.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { analyzeInWorker } from '../analysis/client';
import { makeDemoTake } from '../analysis/demo';
import { decodeAudioFile } from '../audio/decode';
import { getExercise } from '../coach/exercises';
import { clearSessions, deleteSession, loadSessions, saveSession, sessionFromResults } from '../storage/history';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../storage/settings';
import type { AnalysisOptions, AppSettings, SessionRecord, VoiceAnalysis, VoiceType } from '../types';
import { AppContext, type AppController, type SamplesInput } from './context';
import {
  availableProfiles,
  activeProfile,
  createInitialState,
  createReducer,
  referenceOptions,
  sameOptions,
  takeOptions,
  type AppState,
  type JobKind,
  type ScoringDeps,
} from './reducer';
import { useHashRoute } from './routing';
import { scoringDeps } from './scoring';
import { applyTheme, loadTheme, saveTheme, type ThemePref } from './theme';

/** Longer inputs are trimmed: a take or reference clip beyond this is not one phrase, and analysis time grows linearly. */
const MAX_ANALYSIS_SEC = 360;
/** Below this there is not enough singing to measure anything. */
const MIN_TAKE_SEC = 1;

function trimForAnalysis(samples: Float32Array, sampleRate: number, name: string): { samples: Float32Array; notices: string[] } {
  const max = Math.round(MAX_ANALYSIS_SEC * sampleRate);
  if (samples.length <= max) return { samples, notices: [] };
  return {
    samples: samples.slice(0, max),
    notices: [`Only the first ${MAX_ANALYSIS_SEC / 60} minutes of ${name} were analysed. Trim long files to the part you want coached.`],
  };
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function AppProvider(props: { children: ReactNode; deps?: ScoringDeps }) {
  const deps = props.deps ?? scoringDeps;
  const reducer = useMemo(() => createReducer(deps), [deps]);
  const [state, dispatch] = useReducer(reducer, undefined, () => createInitialState(loadSettings(), loadSessions(), deps.builtins));
  const [route, go] = useHashRoute();
  const [theme, setThemeState] = useState<ThemePref>(loadTheme);

  // Async jobs read the latest state through a ref and drop results superseded by a newer job.
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  const runRef = useRef(0);
  const failedOptsRef = useRef<string | null>(null);

  useEffect(() => applyTheme(theme), [theme]);

  const runAnalysis = useCallback(
    async (job: JobKind, samples: Float32Array, sampleRate: number, opts: AnalysisOptions, label: string): Promise<VoiceAnalysis | null> => {
      const run = ++runRef.current;
      dispatch({ type: 'job/start', job, phase: 'analyzing', label });
      try {
        const analysis = await analyzeInWorker(samples, sampleRate, opts, (value: number) => {
          if (runRef.current === run) dispatch({ type: 'job/progress', value });
        });
        return runRef.current === run ? analysis : null;
      } catch (err) {
        if (runRef.current === run) dispatch({ type: 'job/fail', message: message(err, 'The analysis failed.') });
        return null;
      }
    },
    [],
  );

  const analyzeSamples = useCallback(
    async (input: SamplesInput): Promise<boolean> => {
      const durationSec = input.samples.length / input.sampleRate;
      if (!(durationSec >= MIN_TAKE_SEC)) {
        // job/fail (not error/set) so a decoded-but-too-short upload also leaves the 'decoding' state.
        dispatch({ type: 'job/fail', message: 'That take is too short to analyse. Sing at least one full phrase (15–60 s works best).' });
        return false;
      }
      const drillId = stateRef.current.drillExerciseId;
      const drill = drillId ? getExercise(drillId) : undefined;
      const name = drill && input.source === 'recording' ? `Drill: ${drill.name}` : input.name;
      const trimmed = trimForAnalysis(input.samples, input.sampleRate, name);
      const opts = takeOptions(stateRef.current.settings);
      const analysis = await runAnalysis('take', trimmed.samples, input.sampleRate, opts, `Analysing ${name}`);
      if (!analysis) return false;
      failedOptsRef.current = null;
      dispatch({
        type: 'take/analyzed',
        take: { samples: trimmed.samples, sampleRate: input.sampleRate, source: input.source, name, durationSec: trimmed.samples.length / input.sampleRate },
        analysis,
        opts,
        notices: trimmed.notices,
      });
      if (drill) dispatch({ type: 'drill/set', exerciseId: null });
      return true;
    },
    [runAnalysis],
  );

  const decode = useCallback(async (file: File, job: JobKind) => {
    const run = ++runRef.current;
    dispatch({ type: 'job/start', job, phase: 'decoding', label: `Reading ${file.name}` });
    try {
      const decoded = await decodeAudioFile(file);
      return runRef.current === run ? decoded : null;
    } catch (err) {
      if (runRef.current === run) dispatch({ type: 'job/fail', message: message(err, `Could not read ${file.name}.`) });
      return null;
    }
  }, []);

  const analyzeFile = useCallback(
    async (file: File): Promise<boolean> => {
      const decoded = await decode(file, 'take');
      if (!decoded) return false;
      return analyzeSamples({ samples: decoded.samples, sampleRate: decoded.sampleRate, source: 'upload', name: stripExtension(file.name) || 'Uploaded take' });
    },
    [decode, analyzeSamples],
  );

  const analyzeDemo = useCallback(async (): Promise<boolean> => {
    let demo: { samples: Float32Array; sampleRate: number };
    try {
      demo = makeDemoTake();
    } catch (err) {
      dispatch({ type: 'error/set', message: message(err, 'Could not build the demo take.') });
      return false;
    }
    return analyzeSamples({ ...demo, source: 'demo', name: 'Demo take' });
  }, [analyzeSamples]);

  const analyzeReference = useCallback(
    async (clip: { name: string; samples: Float32Array; sampleRate: number }, notices: string[]): Promise<boolean> => {
      const opts = referenceOptions(stateRef.current);
      const analysis = await runAnalysis('reference', clip.samples, clip.sampleRate, opts, `Analysing reference ${clip.name}`);
      if (!analysis) return false;
      failedOptsRef.current = null;
      dispatch({ type: 'reference/analyzed', clip, analysis, opts, notices });
      return true;
    },
    [runAnalysis],
  );

  const loadReferenceFile = useCallback(
    async (file: File): Promise<boolean> => {
      const decoded = await decode(file, 'reference');
      if (!decoded) return false;
      const name = stripExtension(file.name) || 'Reference clip';
      const trimmed = trimForAnalysis(decoded.samples, decoded.sampleRate, name);
      return analyzeReference({ name, samples: trimmed.samples, sampleRate: decoded.sampleRate }, trimmed.notices);
    },
    [decode, analyzeReference],
  );

  // Voice type and tuning feed the analysis itself (passaggio zone, tuning offset), so a change
  // re-analyses the stored take and reference. Debounced so typing in the A4 field does not start
  // a run per keystroke; a failed run is not retried until the options change again.
  useEffect(() => {
    if (state.status !== 'idle') return;
    const wantTake = takeOptions(state.settings);
    const wantRef = referenceOptions(state);
    const takeStale = !!state.take && !sameOptions(state.takeOpts, wantTake);
    const refStale = !!state.reference && !sameOptions(state.reference.opts, wantRef);
    if (!takeStale && !refStale) return;
    const key = JSON.stringify([takeStale && wantTake, refStale && wantRef]);
    if (failedOptsRef.current === key) return;
    const timer = setTimeout(() => {
      failedOptsRef.current = key;
      const s = stateRef.current;
      if (takeStale && s.take) {
        const take = s.take;
        void runAnalysis('take', take.samples, take.sampleRate, wantTake, `Re-analysing ${take.name}`).then((analysis) => {
          if (analysis) dispatch({ type: 'take/analyzed', take, analysis, opts: wantTake });
        });
      } else if (refStale && s.reference) {
        const { name, samples, sampleRate } = s.reference;
        void analyzeReference({ name, samples, sampleRate }, []);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [state, runAnalysis, analyzeReference]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = { ...stateRef.current.settings, ...patch };
    saveSettings(next);
    dispatch({ type: 'settings/set', settings: next });
  }, []);

  const refreshSessions = useCallback(() => dispatch({ type: 'sessions/set', sessions: loadSessions() }), []);

  const saveCurrent = useCallback(
    (label?: string): SessionRecord | null => {
      const s = stateRef.current;
      const profile = activeProfile(s, deps);
      if (!s.analysis || !s.comparison || !profile) return null;
      const rec = sessionFromResults(s.analysis, s.comparison, profile, label ?? s.take?.name);
      saveSession(rec);
      refreshSessions();
      return rec;
    },
    [deps, refreshSessions],
  );

  const setTheme = useCallback((t: ThemePref) => {
    saveTheme(t);
    setThemeState(t);
  }, []);

  const reference = state.reference;
  const profiles = useMemo(() => availableProfiles({ reference }, deps), [reference, deps]);

  const controller = useMemo<AppController>(
    () => ({
      state,
      dispatch,
      builtins: deps.builtins,
      profiles,
      profile: activeProfile(state, deps),
      route,
      go,
      analyzeSamples,
      analyzeFile,
      analyzeDemo,
      loadReferenceFile,
      setReferenceVoiceType: (v: VoiceType | null) => dispatch({ type: 'reference/voiceType', voiceType: v }),
      clearReference: () => dispatch({ type: 'reference/clear' }),
      selectProfile: (id: string) => dispatch({ type: 'profile/select', id }),
      updateSettings,
      saveSession: saveCurrent,
      deleteSession: (id: string) => {
        deleteSession(id);
        refreshSessions();
      },
      clearSessions: () => {
        clearSessions();
        refreshSessions();
      },
      clearAllData: () => {
        runRef.current++;
        clearSessions();
        saveSettings(DEFAULT_SETTINGS);
        setTheme('system');
        dispatch({ type: 'reset', settings: { ...DEFAULT_SETTINGS }, sessions: [] });
      },
      openPractice: (ids?: string[]) => {
        dispatch({ type: 'practice/focus', ids: ids && ids.length ? ids : null });
        go('practice');
      },
      recordDrill: (exerciseId: string) => {
        dispatch({ type: 'drill/set', exerciseId });
        go('studio');
      },
      theme,
      setTheme,
    }),
    [state, deps, profiles, route, go, analyzeSamples, analyzeFile, analyzeDemo, loadReferenceFile, updateSettings, saveCurrent, refreshSessions, theme, setTheme],
  );

  return <AppContext.Provider value={controller}>{props.children}</AppContext.Provider>;
}
