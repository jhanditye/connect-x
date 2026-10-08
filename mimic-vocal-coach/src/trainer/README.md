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

### Review round 2: scoring decisions

| Question | Decision |
|---|---|
| Slow practice (0.5-0.9 guide speed) | `guideRate` (falls back to `PlayTiming.rate`): the reference is laid out at the played speed before the alignment and tempo is judged against it. Perfect slow copies score 96-100 (they were no-match at 50 % and 60 % for 8 s+ phrases) |
| Full-song references with more notes than were sung | "Rough guide": the take is not blamed for the extra notes (no coverage fix, far-off notes are not wrong notes, only whole-take fixes), trust is `caution` with the plain reason, `diagnostics.roughGuide`; an uncertain extractor (confidence under 0.8) also sets `refLowConfidence`, which `judgeTake` must read as not countable (no mastery, no review). A half-sung take is never rough |
| What counts as a wrong note | Non-ornament notes 150 cents or more off. Runs are judged loosely; octave-displaced is information. One definition: `compare.ts` `wrongNoteCount` |
| Mastery | 3 of the last 5 full-speed attempts reach 85 with pitch 80 or more (was 70), no other component under 70, no wrong note. Tone and expression are nearly free, so a take with 30-cent scatter reached 90 and counted |
| Which fixes show | From 1.5 points, or the one fix of a take under 95 (was 0.7 points: a random top fix in 56 % of identical performances) |
| Why a take did not match | `diagnostics.noMatchWhy` and `notes[0]`: `pitch-far` (rhythm agrees, notes far off), `locked-key` (singing along in another key), `rough-reference`. The notice should use `notes[0]` for these instead of the microphone advice |
| Short-phrase rounding | Nearest 5, but never up across a mark that means something (85 mastery, 80 passed review, 65 failed review): 83 is shown as 80 |
| Tone | One size scale; rasp ranks above breathiness; no "let more air in" for a reference with any roughness or a rasp difference; estimates say so and show no index numbers |

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

### Review round 2: data and import decisions

| Question | Decision |
|---|---|
| Re-adding a file after a backup restore | Matching uses the SOURCE file's length from the fingerprint (`audio/pcm.ts` `sameSourceFile`: same size and content hash, decoded length within 0.3 s; the excerpt offset is ignored), and `storage/library.ts` `findRelinkCandidates` is the one implementation behind `findRelinkMatches` and `relinkAudio`. A clip's own `durationSec` is only the kept excerpt |
| Opening IndexedDB | One failed open is not permanent: `UnknownError` / `AbortError` / `InvalidStateError` are retried twice (250 ms, 1 s), an open that never answers gives up after 10 s (the write probe too), and `StoreUnavailableError.retryable` says whether trying again later can help. A session that is memory-only for a retryable reason opens IndexedDB again on `reload()`, when a clip is about to be saved, and when the app returns to the foreground (at most every 20 s), and copies the session's clips into it (`copyLibrary`) |
| An interrupted import | `commitClip` writes the clip record FIRST (marked `audioMissing`), then the audio, then the record again with the flag cleared. A page killed in between leaves a clip that asks for its file again, never audio that no record owns. `ClipStore.pruneOrphanAudio()` removes chunks without a record once per open (older versions wrote audio first) |
| Backups | `exportLibrary` says what it left out (`lastExportReport`): a file whose practice history (or clip list) could not be read is saved but is not a backup and does not clear the reminder. `saveFileOutcome` separates `shared`, `saved`, `unverified` (an iPhone fell back to a download link: nobody can tell) and `needs-tap` (the share sheet was refused because the tap was used up: the next tap shares the file already built). The reminder is cleared only after `shared` or `saved` of a complete file |
| Clear all data | `AppController.clearAllData()` resolves `{ failed }` naming the places that could not be cleared; "All data cleared." is shown only when it is empty |
| Cancelling | `analyzeInWorker`, `analyzeWithRouting` / `AnalyzeFn`, `prepareClip`, `reanalyzeClip` and `analyzePhraseCached` take an `AbortSignal`: the worker is terminated and the promise rejects with an `AbortError` (`analysis/abort.ts`). The import sheet aborts a file when it is skipped and every file when it closes, and reads one file at a time (plus one look-ahead after the file on screen has been read) |
| Big files | The length of FLAC, MP3 (Xing/VBRI or first-frame bitrate) and Ogg is read from the header like MP4 (`audio/probe.ts`) and refused above 15 minutes; a compressed file whose length cannot be read is refused above 30 MB; a WAV is read only as far as the 5 minutes that are analysed. A WAV above 48 kHz is converted in slices (`trainer/resampleAsync.ts`) so the page stays responsive |
| Ownership tick | Asked for every file, never remembered, shown next to Save in the pinned footer with the file's name |
