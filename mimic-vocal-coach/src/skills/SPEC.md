# Skills: contracts and module map

A second function of Mimic: fundamentals for becoming a good singer (note accuracy above all, intervals, scale-degree
lines, breath), next to the mimicry Trainer. All types are in `src/skills/types.ts`; build against them, change them
only with the lead. Pure code first, audio and UI on top. Everything local, nothing uploaded, no audio stored.

## 1. Module map and owners

| Path | What | Status |
|---|---|---|
| `src/skills/types.ts` | Every shared type and cross-module constant | done (architect) |
| `src/skills/theory/` | Intervals, keys, degrees, parser, range fitting, generators, prompt events, breath plan | done, 82 tests |
| `src/skills/score/` | Pure scorers over `Float32Array` + sample rate (uses `trackPitch`) | score agent |
| `src/skills/audio/` | Prompt playback (on `src/audio/tones.ts`), capture with auto-stop (on `createRecorder`) | audio agent |
| `src/skills/progress/` | Store `mimic:v1:skills`, moving stats, adaptive picks, workout plan, history series, backup | progress agent |
| `src/ui/skills/` | `SkillsPage`, hub, eight screens, shared widgets, `skills.css` | shell agent (page, hub, progress screen, nav, Guide, backup wiring) and screens agent (exercise screens + widgets) |
| `src/state/routing.ts`, `src/App.tsx`, `src/ui/components/Nav.tsx`, `src/storage/library.ts`, `src/ui/pages/Guide.tsx` | Small additive edits | shell agent |

Reuse, do not duplicate: `dsp/music.ts` (hzToMidi, midiToHz, centsBetween), `dsp/pitch.ts` (`trackPitch` offline at
10 ms, `detectPitch` live), `dsp/stats.ts` (median, std, linearRegression, movingAverage, medianFilter),
`audio/tones.ts` (piano voice, shared AudioContext), `audio/recorder.ts` (`createRecorder`, `RecorderError`,
`deniedMessage`, interruptions), `ui/components/live.ts` (`blockLevel`, `levelState`, `meterFraction`,
`traceWindow`), `ui/components/LiveMonitor.tsx` ideas, `ui/charts/chartKit.ts`, `pwa/words.ts` (Mac vs iPhone
wording, `headphoneAdvice`, `tapVerb`, `interruptionText`), `analysis/passaggio.ts` (`passaggioFor`),
`testing/synth.ts` (`synthMelody`, `whiteNoise`, `silence`, `concat`, `mix`).

## 2. Theory (`src/skills/theory`, import from `./theory` index)

- `rng.ts`: `mulberry32(seed): Rng`, `makeSkillsRng(seed?)`, `randInt`, `pick`, `shuffle`, `weightedIndex(rng, weights)`, `rngId`.
- `intervals.ts`: `INTERVALS` (0..17; P1 m2 M2 m3 M3 P4 TT P5 m6 M6 m7 M7 P8, then m9..P11), `intervalInfo`, `intervalName(s, capital?)`, `intervalShort`, `intervalPhrase(s, dir)` ("a major 6th up"), `intervalKey(s, dir)` / `parseIntervalKey` ("7u" "7d" "7h"), `intervalTargetMidi`, `EAR_LEVELS` (1 Starter P4 P5 P8 M3; 2 +m3 M2; 3 +M6 m6; 4 +m7 M7; 5 +m2 TT), `earSetForLevel`, `cleanIntervalSet`, `INTERVAL_SONG_HINTS` (only well-known ascending openings).
- `scales.ts`: `SCALE_STEPS` (major / natural-minor / harmonic-minor), `degreeSemitones(written, mode)` (8 = 12), `noteMidi(key, note)`, `noteHz(key, note, a4Hz)`, `degreeOfMidi`, `SOLFEGE` (movable do; minor is do-based: me le te, harmonic minor ti), `keyTonicName`, `keyName` ("E♭ major", "A minor"), `spellDegree` (E# in F# major), `spellDegreeWithOctave`, `prettyAccidentals`, `degreeLabel(note, mode, labelMode, key?) -> {text, octaveMark}`, `lineLabels`, `degreeLabelText`, `cadenceChords(key)` (I-IV-V7-I close voicing with bass; minor i-iv-V7-i).
- `sequence.ts`: `parseSequence(text, mode='major'): SequenceParse`, `tokenizeSequence`, `placeDegrees(tokens, mode)`, `sequenceText(notes)` (canonical "2 7- 6- 5-"), `lineSpan`, `lineSteps`, `MAX_SEQUENCE_NOTES = 16`.
- `range.ts`: `comfortableRange(voiceType, override?)`, `COMFORTABLE_LOW_MIDI`, `registerBands`, `registerThirdOf`, `inRange`, `candidateTonics(offsets, range, margin=1)`, `fitTonic(offsets, range, rng?, spread=2)`, `fitSequence(notes, mode, range, rng?, text?) -> SequenceTarget | null`, `tooWideMessage`.
- `generate.ts`: `singleNoteTargets(range, count, rng)` (thirds: 10 -> 3/4/3, no back-to-back repeats), `intervalQuestion(rng, set, range, {directions, weights})`, `singIntervalTarget`, `intervalTargetOf`, `degreeQuestion(rng, mode, range, weights?)`, `SEQUENCE_PRESETS`, `stepwise`, `lineFromDegrees`, `randomLine(rng, length, mode, {degreeWeights, maxLeap=7, maxSpan=12})`, `mixedLength` (4..8).
- `prompts.ts`: pure `ToneEvent[]` builders: `noteEvents`, `intervalEvents`, `cadenceEvents(key, withTonic)`, `lineEvents`, `earQuestionEvents`, `compareIntervalEvents`, `concatEvents`, `shiftEvents`, `eventsDuration`, `PROMPT_TIMING` (single note 1.2 s, then 0.35 s before capture).
- `breath.ts`: `pacedBreathPlan()` (inhale 4, suspend 4, exhale 8 -> +2 per round, cap 20, 5 rounds), `pacedPlanSeconds`, `BREATH_SAFETY_NOTES`.

**Ranges.** Top = passaggio low + 3 semitones; bottom per voice type: bass F2-D4 (41-62), baritone A2-F4 (45-65),
tenor C3-G4 (48-67), alto F3-B♭4 (53-70), mezzo G3-C5 (55-72), soprano A3-D5 (57-74). `prefs.rangeOverride` (span >= 12)
wins. Lines are fitted with 1 semitone of margin when possible, centred; nothing outside the range is ever asked for.

**Sequence syntax.** Degrees 1-8, separated by spaces or commas (digits may run together: "765432"). Octave marks
after a degree: `-` or `_` below, `+` or `'` above, up to 2. Marks are absolute (relative to the home octave), and 8 is
always the upper tonic. Unmarked: the first degree sits 0-11 semitones above the tonic; each later one takes the octave
nearest the previous note; an exact tie (tritone) goes to the octave nearer the first note, then the line's overall
direction (last vs first typed degree), then down. Errors are sentences with a character position (0, 9, 10, letters,
sharps/flats, marks before a degree, more than 16 notes, span over 2 octaves).

## 3. Scoring (`src/skills/score`), all pure

```ts
scoreHeldNote(samples: Float32Array, sampleRate: number, targetMidi: number, opts: ScoreOptions & { range: VoiceRange }): HeldNoteScore
summarisePitchTest(notes: HeldNoteScore[], toleranceCents: number): PitchTestSummary
createLockTracker(targetMidi: number, toleranceCents: number, holdSec?: number /*1.5*/): {
  push(r: LiveReading): { centsNow: number | null; inside: boolean; heldSec: number; locked: boolean; lockSec: number | null }; reset(): void }
segmentNotes(samples: Float32Array, sampleRate: number, a4Hz: number): SungNote[]
scoreSungInterval(samples, sampleRate, target: IntervalTarget, opts: ScoreOptions): SungIntervalScore
scoreSequence(samples, sampleRate, target: SequenceTarget, opts: ScoreOptions): SequenceScore
alignNotes(expectedMidis: number[], sung: SungNote[], octaveOffset: number): { match: (number | null)[]; extras: number[] }
scoreHiss(samples, sampleRate): HissScore
scoreLongTone(samples, sampleRate, opts: { a4Hz: number }): LongToneScore
formatCents(c: number): string            // "+12 cents", "−8 cents" (chartKit MINUS)
centsMeaning(c: number): string           // "25 cents is a quarter of a semitone"
```

Numbers (put them in `score/constants.ts`):
- Pitch = `hzToMidi(f0, a4Hz)` from `trackPitch` (10 ms). Voiced = `voiced` flag. **Too quiet** when voiced time < 0.3 s
  or the 90th-percentile rmsDb of voiced frames < -50 dBFS: status `too-quiet`, numbers null, finding says so.
- Smoothed pitch = 200 ms centred moving average over voiced runs (one vibrato cycle at 5 Hz), used for steadiness,
  landing window detection, stability and lock-in. **Held** = median of raw pitch over the steady part (whole note
  minus the first 250 ms after onset and the last 150 ms before release, frames whose smoothed pitch is within 50 cents
  of the note median). **Landing** = mean of the first 200 ms after the smoothed slope first drops under 3 semitones/s.
  **Stability** = SD of smoothed pitch over the steady part (vibrato is not instability). **Time to land** = onset to
  the first time the smoothed pitch enters the tolerance band and stays 300 ms.
- **Octave**: `octaveOffset = round((held - target) / 12)`; errors are always judged on pitch class (|error| <= 600);
  non-zero offset gives an info finding "right note, different octave", never a 1200-cent miss.
- **Notes in a line**: a note is >= 120 ms of smoothed pitch within 50 cents of its running median; boundaries where
  pitch moves > 60 cents and stays 80 ms, or an unvoiced gap >= 60 ms, or a level dip >= 6 dB (repeated notes); frames
  with |slope| > 4 semitones/s (glides) belong to no note; gaps < 100 ms bridged.
- **Alignment** (DP, monotone): match cost min(|cents|, 400)/100, missing 2.5, extra 1.5 (extra < 200 ms: 0.5). Whole-
  take octave offset k in -2..2 chosen by lowest total cost; a single note > 600 cents off after k is folded and
  flagged `octaveSlip`.
- **Interval size** (the core skill): `intervalCents = sign(dir) * (second - first) * 100 - semitones * 100` (+ too
  wide); `referenceCents` and `targetCents` reported separately. Wrong direction flagged.
- **Drift**: linear regression of signed note error on note start time; `driftCents` = slope x (last - first start);
  a finding when |drift| >= 20 cents and >= 4 notes.
- **Within** = |error| <= tolerance (Gentle 50, Standard 25, Strict 15); summaries also report within 50.
- **Hiss**: 20 ms frames; noise floor = median level of the first 0.5 s (10th percentile of the take if louder);
  hiss frame = level >= floor + 8 dB, periodicity < 0.5, energy above 2 kHz >= 35 % of total. Duration = longest run
  (gaps <= 0.3 s bridged). Steadiness = SD of 100 ms-smoothed level, excluding 0.3 s at each end: <= 1.5 dB very
  steady, <= 3 steady, <= 5 a bit uneven, else uneven. Mostly voiced loud frames -> status `voiced`.
- **Long tone**: longest voiced run (gaps <= 150 ms bridged); pitch SD of smoothed pitch after the first 300 ms (<= 10
  cents very steady, <= 20 steady, <= 35 wobbly); loudness SD of 100 ms level.
- **Findings**: at most 3, plain, encouraging, numbers with meaning. Pitch test: bias (|bias| >= 10, n >= 5:
  "you tend to sit 15 cents flat"), weakest register (n >= 2, |bias| >= 20: "your high notes sit about 30 cents
  flat"), scooping (landing - held <= -30), wandering (stability > 20), octave slips (info), praise when >= 80 %
  within. Sequence: worst degree ("your 7 sat 40 cents flat"), drift, missing/extra, octave offset (info, fine).

## 4. Audio (`src/skills/audio`)

```ts
// prompts.ts: plays ToneEvents with the piano voice, scheduled on AudioContext time. May add ONE additive export to
// src/audio/tones.ts (e.g. scheduleTones) if a scheduling primitive is needed; never change existing behaviour.
playEvents(events: ToneEvent[], opts: { a4Hz: number; volume?: number; onEvent?(e: ToneEvent, i: number): void }): {
  durationSec: number; done: Promise<'ended' | 'stopped'>; stop(): void }
startDroneFor(midi: number, a4Hz: number): { stop(): void }        // wraps tones.startDrone; only after headphones = yes
// capture.ts
createAutoStop(rule: AutoStopRule): { push(r: LiveReading): StopReason | null; readonly notesHeard: number; readonly soundStarted: boolean }  // pure
readLive(analyser: AnalyserNode, buf: Float32Array, a4Hz: number, t: number): LiveReading            // detectPitch + blockLevel
startSkillCapture(opts: { rule: AutoStopRule; a4Hz: number; onReading?(r: LiveReading): void;
  onAutoStop?(reason: StopReason): void; onInterruption?(reason: InterruptionReason): void }): Promise<SkillCapture>
interface SkillCapture { readonly analyser: AnalyserNode | null; readonly elapsedSec: number;
  stop(reason: StopReason): Promise<CaptureResult>; cancel(): void }   // start errors are RecorderError, shown with existing wording
```

Flow per item: play prompt -> wait `PROMPT_TIMING.beforeCaptureSec` -> `startSkillCapture` -> "Sing now" with live
needle/trace -> stop by button, Return/Space (Mac keyboard; ignored while a text field has focus), auto-stop, or cap.
The microphone is never open while a prompt plays. Auto-stop rules: pitch test `held-note` {holdSec 1.5, steadyCents
50, capSec 5}; match `manual` {capSec 20} ended by the lock tracker; intervals `notes` {2, silenceSec 1.2, capSec 8};
sequences `notes` {n, 1.2, min(30, 4 + 1.5n)}; hiss `sustain` {0.8, 90}; long tone `sustain` {0.8, 60}. Live note
count: >= 150 ms voiced within 50 cents; a new note after a > 70 cent move held 120 ms or >= 80 ms unvoiced. Silence =
rmsDb < max(-55, floor + 6).

## 5. Progress (`src/skills/progress`)

Key `mimic:v1:skills` (already removed by `removeAllAppKeys`, prefix `mimic:`). Shape `SkillsStore` (types.ts):
`{ version: 1, sessions (oldest first, cap 500), stats, bests, prefs }`. Stats are derived from sessions and can be
rebuilt in time order (import uses this).

```ts
DEFAULT_SKILLS_PREFS: SkillsPrefs   // standard, numbers, major, level 1, custom [], directions ['up','down'], headphones null, override null
emptySkillsStore(): SkillsStore
parseSkillsStore(x: unknown): SkillsStore          // field-by-field; bad sessions dropped; never throws
loadSkillsStore(): SkillsStore; saveSkillsStore(s: SkillsStore): boolean   // memory fallback like settings.ts
subscribeSkillsStore(fn: () => void): () => void; clearSkillsStore(): void
recordSkillsSession(store, session: SkillsSession): SkillsStore              // pure: append, cap, stats, bests
updateSkillsPrefs(store, patch: Partial<SkillsPrefs>): SkillsStore
rebuildStats(sessions: SkillsSession[]): { stats: SkillsStats; bests: SkillsBests }
updateRate(s: RateStat | undefined, correct: boolean, at: string): RateStat
updateCents(s: CentsStat | undefined, cents: number, at: string): CentsStat // alpha = max(0.2, 1/n)
intervalWeakness(stats, semitones, direction, kind: 'hear' | 'sing'): number   // 0..1; unseen 0.5; hear 1-ema; sing min(1, emaAbs/50)
degreeWeights(stats, mode): number[]   // 7 weights = 0.15 + weakness (feeds randomLine)
pickAdaptive<T>(rng: Rng, items: T[], weakness: (t: T) => number, count: number, easyShare?: number /*0.2*/): T[]
weakestIntervals(stats, n, kind): { semitones: number; direction: IntervalDirection }[]
buildWorkout(store, settings: AppSettings, rng: Rng): WorkoutStep[]
workoutFindings(store, workout: WorkoutSession): Finding[]     // improved / steady / work on next, vs the previous same-kind session
metricSeries(sessions, metric: SkillsMetric): { at: string; value: number }[]
skillsId(): string
exportSkillsForBackup(): SkillsStore | null            // null when empty
importSkillsFromBackup(raw: unknown): { added: number; skipped: number }   // merge by session id, rebuild stats
```

Workout (~10 min): paced breathing 2 rounds; match 6 notes; 10 ear questions on the weakest intervals (4 weakest + 2
easy); 4 sung intervals; 2 sequences from `randomLine` with `degreeWeights`; one hiss test. Steps are recorded as their
own sessions with `workoutId`, then one `WorkoutSession`. Backup: `LibraryExport` gains optional `skills?: SkillsStore`
(old backups without it stay valid); "Delete everything" also calls `clearSkillsStore()`.

## 6. Routing and UI (`src/ui/skills`)

`src/state/routing.ts`: `ROUTES` gains `'skills'` (label "Skills"); `TOP_ROUTES` = trainer, skills, studio, results,
practice, progress, guide, settings; `TAB_ROUTES` = trainer, skills, studio, progress, more; `MORE_ROUTES` = results,
practice, guide, settings (so `tabFor('results')` is More: check Studio's hand-off to Results and existing nav tests).
Add `parseSkillsPath(hash): SkillsPath` ("#skills/sequence?seed=7" -> {view: 'sequence', seed: 7}; unknown view -> hub;
seed = integer 0..2^32-1 else null), `skillsHash(path)`, `goSkills(path)`, `useSkillsPath()`.

Components (props from types.ts):
- `SkillsPage({ settings })`: owns the store (`useSyncExternalStore` on `subscribeSkillsStore`), renders the view.
- `SkillsHub({ store, settings, onOpen(view), onPrefs })`: cards for each exercise with the last number; Workout first;
  strictness and label mode pickers.
- `PitchTestScreen(SkillScreenProps<PitchTestSession> & { plan?: PitchTestPlan })` (default 10 notes)
- `MatchNoteScreen(... MatchSession & { plan?: MatchPlan })` (drone only after the headphones question)
- `EarTrainingScreen(... EarSession & { plan?: EarPlan })` (number keys answer, Space replays; wrong -> compare)
- `SingIntervalsScreen(... SingIntervalsSession & { plan?: SingIntervalsPlan })` ("Sing the note, then a major 6th up")
- `SequenceScreen(... SequenceSession & { plan?: SequencePlan })` (presets, text box with live parse errors, read / listen)
- `BreathScreen(... BreathSession & { plan?: BreathPlan })` (paced guide, hiss test, long tone; `BREATH_SAFETY_NOTES` always visible)
- `WorkoutScreen(SkillScreenProps<WorkoutSession> & { store: SkillsStore; onStepDone(s: SkillsSession): void })`
- `SkillsProgressScreen({ store, settings, onExit })`: charts per `SkillsMetric`, per-interval table (recognition %
  and singing error, up/down), per-degree signed-cents bars with counts, per-register accuracy.
- Shared widgets: `CapturePanel`, `PitchNeedle({ centsNow, toleranceCents })`, `LiveTrace`, `DegreeStrip({ labels,
  results?, activeIndex? })`, `BreathGuide({ plan, onFinish })`, `SafetyNote`, `FindingList({ findings })`,
  `StrictnessPicker`, `HeadphonesQuestion`; hook `useStopKeys(enabled, onStop)`.
- Copy: never "you failed"; cents with meaning (100 cents = 1 semitone; 25 = a quarter); Mac vs iPhone words from
  `pwa/words.ts`. Guide gets a "Skills" section (cents, intervals, scale degrees, breath safety).

## 7. Test plan

- Theory (done): tables, solfege, spelling, parser examples and errors, round trip, tritone ties, range fitting for all
  six voice types and every preset/random line, seeded determinism, prompt timing, breath plan.
- Score, calibrated on `synthMelody` (vibrato 5.5 Hz +/-40 cents, jitter 0.5 %, breath 0.1): in tune -> |held| <= 5
  cents; +30 cents -> 30 +/- 5; 150-cent scoop over 120 ms -> landing < -50, held within 5; octave below -> offset -1,
  error ~0; amplitude 0.002 -> `too-quiet`; "7 6 5 4 3 2" with a 7 at -40 -> note 0 flagged, others <= 8; missing 5 ->
  `missing` = 1 at index 2; extra short note -> 1 extra, rest aligned; 80 ms legato glides -> no extra notes; whole line
  an octave down -> offset -1, same accuracy; linear -40 cent drift over 6 notes -> drift -40 +/- 8; interval sung 30
  cents wide from a 20-cent-sharp start -> intervalCents 30 +/- 5, referenceCents 20 +/- 5; hiss 3 s after 0.6 s room
  noise -> 3 +/- 0.2 s; sung vowel -> not hiss; room noise only -> no hiss.
- Audio: `createAutoStop` on synthetic reading streams for each rule; `playEvents` with the fake AudioContext.
- Progress: parse garbage, cap 500, EMA maths, rebuild = incremental, import merge by id, adaptive picker bias and easy share.
- UI: each screen renders with `seed` and fake audio; keyboard (number keys, Space, Return); routing parse/hash round trip;
  phone tab bar shows five tabs with Skills second and Results under More.
