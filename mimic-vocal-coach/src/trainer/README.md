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

### Reconciliation: done

The rules for flags, the one time model, tone dead zones, short phrases, range, gates, bleed and tone bias are in
`src/trainer/score/README.md`. `feedback.ts` ranks the scorer's own fixes (`score.fixes`, by points) and keeps `TrainerFix` as the UI shape.

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
  attempts, export / import, `openPractice`). Provider: `state/TrainerProvider.tsx`. Tests wrap screens in
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

All of it is implemented and tested unless a row says otherwise.

| Path | What it is |
|---|---|
| `storage/clips.ts`, `storage/clipStoreContract.ts` | `ClipStore`: IndexedDB `mimic-trainer` + an in-memory twin, one shared contract suite (a change to the interface goes in both stores and in the contract). `openClipStoreWithFallback` never rejects |
| `storage/library.ts`, `storage/quota.ts`, `audio/pcm.ts` | Backup export/import (never audio), merge, relink by fingerprint, `measuredFromClip`; storage estimate, persistence, space checks; Int16 chunks and fingerprints |
| `state/TrainerProvider.tsx` (+ `trainerReducer.ts`) | The real `TrainerController`; `useTrainerExtras()` for the backup reminder, storage note and memory-only reason. Takes `openPractice` (engine factory) as a prop |
| `state/trainerContext.ts` | `TrainerController`, `TrainerContext`, `useTrainer` |
| `trainer/import.ts`, `importCopy.ts`, `segment.ts`, `keys.ts` | Decode, analyse (solo first; if the solo pass raises 'accompaniment' the same audio is read again as a full song, in the worker, via `analysis/auto.ts`), classify, segment, commit, relink |
| `trainer/phraseAnalysis.ts` | Phrase window loading and the cached phrase analysis (mix-melody clips are analysed as a mix again) |
| `analysis/mixMode.ts`, `analysis/auto.ts`, `dsp/melody/*` | Full-song front end: lead-vocal melody extraction, solo-then-mix routing, the confidence the review shows |
| `audio/duplex.ts`, `audio/player.ts`, `audio/route.ts`, `audio/diagnostics.ts`, `dsp/timestretch.ts` (+ `stretch*`), `trainer/latency.ts` | One AudioContext for guide, count-in and stamped capture; phrase player; routes; device checks; WSOLA speed and key |
| `trainer/score/*`, `trainer/compare.ts`, `trainer/feedback.ts`, `trainer/srs.ts` | The scorer (the one score authority), per-note table, fixes, mastery and review |
| `trainer/engine.ts` | `PracticeEngine` contract. The real engine is `practiceEngine.ts` / `practiceSession.ts` (the engine workstream) |
| `ui/pages/Trainer*.tsx`, `ui/components/{ImportSheet,ClipReview,PhraseEditor,PhraseStrip,ResultSheet,...}` | The screens, against `TrainerController` and `PracticeEngine` only |
| `testing/trainerFixtures.ts`, `testing/songMix.ts`, `testing/fakeAudio.ts` | Fakes and synthetic audio. No recordings anywhere |

Cross-feature wiring worth knowing: `AppController.onClear` runs the Trainer's `clearAll` from "Clear all data";
`AppController.addMeasuredClip` is fed from the stored clip (`measuredFromClip`, weighted by the singing in the kept excerpt) both at
import and when the switch is tapped later, so the two give the same targets; the backup is counted as made only after `saveFile`
succeeds (`exportLibrary({ markDone: false })` then `markExported()`); inside the Capacitor app no service worker is registered
(`pwa/platform.ts` `detectNative`).

## Privacy rules that apply to every module here

No network access from app code, no audio leaves the device, library export never contains audio, no commercial recordings in
the repo, tests or fixtures (synthetic audio from `testing/synth.ts` or canned objects only).
