# Clip Trainer: contracts and module map

Phrase-by-phrase mimicry of clips the user imports from music they own. Everything stays on the device. Plan:
`PLAN.md` (workstreams W0 to W8). This file records the W0 decisions; the public types are in `src/types.ts`.

## Decision: one score authority

There are two comparison efforts and exactly one score per attempt.

| Question | Answer |
|---|---|
| Who produces the overall number and the pitch / timing / tone / expression sub-scores? | `trainer/score/score.ts` `scoreAttempt` (the contour-first scorer). Weights 40 / 25 / 20 / 15, gates (`status`: ok / low-evidence / no-match), `trust` (ok / caution / invalid, including the "too perfect" speaker-bleed check) and the ranked `fixes`. |
| What does `trainer/compare.ts` add? | The per-note table (`NoteCompare`: pitch read inside the time model's window, onset, length, level, vibrato per reference note), the sync model (sync offset, drift, tempo ratio), the tone findings in plain words (`ToneFinding`) and the `PhraseComparison` shape. It never computes a second overall. |
| How do they connect? | `comparePhrase` runs `compareToReference` once (optionally narrowed by `transposeHint`) and hands that result to `scoreAttempt` through its `compare` option, so the DTW is not computed twice. |
| What does the UI show? | `PhraseComparison.score.overall` with `scoreBand`, the sub-scores in `PhraseComparison.scores` (a flat copy of the same numbers, `scoresOf(score)`), `score.trust` beside the number when it is not `ok`, the note table from `notes`, tone words from `tone`, at most three fixes from `feedback.ts`. |
| `AttemptRecord.scores` | `{ overall, pitch, timing, tone, expression }` copied from the authority; `trust` stored beside it. Mastery (`srs.ts`) reads these. |

Honest limits carried over from the design notes: calibrated on synthetic voices and four short real clips, no human ratings;
tone is the weakest skill; the 65 Hz tracker floor makes some key shifts unscoreable; short phrases (under 5 notes or 4 s) are
about twice as noisy (show those rounded to 5).

### Known reconciliation work (first job of the compare owner, W4)

- `feedback.ts` `buildFixes` still ranks by its own `loss` estimates (legacy cents ramp, 3 points per late note ...). The
  authority's `score.fixes` (ranked by `gainPoints`) and `perNote.pitchScore` should replace those estimates so the order of the
  fixes agrees with the score. Keep `TrainerFix` (evidence, cue, drill, loop) as the UI shape.
- `NoteCompare.cents` (model-window reading) and `NoteScore.cents` (aligner) can differ by a few cents; the table shows
  `NoteCompare`, the score uses `NoteScore`. Decide whether to show `NoteScore` flags (superset: octave-displaced, ornament, split).
- `PITCH_FULL_CENTS` / `PITCH_ZERO_CENTS` in `compare.ts` are legacy and only used by `feedback.ts`.
- The prototype `feedback.ts` had an inverted pitch loss (`1 - centsScoreLoss`); fixed here, covered by `feedback.test.ts`.

## Types (all in `src/types.ts`, additive)

- `VoiceAnalysis.mode?` and `AnalysisOptions.mode?`: `'solo' | 'mix'`, absent = solo. `'mix'` analyses are made by
  `analysis/mixMode.ts` (`analyzeMix`); their tone fields are empty and must not be shown or scored.
- `PlayMode`, `KeyMode`: defined once there. `trainer/score/types.ts` and `audio/duplex.ts` import them.
- Stored data: `ClipRecord`, `PhraseRecord`, `AttemptRecord`, `LibraryExport` (+ `ClipAudioInfo`, `ClipAnalysisSummary`,
  `PhraseSummary`, `PhraseSrsState`, `PhraseStats`, `AttemptNoteSummary`, `ClipKind`, `ClipAnalysisKind`).
- Scoring: `ScoreOptions`, `AttemptScore`, `NoteScore`, `NoteFlag`, `Fix`, `ScoreComponent`, `SkillKey`.
- Comparison: `PlayTiming`, `NoteCompare`, `ToneFinding`, `PhraseComparison`.
- Not in `types.ts` (module-local): `ClipStore` (`storage/clips.ts`), `StorageStatus` (`storage/quota.ts`), `PreparedClip`,
  `CommitEdits`, `ImportProgress` (`trainer/import.ts`), `RouteInfo`, `TakeResult`, `DuplexSession` (`audio/duplex.ts`),
  `PhrasePlayer` (`audio/player.ts`), `PhraseAudio` (`trainer/phraseAnalysis.ts`), `TrainerFix` (`trainer/feedback.ts`),
  `TrainerController` (`state/trainerContext.ts`), `PracticeEngine` + `PracticeSnapshot` (`trainer/engine.ts`).

## The two seams screens code against

- `TrainerController` (`useTrainer()`): library state and actions (clips, queue, storage, import `prepareClip` / `commitClip`,
  attempts, export / import, `openPractice`). Provider: `state/TrainerProvider.tsx` (stub now). Tests wrap screens in
  `<TrainerContext.Provider value={makeFakeTrainerController()}>`.
- `PracticeEngine` (`trainer/engine.ts`): one per open phrase; `getSnapshot` / `subscribe` (works with `useSyncExternalStore`),
  `listen`, `sing`, `stop`, `playAttempt`, `setOptions`, `position()` for the rAF playhead, `dispose`.
  `FakeTrainerEngine` (`testing/trainerFixtures.ts`) scripts takes from the canned scenarios.

## Routes

`ROUTES`: trainer, studio, results, practice, progress, guide, settings, more. `DEFAULT_ROUTE` = trainer.
`TAB_ROUTES` (five phone tabs: trainer, studio, results, progress, more), `TOP_ROUTES` (desktop), `MORE_ROUTES` (practice, guide,
settings). Deep links: `#trainer`, `#trainer/add`, `#trainer/c/<clipId>`, `#trainer/c/<clipId>/p/<n>` (n is the 1-based phrase number
shown on screen); `parseTrainerPath` / `trainerHash` / `useTrainerPath`. `parseRoute` already reads the first token.

## Module map

Status: lifted = prototype moved into `src` with imports rewritten and compiled under the strict flags (tests for the module to be
ported by its owner); stub = final exported signatures, bodies throw `Error('not implemented')` or return a safe default.

| Path | Status | Owner |
|---|---|---|
| `storage/clips.ts` (ClipStore, IndexedDB + memory, `StoreUnavailableError`, `QuotaError`) | lifted | W1 |
| `audio/pcm.ts` | lifted | W1 |
| `storage/library.ts` | stub (`buildLibraryExport` works) | W1 |
| `storage/quota.ts` | stub (safe defaults) | W1 |
| `state/TrainerProvider.tsx` | stub (inert controller) | W1 |
| `state/trainerContext.ts` (`TrainerController`, `TrainerContext`, `useTrainer`) | contract, final | W0 |
| `trainer/segment.ts` | lifted | W2 |
| `trainer/import.ts` | stub | W2 |
| `trainer/keys.ts` | stub (minimal working) | W2 |
| `audio/duplex.ts` (+ `DuplexSession`, minimal `listen`) | lifted | W3 |
| `dsp/timestretch.ts` (`wsolaStretch`, `pitchShiftKeepDuration`) | lifted | W3 |
| `trainer/latency.ts` | lifted | W3 |
| `audio/player.ts`, `audio/route.ts`, `audio/diagnostics.ts` | stub (`describeRoute`, `formatDiagnostics` work) | W3 |
| `trainer/score/*` (all 12 files) | lifted | W4 |
| `trainer/compare.ts` | lifted + integrated with the scorer | W4 |
| `trainer/feedback.ts`, `trainer/srs.ts` | lifted | W4 |
| `trainer/phraseAnalysis.ts` | stub | W4 |
| `trainer/engine.ts` (`PracticeEngine`) | contract, final (types only) | W0 |
| `dsp/melody/*` (6 files) | lifted | W5 |
| `analysis/mixMode.ts` (`analyzeMix`, sets `mode: 'mix'`) | lifted, not yet called by `analyzeTake` | W5 |
| `coach/reference.ts` `transposeHint` | patched | W4 |
| `testing/trainerFixtures.ts` | final | W0 |
| `state/routing.ts`, `ui/components/Icon.tsx` | final (nav still maps `ROUTES`) | W6 |
| `ui/pages/Trainer.tsx`, `ui/pages/More.tsx` | empty shells | W6 |

## Privacy rules that apply to every module here

No network access from app code, no audio leaves the device, library export never contains audio, no commercial recordings in
the repo, tests or fixtures (synthetic audio from `testing/synth.ts` or canned objects only).
