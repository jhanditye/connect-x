// App state: a pure reducer. Scoring functions come in through `ScoringDeps` so the reducer can be
// tested with fixtures and so switching singer only re-scores (compare + plan), never re-analyses.

import type {
  AnalysisOptions,
  AppSettings,
  CoachingPlan,
  Comparison,
  ReferenceComparison,
  SessionRecord,
  SingerProfile,
  VoiceAnalysis,
  VoiceType,
} from '../types';

/** Profile id used for the profile built from the user's reference clip (matches coach/reference.ts). */
export const REFERENCE_ID = 'reference';

export type TakeSource = 'recording' | 'upload' | 'demo';

export interface Take {
  samples: Float32Array;
  sampleRate: number;
  source: TakeSource;
  name: string;
  durationSec: number;
  /** Notes about how the file was read (trimmed, channels cancelling...); kept across re-analyses. */
  notices?: string[];
}

export interface ReferenceClip {
  name: string;
  samples: Float32Array;
  sampleRate: number;
  analysis: VoiceAnalysis;
  profile: SingerProfile;
  /** Builtin profile whose weights, songs and signature moves the reference profile inherited. */
  baseProfileId: string | null;
  /** Options the reference was analysed with. */
  opts: AnalysisOptions;
  /**
   * False when the clip cannot give targets (a full song mix, too little singing, speech). An
   * unusable clip stays loaded so the Studio can say why, but it is never offered as a target.
   */
  usable: boolean;
  /** Why the clip cannot be used, in plain English naming the fix; null when usable. */
  unusableReason: string | null;
  /** Notes about how the file was read (e.g. trimmed to the analysis limit). */
  notices: string[];
}

/** One message in the AI coach conversation. */
export interface AiTurn {
  role: 'user' | 'assistant';
  text: string;
}

export type JobKind = 'take' | 'reference';
export type Status = 'idle' | 'decoding' | 'analyzing';

export interface AppState {
  settings: AppSettings;
  /** A builtin singer id or REFERENCE_ID. */
  selectedProfileId: string;
  /** The last builtin singer the user picked (the base for a new reference profile). */
  builtinProfileId: string;
  reference: ReferenceClip | null;
  /** Voice type to analyse the reference with; null = the user's own voice type. */
  referenceVoiceType: VoiceType | null;
  take: Take | null;
  /** Options the current analysis was computed with (used to decide when to re-analyse). */
  takeOpts: AnalysisOptions | null;
  analysis: VoiceAnalysis | null;
  comparison: Comparison | null;
  plan: CoachingPlan | null;
  referenceComparison: ReferenceComparison | null;
  sessions: SessionRecord[];
  status: Status;
  job: JobKind | null;
  /** 0..1 while analysing. */
  progress: number;
  /** Short description of the running job, shown next to the progress bar. */
  progressLabel: string;
  error: string | null;
  /** The job the error came from, so the page can show it next to that control (null = no particular place). */
  errorJob: JobKind | null;
  /** Non-error notes about the last capture (e.g. a long file was trimmed). */
  notices: string[];
  /** Exercise ids the Practice page should show first; null = derive from the plan. */
  practiceFocus: string[] | null;
  /** Exercise the user chose to record from the Practice page. */
  drillExerciseId: string | null;
  /** Counts new takes (a re-analysis of the same take keeps it); part of the save key. */
  takeSerial: number;
  /** Counts new reference clips (a re-analysis keeps it). */
  referenceSerial: number;
  /** Results already saved to Progress, as saveKey() strings, so each is saved at most once. */
  savedKeys: string[];
  /** The AI coach conversation, kept here so it survives leaving Results; `key` says which result it is about. */
  aiThread: { key: string; turns: AiTurn[] } | null;
}

export interface ScoringDeps {
  builtins: SingerProfile[];
  compare(analysis: VoiceAnalysis, profile: SingerProfile): Comparison;
  plan(analysis: VoiceAnalysis, comparison: Comparison, profile: SingerProfile): CoachingPlan;
  profileFromReference(ref: VoiceAnalysis, name: string, base?: SingerProfile): SingerProfile;
  /** Whether a reference clip can serve as a target (coach/reference.ts referenceUsability). */
  referenceUsability(ref: VoiceAnalysis): { usable: boolean; reason: string | null };
  /** Used by the provider after an analysis lands (it is too slow to run inside the reducer). */
  compareToReference(user: VoiceAnalysis, ref: VoiceAnalysis): ReferenceComparison;
}

export type Action =
  | { type: 'settings/set'; settings: AppSettings }
  | { type: 'profile/select'; id: string }
  | { type: 'job/start'; job: JobKind; phase: Exclude<Status, 'idle'>; label: string }
  | { type: 'job/progress'; value: number }
  /** `job` says where the failure belongs when no job was running (e.g. a recording that was too short). */
  | { type: 'job/fail'; message: string; job?: JobKind }
  | { type: 'take/analyzed'; take: Take; analysis: VoiceAnalysis; opts: AnalysisOptions; notices?: string[] }
  | {
      type: 'reference/analyzed';
      clip: { name: string; samples: Float32Array; sampleRate: number; notices?: string[] };
      analysis: VoiceAnalysis;
      opts: AnalysisOptions;
      /** A re-analysis of the loaded clip after a settings change: keeps its base singer and the selection. */
      reanalysis?: boolean;
    }
  /** Result of compareToReference for this take/reference pair; dropped if either has changed since. */
  | { type: 'reference/compared'; user: VoiceAnalysis; ref: VoiceAnalysis; comparison: ReferenceComparison | null; error?: string }
  | { type: 'session/saved'; key: string }
  | { type: 'ai/thread'; key: string; turns: AiTurn[] }
  | { type: 'reference/voiceType'; voiceType: VoiceType | null }
  | { type: 'reference/clear' }
  | { type: 'take/clear' }
  | { type: 'sessions/set'; sessions: SessionRecord[] }
  | { type: 'error/set'; message: string }
  | { type: 'error/clear' }
  | { type: 'notices/clear' }
  | { type: 'practice/focus'; ids: string[] | null }
  | { type: 'drill/set'; exerciseId: string | null }
  | { type: 'reset'; settings: AppSettings; sessions: SessionRecord[] };

export function createInitialState(settings: AppSettings, sessions: SessionRecord[], builtins: SingerProfile[]): AppState {
  const first = builtins[0]?.id ?? '';
  return {
    settings,
    selectedProfileId: first,
    builtinProfileId: first,
    reference: null,
    referenceVoiceType: null,
    take: null,
    takeOpts: null,
    analysis: null,
    comparison: null,
    plan: null,
    referenceComparison: null,
    sessions,
    status: 'idle',
    job: null,
    progress: 0,
    progressLabel: '',
    error: null,
    errorJob: null,
    notices: [],
    practiceFocus: null,
    drillExerciseId: null,
    takeSerial: 0,
    referenceSerial: 0,
    savedKeys: [],
    aiThread: null,
  };
}

/** Builtin singers followed by the reference profile when a usable reference clip is loaded. */
export function availableProfiles(state: Pick<AppState, 'reference'>, deps: Pick<ScoringDeps, 'builtins'>): SingerProfile[] {
  return state.reference?.usable ? [...deps.builtins, state.reference.profile] : deps.builtins;
}

export function resolveProfile(state: AppState, deps: Pick<ScoringDeps, 'builtins'>, id = state.selectedProfileId): SingerProfile | null {
  if (id === REFERENCE_ID) {
    return state.reference?.usable ? state.reference.profile : resolveProfile(state, deps, state.builtinProfileId);
  }
  return deps.builtins.find((p) => p.id === id) ?? deps.builtins[0] ?? null;
}

/**
 * Identifies "this take scored against this target", so a result is saved to Progress at most once
 * however often the user leaves and returns to Results.
 */
export function saveKey(state: Pick<AppState, 'takeSerial' | 'referenceSerial'>, profile: Pick<SingerProfile, 'id' | 'source'>): string {
  const target = profile.source === 'reference' ? `${REFERENCE_ID}#${state.referenceSerial}` : profile.id;
  return `${state.takeSerial}|${target}`;
}

export function activeProfile(state: AppState, deps: Pick<ScoringDeps, 'builtins'>): SingerProfile | null {
  return resolveProfile(state, deps);
}

/** Options an analysis of the user's take should use under the current settings. */
export function takeOptions(settings: AppSettings): AnalysisOptions {
  return { voiceType: settings.voiceType, a4Hz: settings.a4Hz };
}

export function referenceOptions(state: Pick<AppState, 'settings' | 'referenceVoiceType'>): AnalysisOptions {
  return { voiceType: state.referenceVoiceType ?? state.settings.voiceType, a4Hz: state.settings.a4Hz };
}

export function sameOptions(a: AnalysisOptions | null | undefined, b: AnalysisOptions): boolean {
  return !!a && a.voiceType === b.voiceType && (a.a4Hz ?? 440) === (b.a4Hz ?? 440);
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Re-scores the current analysis against the selected profile. Never throws: failures land in `error`. */
function rescore(state: AppState, deps: ScoringDeps): AppState {
  const profile = resolveProfile(state, deps);
  if (!state.analysis || !profile) return { ...state, comparison: null, plan: null };
  try {
    const comparison = deps.compare(state.analysis, profile);
    const plan = deps.plan(state.analysis, comparison, profile);
    return { ...state, comparison, plan };
  } catch (err) {
    return { ...state, comparison: null, plan: null, error: errorText(err, 'Could not score this take.'), errorJob: null };
  }
}

const UNUSABLE_FALLBACK = "This clip can't be used as a target. Use an isolated vocal or an a cappella section.";

const IDLE = { status: 'idle' as const, job: null, progress: 0, progressLabel: '' };

export function createReducer(deps: ScoringDeps) {
  return function reducer(state: AppState, action: Action): AppState {
    switch (action.type) {
      case 'settings/set':
        return { ...state, settings: action.settings };

      case 'profile/select': {
        const isRef = action.id === REFERENCE_ID;
        if (isRef && !state.reference?.usable) return state;
        if (!isRef && !deps.builtins.some((p) => p.id === action.id)) return state;
        if (action.id === state.selectedProfileId) return state;
        const next: AppState = {
          ...state,
          selectedProfileId: action.id,
          builtinProfileId: isRef ? state.builtinProfileId : action.id,
          practiceFocus: null,
        };
        return rescore(next, deps);
      }

      case 'job/start':
        return {
          ...state,
          status: action.phase,
          job: action.job,
          progress: 0,
          progressLabel: action.label,
          error: null,
          errorJob: null,
          notices: [],
        };

      case 'job/progress':
        if (state.status === 'idle') return state;
        return { ...state, status: 'analyzing', progress: Math.max(0, Math.min(1, action.value)) };

      case 'job/fail':
        return { ...state, ...IDLE, error: action.message, errorJob: action.job ?? state.job };

      case 'take/analyzed': {
        // The same Take object means a re-analysis (new settings), not a new take.
        const newTake = action.take !== state.take;
        const next: AppState = {
          ...state,
          ...IDLE,
          take: action.take,
          takeOpts: action.opts,
          analysis: action.analysis,
          notices: action.notices ?? action.take.notices ?? [],
          practiceFocus: null,
          // Recomputed by the provider for the new analysis.
          referenceComparison: null,
          takeSerial: newTake ? state.takeSerial + 1 : state.takeSerial,
          savedKeys: newTake ? [] : state.savedKeys,
          aiThread: newTake ? null : state.aiThread,
        };
        return rescore(next, deps);
      }

      case 'reference/analyzed': {
        const reanalysis = !!action.reanalysis && !!state.reference;
        const refSelected = state.selectedProfileId === REFERENCE_ID;
        // A new clip borrows from the singer selected now; a re-analysis keeps the clip's original base.
        const baseId = reanalysis ? (state.reference?.baseProfileId ?? null) : refSelected ? state.builtinProfileId : state.selectedProfileId;
        const base = baseId ? deps.builtins.find((p) => p.id === baseId) : undefined;
        let profile: SingerProfile;
        try {
          profile = deps.profileFromReference(action.analysis, action.clip.name, base);
        } catch (err) {
          return { ...state, ...IDLE, error: errorText(err, 'Could not build a profile from the reference clip.'), errorJob: 'reference' };
        }
        const { usable, reason } = deps.referenceUsability(action.analysis);
        // A usable new clip becomes the target; an unusable one never does. A re-analysis only moves
        // the selection off the reference if the clip stopped being usable.
        const selectedProfileId = reanalysis
          ? refSelected && !usable
            ? state.builtinProfileId
            : state.selectedProfileId
          : usable
            ? REFERENCE_ID
            : refSelected
              ? state.builtinProfileId
              : state.selectedProfileId;
        const planChanged = selectedProfileId === REFERENCE_ID || selectedProfileId !== state.selectedProfileId;
        const next: AppState = {
          ...state,
          ...IDLE,
          reference: {
            name: action.clip.name,
            samples: action.clip.samples,
            sampleRate: action.clip.sampleRate,
            notices: action.clip.notices ?? (reanalysis ? (state.reference?.notices ?? []) : []),
            analysis: action.analysis,
            profile,
            baseProfileId: base?.id ?? null,
            opts: action.opts,
            usable,
            unusableReason: usable ? null : (reason ?? UNUSABLE_FALLBACK),
          },
          referenceSerial: reanalysis ? state.referenceSerial : state.referenceSerial + 1,
          selectedProfileId,
          builtinProfileId: reanalysis ? state.builtinProfileId : (base?.id ?? state.builtinProfileId),
          // Recomputed by the provider for the new clip.
          referenceComparison: null,
          practiceFocus: planChanged ? null : state.practiceFocus,
        };
        return planChanged ? rescore(next, deps) : next;
      }

      case 'reference/compared':
        if (state.analysis !== action.user || state.reference?.analysis !== action.ref) return state;
        return action.error
          ? { ...state, referenceComparison: null, error: action.error, errorJob: null }
          : { ...state, referenceComparison: action.comparison };

      case 'session/saved':
        return state.savedKeys.includes(action.key) ? state : { ...state, savedKeys: [...state.savedKeys, action.key] };

      case 'ai/thread':
        return { ...state, aiThread: { key: action.key, turns: action.turns } };

      case 'reference/voiceType':
        return { ...state, referenceVoiceType: action.voiceType };

      case 'reference/clear': {
        const next: AppState = {
          ...state,
          reference: null,
          referenceComparison: null,
          selectedProfileId: state.selectedProfileId === REFERENCE_ID ? state.builtinProfileId : state.selectedProfileId,
        };
        return state.selectedProfileId === REFERENCE_ID ? rescore(next, deps) : next;
      }

      case 'take/clear':
        return {
          ...state,
          take: null,
          takeOpts: null,
          analysis: null,
          comparison: null,
          plan: null,
          referenceComparison: null,
          practiceFocus: null,
          savedKeys: [],
          aiThread: null,
        };

      case 'sessions/set':
        return { ...state, sessions: action.sessions };

      case 'error/set':
        return { ...state, error: action.message, errorJob: null };

      case 'error/clear':
        return { ...state, error: null, errorJob: null };

      case 'notices/clear':
        return { ...state, notices: [] };

      case 'practice/focus':
        return { ...state, practiceFocus: action.ids };

      case 'drill/set':
        return { ...state, drillExerciseId: action.exerciseId };

      case 'reset':
        return { ...createInitialState(action.settings, action.sessions, deps.builtins) };
    }
  };
}

/** Exercise ids for the Practice page: an explicit focus, else every exercise the plan links to. */
export function practiceFocusIds(state: Pick<AppState, 'practiceFocus' | 'plan'>): string[] | undefined {
  if (state.practiceFocus && state.practiceFocus.length) return state.practiceFocus;
  if (!state.plan) return undefined;
  const ids: string[] = [];
  for (const item of [...state.plan.items].sort((a, b) => a.priority - b.priority)) {
    for (const id of item.exerciseIds) if (!ids.includes(id)) ids.push(id);
  }
  return ids.length ? ids : undefined;
}
