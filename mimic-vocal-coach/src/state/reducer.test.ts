import { describe, expect, it, vi } from 'vitest';
import {
  makeFakeAnalysis,
  makeFakeComparison,
  makeFakePlan,
  makeFakeProfile,
  makeFakeReferenceComparison,
  makeFakeSessions,
} from '../testing/fixtures';
import type { AppSettings, SingerProfile } from '../types';
import {
  activeProfile,
  availableProfiles,
  createInitialState,
  createReducer,
  practiceFocusIds,
  REFERENCE_ID,
  referenceOptions,
  sameOptions,
  saveKey,
  takeOptions,
  type AppState,
  type ScoringDeps,
  type Take,
} from './reducer';

const SETTINGS: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' };

function makeDeps(overrides: Partial<ScoringDeps> = {}): ScoringDeps {
  const shawn = makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes', color: '#b97a12' });
  const daniel = makeFakeProfile({ id: 'daniel-caesar', name: 'Daniel Caesar', color: '#3a7556' });
  const jalen = makeFakeProfile({ id: 'jalen-ngonda', name: 'Jalen Ngonda', color: '#b23c49' });
  return {
    builtins: [shawn, daniel, jalen],
    compare: vi.fn((_a, p: SingerProfile) => ({ ...makeFakeComparison(p.id), overall: p.id.length })),
    plan: vi.fn((_a, _c, p: SingerProfile) => makeFakePlan(p.id)),
    profileFromReference: vi.fn((_ref, name: string, base?: SingerProfile) =>
      makeFakeProfile({ id: 'reference', name, source: 'reference', color: base?.color ?? '#50606f', studySongs: base?.studySongs ?? [] }),
    ),
    referenceUsability: vi.fn(() => ({ usable: true, reason: null })),
    compareToReference: vi.fn(() => makeFakeReferenceComparison()),
    ...overrides,
  };
}

function take(): Take {
  return { samples: new Float32Array(22050), sampleRate: 22050, source: 'demo', name: 'Demo take', durationSec: 1 };
}

function setup(overrides: Partial<ScoringDeps> = {}) {
  const deps = makeDeps(overrides);
  const reduce = createReducer(deps);
  const state = createInitialState(SETTINGS, [], deps.builtins);
  return { deps, reduce, state };
}

function withTake(): { deps: ScoringDeps; reduce: ReturnType<typeof createReducer>; state: AppState } {
  const s = setup();
  const analysis = makeFakeAnalysis();
  const state = s.reduce(s.state, { type: 'take/analyzed', take: take(), analysis, opts: takeOptions(SETTINGS) });
  return { ...s, state };
}

describe('createInitialState', () => {
  it('selects the first builtin singer and starts idle with no take', () => {
    const { state, deps } = setup();
    expect(state.selectedProfileId).toBe('shawn-mendes');
    expect(state.builtinProfileId).toBe('shawn-mendes');
    expect(state.status).toBe('idle');
    expect(state.analysis).toBeNull();
    expect(activeProfile(state, deps)?.name).toBe('Shawn Mendes');
    expect(availableProfiles(state, deps)).toHaveLength(3);
  });

  it('keeps the loaded sessions', () => {
    const sessions = makeFakeSessions(3);
    const s = createInitialState(SETTINGS, sessions, makeDeps().builtins);
    expect(s.sessions).toBe(sessions);
  });
});

describe('analysis jobs', () => {
  it('tracks progress, clamped to 0..1, and clears errors and notices on start', () => {
    const { reduce, state } = setup();
    let s = reduce({ ...state, error: 'old', notices: ['old'] }, { type: 'job/start', job: 'take', phase: 'analyzing', label: 'Analysing' });
    expect(s).toMatchObject({ status: 'analyzing', job: 'take', progress: 0, progressLabel: 'Analysing', error: null, notices: [] });
    s = reduce(s, { type: 'job/progress', value: 0.4 });
    expect(s.progress).toBe(0.4);
    s = reduce(s, { type: 'job/progress', value: 7 });
    expect(s.progress).toBe(1);
  });

  it('moves from decoding to analyzing on the first progress report', () => {
    const { reduce, state } = setup();
    const s = reduce(reduce(state, { type: 'job/start', job: 'take', phase: 'decoding', label: 'Reading' }), { type: 'job/progress', value: 0.1 });
    expect(s.status).toBe('analyzing');
  });

  it('ignores progress when idle', () => {
    const { reduce, state } = setup();
    expect(reduce(state, { type: 'job/progress', value: 0.5 })).toBe(state);
  });

  it('job/fail goes idle and records the error with the job it came from', () => {
    const { reduce, state } = setup();
    const s = reduce(reduce(state, { type: 'job/start', job: 'reference', phase: 'analyzing', label: 'x' }), { type: 'job/fail', message: 'nope' });
    expect(s).toMatchObject({ status: 'idle', job: null, error: 'nope', errorJob: 'reference' });
    // With no job running (a recording that was too short) the action says where it belongs.
    expect(reduce(state, { type: 'job/fail', message: 'short', job: 'take' }).errorJob).toBe('take');
    expect(reduce(s, { type: 'error/clear' })).toMatchObject({ error: null, errorJob: null });
    expect(reduce(s, { type: 'job/start', job: 'take', phase: 'decoding', label: 'y' }).errorJob).toBeNull();
  });

  it('take/analyzed stores the take and scores it against the selected singer', () => {
    const { state, deps } = withTake();
    expect(state.status).toBe('idle');
    expect(state.take?.name).toBe('Demo take');
    expect(state.takeOpts).toEqual({ voiceType: 'baritone', a4Hz: 440 });
    expect(state.comparison?.profileId).toBe('shawn-mendes');
    expect(state.plan?.profileId).toBe('shawn-mendes');
    expect(state.referenceComparison).toBeNull();
    expect(deps.compare).toHaveBeenCalledTimes(1);
    expect(deps.compareToReference).not.toHaveBeenCalled();
  });

  it('a scoring failure lands in error instead of throwing', () => {
    const s = setup({
      compare: () => {
        throw new Error('bad profile');
      },
    });
    const next = s.reduce(s.state, { type: 'take/analyzed', take: take(), analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) });
    expect(next.analysis).not.toBeNull();
    expect(next.comparison).toBeNull();
    expect(next.plan).toBeNull();
    expect(next.error).toBe('bad profile');
  });
});

describe('profile/select', () => {
  it('re-scores the same analysis without re-analysing', () => {
    const { reduce, state, deps } = withTake();
    const analysis = state.analysis;
    const s = reduce(state, { type: 'profile/select', id: 'daniel-caesar' });
    expect(s.analysis).toBe(analysis);
    expect(s.selectedProfileId).toBe('daniel-caesar');
    expect(s.builtinProfileId).toBe('daniel-caesar');
    expect(s.comparison?.profileId).toBe('daniel-caesar');
    expect(s.plan?.profileId).toBe('daniel-caesar');
    expect(deps.compare).toHaveBeenLastCalledWith(analysis, expect.objectContaining({ id: 'daniel-caesar' }));
  });

  it('works before any take exists', () => {
    const { reduce, state } = setup();
    const s = reduce(state, { type: 'profile/select', id: 'jalen-ngonda' });
    expect(s.selectedProfileId).toBe('jalen-ngonda');
    expect(s.comparison).toBeNull();
  });

  it('ignores unknown ids, the current id, and the reference id when no reference is loaded', () => {
    const { reduce, state } = withTake();
    expect(reduce(state, { type: 'profile/select', id: 'nobody' })).toBe(state);
    expect(reduce(state, { type: 'profile/select', id: 'shawn-mendes' })).toBe(state);
    expect(reduce(state, { type: 'profile/select', id: REFERENCE_ID })).toBe(state);
  });

  it('clears an explicit practice focus, since it belonged to the previous plan', () => {
    const { reduce, state } = withTake();
    const focused = reduce(state, { type: 'practice/focus', ids: ['lip-trill-siren'] });
    expect(practiceFocusIds(focused)).toEqual(['lip-trill-siren']);
    expect(reduce(focused, { type: 'profile/select', id: 'daniel-caesar' }).practiceFocus).toBeNull();
  });
});

describe('reference clips', () => {
  const clip = { name: 'isolated-vocal', samples: new Float32Array(10), sampleRate: 22050 };

  it('builds a reference profile based on the selected builtin, selects it, and compares with the take', () => {
    const { reduce, deps } = withTake();
    let { state } = withTake();
    state = reduce(state, { type: 'profile/select', id: 'jalen-ngonda' });
    const refAnalysis = makeFakeAnalysis({ breathiness: 0.7 });
    const s = reduce(state, { type: 'reference/analyzed', clip, analysis: refAnalysis, opts: referenceOptions(state) });
    expect(deps.profileFromReference).toHaveBeenCalledWith(refAnalysis, 'isolated-vocal', expect.objectContaining({ id: 'jalen-ngonda' }), {
      artistVoiceType: null,
    });
    expect(s.selectedProfileId).toBe(REFERENCE_ID);
    expect(s.builtinProfileId).toBe('jalen-ngonda');
    expect(s.reference?.baseProfileId).toBe('jalen-ngonda');
    expect(s.reference?.profile.color).toBe('#b23c49');
    expect(activeProfile(s, deps)?.id).toBe(REFERENCE_ID);
    expect(availableProfiles(s, deps).map((p) => p.id)).toEqual(['shawn-mendes', 'daniel-caesar', 'jalen-ngonda', REFERENCE_ID]);
    expect(s.comparison?.profileId).toBe(REFERENCE_ID);
    // The phrase-by-phrase comparison is computed by the provider, outside the reducer.
    expect(s.referenceComparison).toBeNull();
    expect(deps.compareToReference).not.toHaveBeenCalled();
  });

  it('applies a reference comparison only to the take and clip it was computed for', () => {
    const { reduce, state } = setup();
    const withRef = reduce(state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(state) });
    const s = reduce(withRef, { type: 'take/analyzed', take: take(), analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) });
    expect(s.referenceComparison).toBeNull();
    const result = makeFakeReferenceComparison();
    const done = reduce(s, { type: 'reference/compared', user: s.analysis!, ref: s.reference!.analysis, comparison: result });
    expect(done.referenceComparison).toBe(result);
    // A result for an older take (or clip) arriving late is dropped.
    const newer = reduce(done, { type: 'take/analyzed', take: take(), analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) });
    expect(newer.referenceComparison).toBeNull();
    expect(reduce(newer, { type: 'reference/compared', user: s.analysis!, ref: s.reference!.analysis, comparison: result })).toBe(newer);
    // A failure lands in error.
    const failed = reduce(newer, { type: 'reference/compared', user: newer.analysis!, ref: newer.reference!.analysis, comparison: null, error: 'dtw' });
    expect(failed).toMatchObject({ referenceComparison: null, error: 'dtw' });
  });

  it('re-analysing the reference after a settings change keeps the selection and the original base singer', () => {
    const { reduce, deps } = setup();
    let s = createInitialState(SETTINGS, [], deps.builtins);
    // Reference loaded while Shawn is selected, then the user picks Daniel on Results.
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s) });
    s = reduce(s, { type: 'take/analyzed', take: take(), analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) });
    s = reduce(s, { type: 'profile/select', id: 'daniel-caesar' });
    const before = s.referenceSerial;
    s = reduce(s, { type: 'settings/set', settings: { ...SETTINGS, voiceType: 'tenor' } });
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s), reanalysis: true });
    expect(s.selectedProfileId).toBe('daniel-caesar');
    expect(s.builtinProfileId).toBe('daniel-caesar');
    expect(s.reference?.baseProfileId).toBe('shawn-mendes');
    expect(deps.profileFromReference).toHaveBeenLastCalledWith(expect.anything(), 'isolated-vocal', expect.objectContaining({ id: 'shawn-mendes' }), {
      artistVoiceType: null,
    });
    expect(s.comparison?.profileId).toBe('daniel-caesar');
    expect(s.referenceSerial).toBe(before);
  });

  it('a clip that cannot be used stays loaded with its reason but is never selected or offered', () => {
    const { reduce, state, deps } = setup({
      referenceUsability: vi.fn(() => ({ usable: false, reason: 'Sounds like a full mix. Use an isolated vocal.' })),
    });
    let s = reduce(state, { type: 'profile/select', id: 'jalen-ngonda' });
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s) });
    expect(s.reference).toMatchObject({ name: 'isolated-vocal', usable: false, unusableReason: 'Sounds like a full mix. Use an isolated vocal.' });
    expect(s.selectedProfileId).toBe('jalen-ngonda');
    expect(availableProfiles(s, deps).map((p) => p.id)).not.toContain(REFERENCE_ID);
    expect(reduce(s, { type: 'profile/select', id: REFERENCE_ID })).toBe(s);
    expect(activeProfile({ ...s, selectedProfileId: REFERENCE_ID }, deps)?.id).toBe('jalen-ngonda');
  });

  it('replacing the selected reference with an unusable clip falls back to the last builtin', () => {
    const usability = vi.fn(() => ({ usable: true, reason: null as string | null }));
    const { reduce, state } = setup({ referenceUsability: usability });
    let s = reduce(state, { type: 'profile/select', id: 'daniel-caesar' });
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s) });
    expect(s.selectedProfileId).toBe(REFERENCE_ID);
    usability.mockReturnValue({ usable: false, reason: 'Too little singing.' });
    s = reduce(s, { type: 'reference/analyzed', clip: { ...clip, name: 'mix' }, analysis: makeFakeAnalysis(), opts: referenceOptions(s) });
    expect(s.selectedProfileId).toBe('daniel-caesar');
    expect(s.reference?.usable).toBe(false);
  });

  it('a re-analysis that makes the selected clip unusable moves the selection back to the builtin', () => {
    const usability = vi.fn(() => ({ usable: true, reason: null as string | null }));
    const { reduce, state } = setup({ referenceUsability: usability });
    let s = reduce(state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(state) });
    expect(s.selectedProfileId).toBe(REFERENCE_ID);
    usability.mockReturnValue({ usable: false, reason: 'Too little singing.' });
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s), reanalysis: true });
    expect(s.selectedProfileId).toBe('shawn-mendes');
  });

  it('a new reference while the reference is selected keeps the last builtin as its base', () => {
    const { reduce, state, deps } = setup();
    let s = reduce(state, { type: 'profile/select', id: 'daniel-caesar' });
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s) });
    s = reduce(s, { type: 'reference/analyzed', clip: { ...clip, name: 'second' }, analysis: makeFakeAnalysis(), opts: referenceOptions(s) });
    expect(deps.profileFromReference).toHaveBeenLastCalledWith(expect.anything(), 'second', expect.objectContaining({ id: 'daniel-caesar' }), {
      artistVoiceType: null,
    });
    expect(s.reference?.name).toBe('second');
  });

  it('reference/clear falls back to the last builtin and re-scores', () => {
    const { reduce, state } = withTake();
    const withRef = reduce(state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(state) });
    const s = reduce(withRef, { type: 'reference/clear' });
    expect(s.reference).toBeNull();
    expect(s.referenceComparison).toBeNull();
    expect(s.selectedProfileId).toBe('shawn-mendes');
    expect(s.comparison?.profileId).toBe('shawn-mendes');
  });

  it('reference analysis options follow the user unless overridden', () => {
    const { reduce, state } = setup();
    expect(referenceOptions(state)).toEqual({ voiceType: 'baritone', a4Hz: 440 });
    const s = reduce(state, { type: 'reference/voiceType', voiceType: 'tenor' });
    expect(referenceOptions(s)).toEqual({ voiceType: 'tenor', a4Hz: 440 });
  });

  it('passes the artist voice type the user chose to the reference profile, so key advice can use the clip', () => {
    const { reduce, state, deps } = withTake();
    // Left at the user's own voice type: no artist voice type (key advice assumes the base singer).
    let s = reduce(state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(state) });
    expect(s.reference?.artistVoiceType).toBeNull();
    expect(deps.profileFromReference).toHaveBeenLastCalledWith(expect.anything(), 'isolated-vocal', expect.anything(), { artistVoiceType: null });
    // Chosen as mezzo: the provider re-analyses with the new options and the profile carries the choice.
    s = reduce(s, { type: 'reference/voiceType', voiceType: 'mezzo' });
    expect(s.reference?.artistVoiceType).toBeNull();
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s), reanalysis: true });
    expect(s.reference?.artistVoiceType).toBe('mezzo');
    expect(deps.profileFromReference).toHaveBeenLastCalledWith(expect.anything(), 'isolated-vocal', expect.anything(), { artistVoiceType: 'mezzo' });
    expect(s.comparison?.profileId).toBe(REFERENCE_ID);
  });

  it('naming the artist voice type as the user own rebuilds the profile without a re-analysis, and back', () => {
    const { reduce, state, deps } = withTake();
    let s = reduce(state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(state) });
    const analysis = s.reference!.analysis;
    const plans = vi.mocked(deps.plan).mock.calls.length;
    // Baritone is also the user's voice type, so the analysis options do not change.
    s = reduce(s, { type: 'reference/voiceType', voiceType: 'baritone' });
    expect(s.reference?.analysis).toBe(analysis);
    expect(s.reference?.artistVoiceType).toBe('baritone');
    expect(deps.profileFromReference).toHaveBeenLastCalledWith(analysis, 'isolated-vocal', expect.objectContaining({ id: 'shawn-mendes' }), {
      artistVoiceType: 'baritone',
    });
    // The reference is the target, so its key advice is re-scored.
    expect(vi.mocked(deps.plan).mock.calls.length).toBe(plans + 1);
    s = reduce(s, { type: 'reference/voiceType', voiceType: null });
    expect(s.reference?.artistVoiceType).toBeNull();
    expect(deps.profileFromReference).toHaveBeenLastCalledWith(analysis, 'isolated-vocal', expect.anything(), { artistVoiceType: null });
    // A choice that changes the options waits for the re-analysis.
    const calls = vi.mocked(deps.profileFromReference).mock.calls.length;
    s = reduce(s, { type: 'reference/voiceType', voiceType: 'tenor' });
    expect(vi.mocked(deps.profileFromReference).mock.calls.length).toBe(calls);
    expect(s.reference?.artistVoiceType).toBeNull();
  });

  it('a failing profile build reports an error and keeps the previous state', () => {
    const s = setup({
      profileFromReference: () => {
        throw new Error('no voiced frames');
      },
    });
    const next = s.reduce(s.state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s.state) });
    expect(next.reference).toBeNull();
    expect(next.error).toBe('no voiced frames');
    expect(next.errorJob).toBe('reference');
    expect(next.status).toBe('idle');
  });
});

describe('saving and the AI conversation', () => {
  const clip = { name: 'isolated-vocal', samples: new Float32Array(10), sampleRate: 22050 };

  it('a result is saved once per take, analysis options and target', () => {
    const { reduce, state, deps } = withTake();
    const shawn = deps.builtins[0];
    const key = saveKey(state, shawn);
    let s = reduce(state, { type: 'session/saved', key });
    expect(s.savedKeys).toEqual([key]);
    expect(reduce(s, { type: 'session/saved', key })).toBe(s);
    // A different singer has its own key.
    expect(saveKey(s, deps.builtins[1])).not.toBe(key);
    // A re-analysis with the same options (same Take object) is the same result: still saved.
    s = reduce(s, { type: 'take/analyzed', take: s.take!, analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) });
    expect(s.savedKeys).toContain(saveKey(s, shawn));
    // A settings change re-analyses to different numbers, which have not been saved...
    s = reduce(s, { type: 'take/analyzed', take: s.take!, analysis: makeFakeAnalysis(), opts: { voiceType: 'tenor', a4Hz: 440 } });
    expect(s.savedKeys).not.toContain(saveKey(s, shawn));
    const tuned = reduce(s, { type: 'take/analyzed', take: s.take!, analysis: makeFakeAnalysis(), opts: { voiceType: 'tenor', a4Hz: 442 } });
    expect(saveKey(tuned, shawn)).not.toBe(saveKey(s, shawn));
    // ...and switching back to the saved settings gives the saved result again.
    s = reduce(s, { type: 'take/analyzed', take: s.take!, analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) });
    expect(s.savedKeys).toContain(saveKey(s, shawn));
    // A new take starts fresh.
    const next = reduce(s, { type: 'take/analyzed', take: take(), analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) });
    expect(next.takeSerial).toBe(s.takeSerial + 1);
    expect(next.savedKeys).toEqual([]);
    expect(next.savedKeys).not.toContain(saveKey(next, shawn));
  });

  it('different reference clips get different save keys', () => {
    const { reduce, state } = withTake();
    const a = reduce(state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(state) });
    const b = reduce(a, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(a) });
    expect(saveKey(a, a.reference!.profile)).not.toBe(saveKey(b, b.reference!.profile));
  });

  it('re-analysing the reference with another voice type changes the save key for the reference target', () => {
    const { reduce, state, deps } = withTake();
    let s = reduce(state, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(state) });
    const key = saveKey(s, s.reference!.profile);
    const shawnKey = saveKey(s, deps.builtins[0]);
    s = reduce(s, { type: 'session/saved', key });
    s = reduce(s, { type: 'reference/voiceType', voiceType: 'mezzo' });
    s = reduce(s, { type: 'reference/analyzed', clip, analysis: makeFakeAnalysis(), opts: referenceOptions(s), reanalysis: true });
    expect(s.savedKeys).not.toContain(saveKey(s, s.reference!.profile));
    // Builtin targets do not depend on the reference.
    expect(saveKey(s, deps.builtins[0])).toBe(shawnKey);
  });

  it('a settings re-analysis whose score differs is not shown as already saved (review repro)', () => {
    const { deps, reduce, state } = setup({
      compare: vi.fn((a, p: SingerProfile) => ({ ...makeFakeComparison(p.id), overall: a.passaggio.lowMidi })),
    });
    const t = take();
    let s = reduce(state, { type: 'take/analyzed', take: t, analysis: { ...makeFakeAnalysis(), passaggio: { lowMidi: 62, highMidi: 67 } }, opts: takeOptions(SETTINGS) });
    const savedOverall = s.comparison!.overall;
    s = reduce(s, { type: 'session/saved', key: saveKey(s, activeProfile(s, deps)!) });
    const tenor = { ...SETTINGS, voiceType: 'tenor' as const };
    s = reduce(s, { type: 'settings/set', settings: tenor });
    s = reduce(s, { type: 'take/analyzed', take: t, analysis: { ...makeFakeAnalysis(), passaggio: { lowMidi: 64, highMidi: 69 } }, opts: takeOptions(tenor) });
    expect(s.comparison!.overall).not.toBe(savedOverall);
    expect(s.savedKeys.includes(saveKey(s, activeProfile(s, deps)!))).toBe(false);
  });

  it('keeps the AI conversation until a new take arrives or everything is cleared', () => {
    const { reduce, state } = withTake();
    const turns = [
      { role: 'user' as const, text: 'Q' },
      { role: 'assistant' as const, text: 'A' },
    ];
    let s = reduce(state, { type: 'ai/thread', key: 'k1', turns });
    expect(s.aiThread).toEqual({ key: 'k1', turns });
    s = reduce(s, { type: 'profile/select', id: 'daniel-caesar' });
    expect(s.aiThread?.turns).toBe(turns);
    expect(reduce(s, { type: 'take/analyzed', take: take(), analysis: makeFakeAnalysis(), opts: takeOptions(SETTINGS) }).aiThread).toBeNull();
    expect(reduce(s, { type: 'take/clear' }).aiThread).toBeNull();
    expect(reduce(s, { type: 'reset', settings: SETTINGS, sessions: [] }).aiThread).toBeNull();
  });
});

describe('other actions', () => {
  it('take/clear drops the take and all derived results', () => {
    const { reduce, state } = withTake();
    const s = reduce(state, { type: 'take/clear' });
    expect(s).toMatchObject({ take: null, analysis: null, comparison: null, plan: null, referenceComparison: null, takeOpts: null });
  });

  it('settings/set replaces settings; the analysis options helpers compare them', () => {
    const { reduce, state } = withTake();
    const s = reduce(state, { type: 'settings/set', settings: { ...SETTINGS, voiceType: 'tenor' } });
    expect(s.settings.voiceType).toBe('tenor');
    expect(sameOptions(s.takeOpts, takeOptions(s.settings))).toBe(false);
    expect(sameOptions(state.takeOpts, takeOptions(state.settings))).toBe(true);
    expect(sameOptions(null, takeOptions(s.settings))).toBe(false);
    expect(sameOptions({ voiceType: 'tenor' }, { voiceType: 'tenor', a4Hz: 440 })).toBe(true);
  });

  it('reset returns to a fresh state with the given settings', () => {
    const { reduce, state } = withTake();
    const s = reduce(state, { type: 'reset', settings: SETTINGS, sessions: [] });
    expect(s.analysis).toBeNull();
    expect(s.sessions).toEqual([]);
    expect(s.selectedProfileId).toBe('shawn-mendes');
  });

  it('errors, notices, sessions and drills are simple setters', () => {
    const { reduce, state } = setup();
    expect(reduce(state, { type: 'error/set', message: 'x' }).error).toBe('x');
    expect(reduce({ ...state, error: 'x' }, { type: 'error/clear' }).error).toBeNull();
    expect(reduce({ ...state, notices: ['n'] }, { type: 'notices/clear' }).notices).toEqual([]);
    expect(reduce(state, { type: 'sessions/set', sessions: makeFakeSessions(2) }).sessions).toHaveLength(2);
    expect(reduce(state, { type: 'drill/set', exerciseId: 'straw' }).drillExerciseId).toBe('straw');
  });
});

describe('practiceFocusIds', () => {
  it('uses the plan exercises in priority order, de-duplicated, when no focus is set', () => {
    const plan = makeFakePlan();
    plan.items = [
      { ...plan.items[0], id: 'b', priority: 2, exerciseIds: ['c', 'a'] },
      { ...plan.items[0], id: 'a', priority: 1, exerciseIds: ['a', 'b'] },
    ];
    expect(practiceFocusIds({ practiceFocus: null, plan })).toEqual(['a', 'b', 'c']);
  });

  it('is undefined without a plan or with a plan that links no exercises', () => {
    expect(practiceFocusIds({ practiceFocus: null, plan: null })).toBeUndefined();
    const plan = makeFakePlan();
    plan.items = [];
    expect(practiceFocusIds({ practiceFocus: [], plan })).toBeUndefined();
  });
});
