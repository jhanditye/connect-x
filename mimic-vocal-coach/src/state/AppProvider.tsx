// Wires the reducer to the side effects: decoding, analysis in the worker, persistence, routing
// and theme. Everything a page can do goes through the AppController built here.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { MAX_ANALYSIS_SEC } from '../analysis/analyze';
import { analyzeInWorker } from '../analysis/client';
import { makeDemoTake } from '../analysis/demo';
import { decodeAudioFile } from '../audio/decode';
import { keepScreenAwake } from '../audio/wakeLock';
import { isScoreable } from '../coach/compare';
import { getExercise } from '../coach/exercises';
import { ARTIST_VOICE_TYPE, clipFromAnalysis, MAX_CLIPS_PER_SINGER } from '../coach/measured';
import { clearSessions, deleteSession, loadSessions, saveSession, sessionFromResults } from '../storage/history';
import { clearMeasurements, loadMeasurements, saveMeasurements } from '../storage/measurements';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../storage/settings';
import type { AnalysisOptions, AppSettings, MeasuredClip, ReferenceComparison, SessionRecord, VoiceAnalysis, VoiceType } from '../types';
import { AppContext, type AppController, type MeasureProgress, type MeasureResult, type SamplesInput } from './context';
import {
  availableProfiles,
  activeProfile,
  createInitialState,
  createReducer,
  effectiveBuiltins,
  referenceOptions,
  sameOptions,
  saveKey,
  takeOptions,
  type AppState,
  type JobKind,
  type ScoringDeps,
} from './reducer';
import { useHashRoute } from './routing';
import { scoringDeps } from './scoring';
import { applyTheme, loadTheme, saveTheme, type ThemePref } from './theme';

/** Below this there is not enough singing to measure anything. */
const MIN_TAKE_SEC = 1;
/** A take this little over the limit (a recording stopped a moment late) is trimmed without a notice. */
const TRIM_NOTICE_SLACK_SEC = 1;

/**
 * Takes and reference clips are cut to the analysis limit (the same one analyzeTake uses) before
 * analysis, so the analysis never trims again and only one notice, with the real file length, is shown.
 */
function trimForAnalysis(
  samples: Float32Array,
  sampleRate: number,
  name: string,
  sourceDurationSec = samples.length / sampleRate,
): { samples: Float32Array; notices: string[] } {
  const max = Math.floor(MAX_ANALYSIS_SEC * sampleRate);
  const kept = samples.length > max ? samples.slice(0, max) : samples;
  const notices =
    sourceDurationSec > MAX_ANALYSIS_SEC + TRIM_NOTICE_SLACK_SEC
      ? [
          `Only the first ${MAX_ANALYSIS_SEC / 60} minutes of ${name} (${(sourceDurationSec / 60).toFixed(1)} minutes long) were analysed. ` +
            'Trim long files to the part you want coached.',
        ]
      : [];
  return { samples: kept, notices };
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, '');
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function newClipId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function AppProvider(props: { children: ReactNode; deps?: ScoringDeps }) {
  const deps = props.deps ?? scoringDeps;
  const reducer = useMemo(() => createReducer(deps), [deps]);
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    createInitialState(loadSettings(), loadSessions(), deps.builtins, loadMeasurements()),
  );
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
      // A 5-minute take takes ~10-20 s to analyse. iOS freezes a page ~20 s after the screen locks or the app
      // is left, so keep the screen awake while the worker runs (no-op where Wake Lock is unavailable).
      const awake = keepScreenAwake();
      try {
        const analysis = await analyzeInWorker(samples, sampleRate, opts, (value: number) => {
          if (runRef.current === run) dispatch({ type: 'job/progress', value });
        });
        return runRef.current === run ? analysis : null;
      } catch (err) {
        if (runRef.current === run) dispatch({ type: 'job/fail', message: message(err, 'The analysis failed.') });
        return null;
      } finally {
        awake.release();
      }
    },
    [],
  );

  const analyzeSamples = useCallback(
    async (input: SamplesInput): Promise<boolean> => {
      const durationSec = input.samples.length / input.sampleRate;
      if (!(durationSec >= MIN_TAKE_SEC)) {
        // job/fail (not error/set) so a decoded-but-too-short upload also leaves the 'decoding' state.
        dispatch({ type: 'job/fail', job: 'take', message: 'That take is too short to analyse. Sing at least one full phrase (15–60 s works best).' });
        return false;
      }
      // A drill picked on the Practice page labels the next recorded or uploaded take; a demo take is
      // synthesised, so it never counts as the drill and the drill stays pending.
      const drillId = stateRef.current.drillExerciseId;
      const drill = drillId && input.source !== 'demo' ? getExercise(drillId) : undefined;
      const name = drill ? `Drill: ${drill.name}` : input.name;
      const trimmed = trimForAnalysis(input.samples, input.sampleRate, name, input.sourceDurationSec);
      const notices = [...(input.notices ?? []), ...trimmed.notices];
      const opts = takeOptions(stateRef.current.settings);
      const analysis = await runAnalysis('take', trimmed.samples, input.sampleRate, opts, `Analysing ${name}`);
      if (!analysis) return false;
      failedOptsRef.current = null;
      dispatch({
        type: 'take/analyzed',
        take: {
          samples: trimmed.samples,
          sampleRate: input.sampleRate,
          source: input.source,
          name,
          durationSec: trimmed.samples.length / input.sampleRate,
          notices,
        },
        analysis,
        opts,
        notices,
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
      // Only the part that will be analysed is decoded (long WAV files are never read in full).
      const decoded = await decodeAudioFile(file, { maxSeconds: MAX_ANALYSIS_SEC });
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
      return analyzeSamples({
        samples: decoded.samples,
        sampleRate: decoded.sampleRate,
        source: 'upload',
        name: stripExtension(file.name) || 'Uploaded take',
        sourceDurationSec: decoded.sourceDurationSec,
        notices: decoded.notices,
      });
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
    async (clip: { name: string; samples: Float32Array; sampleRate: number; notices: string[] }, reanalysis: boolean): Promise<boolean> => {
      const opts = referenceOptions(stateRef.current);
      const label = `${reanalysis ? 'Re-analysing' : 'Analysing'} reference ${clip.name}`;
      const analysis = await runAnalysis('reference', clip.samples, clip.sampleRate, opts, label);
      if (!analysis) return false;
      failedOptsRef.current = null;
      dispatch({ type: 'reference/analyzed', clip, analysis, opts, reanalysis });
      return true;
    },
    [runAnalysis],
  );

  const loadReferenceFile = useCallback(
    async (file: File): Promise<boolean> => {
      const decoded = await decode(file, 'reference');
      if (!decoded) return false;
      const name = stripExtension(file.name) || 'Reference clip';
      const trimmed = trimForAnalysis(decoded.samples, decoded.sampleRate, name, decoded.sourceDurationSec);
      const notices = [...decoded.notices, ...trimmed.notices];
      return analyzeReference({ name, samples: trimmed.samples, sampleRate: decoded.sampleRate, notices }, false);
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
        // A re-analysis keeps the clip's base singer and the current selection.
        const { name, samples, sampleRate, notices } = s.reference;
        void analyzeReference({ name, samples, sampleRate, notices }, true);
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

  // The phrase-by-phrase reference comparison (a DTW over both pitch tracks) is too slow for the
  // reducer, so it runs here once the new result has painted. The reducer drops a result whose take or
  // reference has changed in the meantime.
  const compareUser = state.analysis;
  const compareRef = state.reference?.usable ? state.reference.analysis : null;
  useEffect(() => {
    if (!compareUser || !compareRef) return;
    const timer = setTimeout(() => {
      let comparison: ReferenceComparison | null = null;
      let error: string | undefined;
      try {
        comparison = deps.compareToReference(compareUser, compareRef);
      } catch (err) {
        error = message(err, 'Could not compare with the reference clip.');
      }
      dispatch({ type: 'reference/compared', user: compareUser, ref: compareRef, comparison, error });
    }, 0);
    return () => clearTimeout(timer);
  }, [compareUser, compareRef, deps]);

  const saveCurrent = useCallback(
    (label?: string): SessionRecord | null => {
      const s = stateRef.current;
      const profile = activeProfile(s, deps);
      if (!s.analysis || !s.comparison || !profile) return null;
      // A take that can't be scored would put a meaningless number into the trend.
      if (!isScoreable(s.analysis, s.comparison)) return null;
      const key = saveKey(s, profile);
      if (s.savedKeys.includes(key)) return null;
      const rec = sessionFromResults(s.analysis, s.comparison, profile, label ?? s.take?.name);
      saveSession(rec);
      dispatch({ type: 'session/saved', key });
      refreshSessions();
      return rec;
    },
    [deps, refreshSessions],
  );

  // Clips of a builtin singer from the user's own music: each file is decoded and analysed as the
  // artist's voice (not the user's), checked like a reference clip (song mixes, speech and too little
  // singing are refused with the reason), and only the measurements are kept.
  const setMeasuredClips = useCallback((singerId: string, clips: MeasuredClip[]) => {
    const all = { ...stateRef.current.measurements };
    if (clips.length) all[singerId] = clips;
    else delete all[singerId];
    saveMeasurements(all);
    dispatch({ type: 'measurements/set', singerId, clips });
  }, []);

  const measureClips = useCallback(
    async (singerId: string, files: File[], onProgress?: (p: MeasureProgress) => void): Promise<MeasureResult> => {
      const added: MeasuredClip[] = [];
      const rejected: MeasureResult['rejected'] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = stripExtension(file.name) || `Clip ${i + 1}`;
        const report = (phase: MeasureProgress['phase'], fraction: number) => onProgress?.({ index: i, count: files.length, name, phase, fraction });
        report('decoding', 0);
        let decoded: Awaited<ReturnType<typeof decodeAudioFile>>;
        try {
          decoded = await decodeAudioFile(file, { maxSeconds: MAX_ANALYSIS_SEC });
        } catch (err) {
          rejected.push({ name, reason: message(err, `Could not read ${file.name}.`) });
          continue;
        }
        const { samples } = trimForAnalysis(decoded.samples, decoded.sampleRate, name, decoded.sourceDurationSec);
        let analysis: VoiceAnalysis;
        try {
          const opts = { voiceType: ARTIST_VOICE_TYPE, a4Hz: stateRef.current.settings.a4Hz };
          analysis = await analyzeInWorker(samples, decoded.sampleRate, opts, (f: number) => report('analyzing', f));
        } catch (err) {
          rejected.push({ name, reason: message(err, 'The analysis failed.') });
          continue;
        }
        const { usable, reason } = deps.referenceUsability(analysis);
        if (!usable) {
          rejected.push({ name, reason: reason ?? 'This clip has too little clear singing to measure.' });
          continue;
        }
        added.push(clipFromAnalysis(analysis, name, newClipId(), new Date().toISOString()));
      }
      if (added.length) {
        const current = stateRef.current.measurements[singerId] ?? [];
        setMeasuredClips(singerId, [...current, ...added].slice(-MAX_CLIPS_PER_SINGER));
      }
      return { added: added.length, rejected };
    },
    [deps, setMeasuredClips],
  );

  const setTheme = useCallback((t: ThemePref) => {
    saveTheme(t);
    setThemeState(t);
  }, []);

  const reference = state.reference;
  const measurements = state.measurements;
  const profiles = useMemo(() => availableProfiles({ reference, measurements }, deps), [reference, measurements, deps]);
  const builtins = useMemo(() => effectiveBuiltins({ measurements }, deps), [measurements, deps]);

  const controller = useMemo<AppController>(
    () => ({
      state,
      dispatch,
      builtins,
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
      measureClips,
      addMeasuredClip: (singerId: string, clip: MeasuredClip) =>
        setMeasuredClips(singerId, [...(stateRef.current.measurements[singerId] ?? []).filter((c) => c.id !== clip.id), clip].slice(-MAX_CLIPS_PER_SINGER)),
      removeMeasuredClip: (singerId: string, clipId: string) =>
        setMeasuredClips(
          singerId,
          (stateRef.current.measurements[singerId] ?? []).filter((c) => c.id !== clipId),
        ),
      clearMeasuredClips: (singerId: string) => setMeasuredClips(singerId, []),
      clearAllData: () => {
        runRef.current++;
        clearSessions();
        clearMeasurements();
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
    [
      state,
      deps,
      builtins,
      profiles,
      route,
      go,
      analyzeSamples,
      analyzeFile,
      analyzeDemo,
      loadReferenceFile,
      updateSettings,
      saveCurrent,
      refreshSessions,
      measureClips,
      setMeasuredClips,
      theme,
      setTheme,
    ],
  );

  return <AppContext.Provider value={controller}>{props.children}</AppContext.Provider>;
}
