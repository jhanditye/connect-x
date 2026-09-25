# Mimic Vocal Coach — build spec

A browser app for a singer who wants to sound more like **Shawn Mendes**, **Daniel Caesar** or
**Jalen Ngonda**, with the focus on mixed voice (blending chest and head registers) and the tone
qualities that make each of those singers recognisable. The user records or uploads a take, the app
analyses it entirely in the browser, compares it with a target singer profile and produces a
prioritised coaching plan with exercises. An optional AI coach (Claude API, user's own key) turns the
numbers into conversational feedback.

Everything runs client-side. No audio leaves the device unless the user enables the AI coach, and even
then only the numeric analysis summary is sent (never audio).

Stack: Vite 8, React 19, TypeScript 5.9 (strict), Vitest 5. **No new runtime or dev dependencies**
beyond `package.json` without a very strong reason. Charts are hand-built SVG/canvas.

Shared contracts live in `src/types.ts`. Do not change existing type shapes; if a module needs an extra
internal type, define it locally. If you believe a contract change is essential, make the smallest
additive change (a new optional field) and say so in your final report.

## Directory map and ownership

| Path | Owner | Purpose |
|---|---|---|
| `src/types.ts` | lead | Shared contracts (read-only for agents) |
| `src/testing/synth.ts` | lead | Deterministic voice synthesiser for tests (`synthVoice`, `synthMelody`, `sine`, `silence`, `whiteNoise`, `concat`, `mix`) |
| `src/audio/wav.ts` | lead | `encodeWav`, `decodeWav` |
| `src/styles/tokens.css` | lead | Design tokens + base styles |
| `src/dsp/*` | DSP agent | FFT, resampling, pitch tracking, spectral measures, music/stat helpers |
| `src/analysis/*` | Analysis agent | Frame features → notes, vibrato, registers, onsets, runs → `VoiceAnalysis`; worker + client |
| `src/coach/profiles.ts`, `compare.ts`, `coach.ts`, `exercises.ts` | Coach agent | Singer profiles, scoring, coaching plan, exercise library |
| `src/coach/reference.ts`, `src/coach/ai.ts` | Reference/AI agent | Reference-clip comparison (DTW), profile from a reference clip, Claude AI coach |
| `src/main.tsx`, `src/App.tsx`, `src/state/*`, `src/audio/recorder.ts`, `src/audio/decode.ts`, `src/ui/pages/{Studio,Results,Settings,Guide}.tsx`, `src/ui/components/*`, `src/styles/app.css` | UI-core agent | App shell, navigation, capture, results page, settings, guide |
| `src/ui/charts/*`, `src/ui/pages/{Practice,Progress}.tsx`, `src/audio/tones.ts`, `src/storage/*`, `src/styles/viz.css` | UI-viz agent | Charts, practice player, history storage, progress page |

Agents only create/edit files they own (plus their own `*.test.ts(x)` next to them).

## Module signatures (the cross-module API)

### `src/dsp/` (DSP agent)

```ts
// dsp/fft.ts
export function nextPow2(n: number): number;
/** In-place iterative radix-2 complex FFT. re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse?: boolean): void;
export function hann(n: number): Float64Array;
/** |X(k)|^2 for k = 0..fftSize/2 of a (zero-padded) real frame. Frame is used as given (window it first). */
export function powerSpectrum(frame: ArrayLike<number>, fftSize: number): Float64Array;

// dsp/resample.ts
export function toMono(channels: Float32Array[]): Float32Array;
/** Band-limited resampling (low-pass before decimation). Returns input unchanged if rates match. */
export function resample(x: Float32Array, fromRate: number, toRate: number): Float32Array;
export const ANALYSIS_RATE = 22050;

// dsp/music.ts
export function hzToMidi(hz: number, a4Hz?: number): number;
export function midiToHz(midi: number, a4Hz?: number): number;
/** 60 -> "C4", 61 -> "C#4". Rounds to nearest note. */
export function midiToNoteName(midi: number): string;
export function noteNameToMidi(name: string): number;   // "C#4" / "Db4" / "c4"
export function centsBetween(hzA: number, hzB: number): number;

// dsp/stats.ts
export function mean(xs: ArrayLike<number>): number;         // ignores NaN; NaN if empty
export function median(xs: ArrayLike<number>): number;       // ignores NaN
export function percentile(xs: ArrayLike<number>, p: number): number; // p in 0..100, ignores NaN
export function std(xs: ArrayLike<number>): number;
export function linearRegression(xs: ArrayLike<number>, ys: ArrayLike<number>): { slope: number; intercept: number; r2: number };
export function movingAverage(xs: ArrayLike<number>, window: number): Float64Array; // NaN-aware
export function medianFilter(xs: ArrayLike<number>, window: number): Float64Array;  // NaN-aware
export function clamp(x: number, lo: number, hi: number): number;

// dsp/pitch.ts
export interface PitchTrack {
  sampleRate: number;
  hopSec: number;               // 0.01
  times: Float64Array;          // frame centre times, s
  f0: Float64Array;             // Hz, NaN when unvoiced
  periodicity: Float64Array;    // 0..1 (1 - YIN aperiodicity at the chosen lag)
  rmsDb: Float64Array;          // dBFS
  voiced: Uint8Array;           // 1 = voiced
}
export interface PitchOptions { hopSec?: number; minHz?: number; maxHz?: number; threshold?: number }
/** YIN (FFT-accelerated difference function) + voicing decision + octave-jump cleanup. Defaults 65–1400 Hz. */
export function trackPitch(x: Float32Array, sampleRate: number, opts?: PitchOptions): PitchTrack;
/** Single-frame YIN for live display (tuner). Returns null when unvoiced. */
export function detectPitch(frame: Float32Array, sampleRate: number, minHz?: number, maxHz?: number): { hz: number; periodicity: number } | null;

// dsp/spectral.ts
export interface SpectralFrame {
  h1h2Db: number; alphaRatioDb: number; centroidHz: number; tiltDbPerOct: number;
  cppDb: number; harmonicDb: number[];  // first 10 harmonic levels relative to H1 (H1 = 0)
  subharmonicDb: number;                // energy between harmonics at odd multiples of f0/2 relative to harmonics, dB
}
/** Measure one voiced frame of `x` centred at sample index `centre`, given its f0. Uses a ~93 ms Hann window at 22050 Hz. */
export function analyzeSpectralFrame(x: Float32Array, sampleRate: number, centre: number, f0: number): SpectralFrame;
/** HNR estimate from YIN periodicity p (0..1): 10*log10(p/(1-p)), clamped to [-5, 40]. */
export function hnrFromPeriodicity(p: number): number;
```

### `src/analysis/` (Analysis agent)

```ts
// analysis/passaggio.ts
export function passaggioFor(voiceType: VoiceType): PassaggioZone;
export const VOICE_TYPE_LABELS: Record<VoiceType, string>;

// analysis/analyze.ts
/** Full analysis of a take. `samples` is mono at any sample rate; resamples to ANALYSIS_RATE internally. */
export function analyzeTake(samples: Float32Array, sampleRate: number, opts: AnalysisOptions,
  onProgress?: (fraction: number) => void): VoiceAnalysis;

// analysis/client.ts  (main thread)
/** Runs analyzeTake in a Web Worker (import with `?worker&inline` so single-file builds work). Falls back to the main thread if workers are unavailable. */
export function analyzeInWorker(samples: Float32Array, sampleRate: number, opts: AnalysisOptions,
  onProgress?: (fraction: number) => void): Promise<VoiceAnalysis>;

// analysis/worker.ts — message protocol
// in:  { type: 'analyze', samples: Float32Array, sampleRate: number, opts: AnalysisOptions }
// out: { type: 'progress', value: number } | { type: 'result', analysis: VoiceAnalysis } | { type: 'error', message: string }
```

### `src/coach/` (Coach agent)

```ts
// coach/profiles.ts
export const SINGERS: SingerProfile[];            // shawn-mendes, daniel-caesar, jalen-ngonda (in that order)
export function getProfile(id: string): SingerProfile | undefined;
export const STYLE_LABELS: Record<StyleKey, { label: string; unit: string; lowWord: string; highWord: string; describe: (v: number) => string }>;

// coach/compare.ts
export function scoreDimension(value: number | null, band: TargetBand): number;  // 0..100
export function compareToProfile(analysis: VoiceAnalysis, profile: SingerProfile): Comparison;

// coach/exercises.ts
export const EXERCISES: Exercise[];
export function getExercise(id: string): Exercise | undefined;

// coach/coach.ts
export function buildCoachingPlan(analysis: VoiceAnalysis, comparison: Comparison, profile: SingerProfile): CoachingPlan;
```

### `src/coach/reference.ts`, `src/coach/ai.ts` (Reference/AI agent)

```ts
// coach/reference.ts
/** Build a SingerProfile whose targets are centred on a reference clip's measured StyleVector. */
export function profileFromReference(ref: VoiceAnalysis, name: string, base?: SingerProfile): SingerProfile;
/** Align the user's pitch contour to the reference (key-shift-invariant DTW) and compare phrase by phrase. */
export function compareToReference(user: VoiceAnalysis, ref: VoiceAnalysis): ReferenceComparison;

// coach/ai.ts
export interface AiCoachInput {
  analysis: VoiceAnalysis; comparison: Comparison; plan: CoachingPlan; profile: SingerProfile;
  reference?: ReferenceComparison; question?: string;
  history?: { role: 'user' | 'assistant'; text: string }[];
}
/** Streams coaching text from Claude using the user's API key. Throws AiCoachError with a user-facing message on failure. */
export function askAiCoach(input: AiCoachInput, settings: AppSettings,
  onText: (delta: string) => void, signal?: AbortSignal): Promise<string>;
export class AiCoachError extends Error { kind: 'auth' | 'rate' | 'network' | 'refusal' | 'other' }
export const DEFAULT_AI_MODEL = 'claude-opus-5';
/** Compact JSON-able summary of an analysis (no per-frame data) — what gets sent to the model. */
export function summarizeForAi(input: AiCoachInput): object;
```

### UI (UI-core and UI-viz agents)

Chart components (UI-viz owns; UI-core consumes). All props are plain data; components size themselves
to their container width (use a ResizeObserver or viewBox scaling) and read colours from CSS tokens.

```tsx
// ui/charts/PitchPlot.tsx
export function PitchPlot(props: {
  analysis: VoiceAnalysis;
  reference?: VoiceAnalysis;                 // overlaid, shifted by referenceShiftSemitones
  referenceShiftSemitones?: number;
  referencePath?: ReferenceComparison['path'];
  showRegisters?: boolean;                   // colour the contour by frame.register (default true)
  height?: number;                           // px, default 260
}): JSX.Element;
// Draws: note grid (horizontal lines at semitones, labelled C/E/G… note names), passaggio band shaded,
// pitch contour coloured chest/mix/head, vibrato notes marked, time axis in seconds.

// ui/charts/StyleRadar.tsx
export function StyleRadar(props: { comparison: Comparison; profile: SingerProfile; size?: number }): JSX.Element;
// One spoke per scored dimension (skip value===null), user polygon vs target ideal polygon, both normalised by band/tolerance.

// ui/charts/RangeKeyboard.tsx
export function RangeKeyboard(props: {
  userLow: number | null; userHigh: number | null;          // MIDI
  userTessitura?: [number, number] | null;
  singerRange?: { lowMidi: number; highMidi: number; tessituraLowMidi: number; tessituraHighMidi: number };
  singerColor?: string;
  passaggio?: PassaggioZone;
  fromMidi?: number; toMidi?: number;                       // default 40..84 (E2..C6)
}): JSX.Element;
// A piano strip with the user's range, the singer's range and the passaggio zone marked.

// ui/charts/RegisterBar.tsx
export function RegisterBar(props: { chest: number; mix: number; head: number; label?: string; target?: { chest: number; mix: number; head: number } }): JSX.Element;

// ui/charts/ScoreDial.tsx
export function ScoreDial(props: { score: number; label?: string; color?: string; size?: number }): JSX.Element;

// ui/charts/DimensionMeter.tsx
export function DimensionMeter(props: { result: DimensionResult }): JSX.Element;
// Horizontal track showing the target band, ideal tick and the user's marker; score chip; summary text.

// ui/charts/ProgressChart.tsx
export function ProgressChart(props: { sessions: SessionRecord[]; profileId?: string; metric?: 'overall' | StyleKey; height?: number }): JSX.Element;

// ui/charts/ReferenceDiffPlot.tsx
export function ReferenceDiffPlot(props: { comparison: ReferenceComparison; height?: number }): JSX.Element;
// cents difference along the aligned path with a ±50 cent band.
```

```ts
// storage/history.ts  (localStorage, JSON; every access wrapped in try/catch; works when storage is unavailable)
export function loadSessions(): SessionRecord[];
export function saveSession(rec: SessionRecord): void;          // keeps the newest 200
export function deleteSession(id: string): void;
export function clearSessions(): void;
export function sessionFromResults(analysis: VoiceAnalysis, comparison: Comparison, profile: SingerProfile, label?: string): SessionRecord;

// storage/settings.ts
export const DEFAULT_SETTINGS: AppSettings;                      // voiceType 'baritone', a4Hz 440, key null, aiModel DEFAULT_AI_MODEL literal 'claude-opus-5'
export function loadSettings(): AppSettings;
export function saveSettings(s: AppSettings): void;

// audio/tones.ts  (Web Audio; must be started from a user gesture)
export interface PatternPlayer { stop(): void; readonly playing: boolean }
export function playPattern(ex: Exercise, passaggioLowMidi: number, opts?: { a4Hz?: number; volume?: number; onStep?: (midi: number, rep: number) => void; onEnd?: () => void }): PatternPlayer;
export function playNote(midi: number, durSec: number, opts?: { a4Hz?: number; volume?: number }): void;
export function startDrone(midi: number, opts?: { a4Hz?: number; volume?: number }): { stop(): void };
```

```tsx
// ui/pages/Practice.tsx   (UI-viz)
export function PracticePage(props: { settings: AppSettings; focusExerciseIds?: string[]; onRecordDrill?: (exerciseId: string) => void }): JSX.Element;
// ui/pages/Progress.tsx   (UI-viz)
export function ProgressPage(props: { sessions: SessionRecord[]; onDelete: (id: string) => void; onClear: () => void }): JSX.Element;
```

```ts
// audio/decode.ts   (UI-core)
/** Decode any browser-supported audio file to mono Float32 at its native rate. Uses decodeWav for WAV first, then AudioContext.decodeAudioData. */
export function decodeAudioFile(file: Blob): Promise<{ samples: Float32Array; sampleRate: number; durationSec: number }>;
// audio/recorder.ts (UI-core)
export interface Recorder {
  start(): Promise<void>; stop(): Promise<{ samples: Float32Array; sampleRate: number }>; cancel(): void;
  readonly analyser: AnalyserNode | null;   // for level meter / live pitch
}
/** getUserMedia with echoCancellation/noiseSuppression/autoGainControl OFF (they wreck voice analysis). Throws RecorderError('denied'|'unsupported'|'no-device'). */
export function createRecorder(): Recorder;
```

## Pages and flow (UI)

Hash routes with bare tokens (`#studio`, `#results`, `#practice`, `#progress`, `#guide`, `#settings`).

1. **Studio** (default): pick the target singer (three cards + "Use a reference clip" card), see the
   singer's sound in a sentence and the songs to study, then capture: Record (with live level meter,
   live note/tuner readout and elapsed time) or Upload a file (drag-and-drop too). Optional: upload a
   reference clip of the artist (from music the user owns; isolated vocals work best) to calibrate the
   target and to compare phrase-by-phrase. "Try a demo take" button analyses a synthesized sample so
   the app shows a working state without a microphone. Analysis runs with a progress bar.
2. **Results**: overall match (ScoreDial), headline, recording warnings, StyleRadar, DimensionMeters,
   PitchPlot with register colouring, RangeKeyboard, RegisterBar (upper range vs target), coaching
   items with linked exercises, signature-move focus, health notes, reference comparison (if any),
   AI coach panel (if key set), "Save to progress" and "Download analysis (JSON)" / "Download take (WAV)".
3. **Practice**: exercise library filtered by the current plan's focus; each exercise shows steps, a
   play/stop pattern player transposed to the user's voice type, and "Record this drill".
4. **Progress**: history list and trend chart per singer and per metric.
5. **Guide**: what mixed voice is, how each measurement works and its limits, how to record well,
   vocal-health advice, how the singer profiles were built.
6. **Settings**: voice type (explains passaggio), tuning A4, AI coach key and model, clear data, theme.

The microphone can be unavailable (permissions, sandboxed iframes). The UI must detect this and steer
the user to uploading a voice memo instead, never dead-ending.

## Visual design

Subject: a practice-room tool for a singer. Treatment: an app they will keep, so polished and
characterful, but information-first.

- Palette (see tokens.css): cool sage-grey paper `--paper`, off-white surfaces, near-black ink, teal
  accent `--accent` for interaction, a red recording light `--rec`. Register colours are an ordered
  ramp chest `--reg-chest` (orange) → mix `--reg-mix` (violet, the blend) → head `--reg-head` (blue).
  Singer colours: `--singer-shawn` amber, `--singer-daniel` green, `--singer-jalen` soul red.
- Type: display `--font-display` (Gloock, high-contrast serif, record-sleeve feel) for page titles,
  singer names and the big score only; body `--font-body` (Figtree); numbers, notes, Hz, cents in
  `--font-mono` with tabular numerals.
- Layout: max content width `--content-max`, 16px minimum side gutter, top bar with brand + nav on
  desktop, bottom tab bar on phones (`env(safe-area-inset-bottom)` padding). Cards only for things that
  are separate objects (singer cards, coaching items); everything else sits on the paper with rules.
- Music-specific details are content, not ornament: note names (C4, G#4), cents, Hz, a piano strip for
  range, passaggio shading on the pitch plot.
- Both themes via tokens only. No emoji as icons. Visible focus states. Respect reduced motion.
  Mobile first: must work at 360–400px wide with no horizontal page scroll.

## Voice-science ground rules (for analysis and coaching copy)

- Register labels are *estimates* from acoustic proxies (H1–H2, spectral tilt, alpha ratio, CPP,
  loudness vs pitch). Say so in the UI; never present them as certain.
- Coaching must be safe: never tell the user to push louder or "power through" strain; cue lighter
  weight, narrower vowels, SOVT (straw, lip trills), rest, hydration. Rasp imitation comes with care
  warnings (don't manufacture grit by squeezing; stop if it hurts or voice gets hoarse).
- Singer descriptions are impressionistic, based on widely shared listening observations; the app
  says so and offers calibration from a reference clip. Do not invent quotes, awards, or facts.
- The app never distributes artist audio. Reference clips come from the user's own files and stay on
  the device.
