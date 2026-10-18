# Skills audio: prompts and capture

Plays what the singer has to match, then records their answer. Import everything from `src/skills/audio` (index.ts).
The contract is in `src/skills/SPEC.md`, section 4. Nothing is uploaded and no audio is stored.

| File | What it does |
|---|---|
| `prompts.ts` | `playEvents` plays `ToneEvent[]` from `src/skills/theory/prompts.ts` with the piano voice. Also `startDroneFor`, the prompt volume, `stopAllPrompts` and `waitSec`. |
| `autoStop.ts` | `createAutoStop(rule)` (pure) and `AUTO_STOP_RULES`, which holds the SPEC's rule for each exercise. Also the floor tracker and the pitch-run follower it uses. |
| `capture.ts` | `startSkillCapture` handles one microphone take: live readings, auto-stop, stop and cancel. Also `readLive`, `createLiveSmoother` and `promptThenCapture`, which runs the whole per-item flow. |
| `testKit.ts` | Test fakes: a Web Audio context whose clock follows `Date.now()` (fake timers drive it) and a recorder that serves a prepared signal through its analyser. The app does not use it. |

`src/audio/tones.ts` has one additive export, `scheduleTones(tones, { volume, leadSec })`. It schedules many
piano-voice tones on the shared AudioContext's clock, using one master bus. Nothing else in `tones.ts` changed, and
its 9 tests still pass.

## The per-item flow

```ts
import { promptThenCapture, AUTO_STOP_RULES } from '../../skills/audio';
import { cadenceEvents, lineEvents, concatEvents, PROMPT_TIMING } from '../../skills/theory';

const events = concatEvents(cadenceEvents(target.key), lineEvents(target), 0.4);   // "Listen and repeat"
const cap = await promptThenCapture(events, {
  a4Hz: settings.a4Hz,
  rule: AUTO_STOP_RULES.sequence(target.midis.length),
  onEvent: (e) => setActive(e.index ?? null),      // highlight the degree that is sounding
  onPromptDone: ({ stalled }) => stalled ? showPlayAgain() : setPhase('get-ready'),
  onReading: (r) => needle.push(r),                // ~33 a second; r.midi is null when unvoiced
  onAutoStop: () => void finish(),
  onInterruption: (reason) => showInterruption(reason),
  signal: abortController.signal,                  // the screen closed: stop the prompt / drop the take
});
if (!cap) return;                                  // aborted before the microphone opened
// ... Return/Space or the Stop button: cap.stop('key' | 'button')
const take = await cap.stop('button');             // { samples, sampleRate, stoppedBy, interrupted, log, notesHeard }
const score = scoreSequence(take.samples, take.sampleRate, target, { a4Hz, toleranceCents });
```

`promptThenCapture` does three things in order:

1. It plays the prompt and waits for `done`, which comes after the last note's release.
2. It waits `PROMPT_TIMING.beforeCaptureSec` (0.35 s) so the room and the speaker can ring out.
3. It opens the microphone.

So **the microphone is never open while a prompt plays.** `startSkillCapture` also calls `stopAllPrompts()` first.
Screens that run the steps themselves should keep this order.

Errors when the microphone cannot open are the recorder's own `RecorderError` (`denied`, `unsupported` or
`no-device`). Its `message` already uses the Mac or iPhone wording (`deniedMessage`, `microphoneBlockedText`).

## Playback (`playEvents`)

- **Scheduling.** Times come from the AudioContext clock, starting 0.08 s after the call. Notes are sample-accurate,
  and chords start together.
- **`onEvent` and `done`.** The player polls the clock every 20 ms. `onEvent(e, i)` fires in start order, within one
  poll of the sound. `done` resolves `'ended'` once the clock passes the last release, and never rejects.
- **`stop()`.** It fades the bus out over 40 ms, stops every voice and resolves `'stopped'`.
- **`durationSec`.** The time from the call until `'ended'`.
- **`stalled`.** If the audio clock does not move for 1.5 s, the prompt ends with `stalled: true` and everything
  scheduled is silenced, so it cannot start later in the middle of a take. This happens when there is no Web Audio, or
  when an iPhone keeps audio blocked outside a tap. Show a "Play again" button: tapping it unlocks the audio.
- **Loudness.** The per-note peak is 0.8 × the event's `gain`. Chords of three or more notes are divided by √(n/2)
  for headroom. Notes are clamped to the piano range A0-C8.
- **Volume.** Pass `volume` on each call, or use `setPromptVolume(v)`, which sets the default in memory, 0..1. The
  default is 0.35, the same as the practice tones.
- **Cadence.** `cadenceEvents(key)` plays I-IV-V7-I, or i-iv-V7-i in minor, then the tonic. The voicing comes from
  `theory/scales.ts`. A test checks it in major, natural minor and harmonic minor, on four tonics:
  - the upper voices stay in close position (within an octave);
  - each upper voice moves at most 2 semitones;
  - V7 has the raised leading tone, which resolves up to the tonic.
- **Tempo.** A line plays at `PROMPT_TIMING.lineNoteSec` (0.6 s per note plus a 0.06 s gap). Use
  `lineEvents(target, noteSec)` for another tempo.
- **Drone.** `startDroneFor(midi, a4Hz, volume?)` holds a note until `stop()`. Use it only after the singer has
  answered yes to the headphones question; through speakers the drone leaks into the microphone.
- **iPhone audio session.** `tones.ts` sets the session to `playback` so the ring/silent switch does not mute the
  prompts. A `playback` session would stop an open microphone, so while a take is open, `playEvents` and
  `startDroneFor` put the session back to `auto`.

## Capture (`startSkillCapture`)

It wraps `createRecorder()`, which gives:

- raw PCM, with echo cancellation, noise suppression and automatic gain off;
- the microphone chosen in Settings;
- the wake lock;
- `prepareForCapture()`;
- the interruption listeners.

About every 30 ms (~33 Hz) it reads the analyser:

- **`readLive`.** `blockLevel` gives the level, and `detectPitch` the pitch: 70-1100 Hz, no pitch below -60 dBFS,
  the same as LiveMonitor.
- **`createLiveSmoother`.** It replaces each voiced reading with the median of the last five voiced readings, which
  removes one- and two-frame octave flicks. The cost is about 60 ms of delay. A real octave leap comes through after
  three readings.
- **When it reads.** Only when the audio clock has moved, so a take suspended by the system adds no readings.
  Reading times `t` are seconds on the capture's audio clock.

**Ending the take.** `stop(reason)` is idempotent, and the first reason wins. After an auto-stop, a later
`stop('button')` returns the same result with `stoppedBy: 'auto-held'`. `cancel()` drops the audio.

**Interruptions.** The page going to the background, a muted or ended track, or a stopped audio engine all end the
take:

- `stoppedBy` is `'interrupted'`, and `interrupted` holds the reason;
- `onInterruption` is called;
- the existing wording says "an interrupted take is not scored, and you press Try again".

`'no-audio'` (nothing arrived in 2 s) is only reported, because sound may still arrive. A wall-clock cap (the
rule's cap + 5 s) also ends a take whose audio clock has stalled.

**What `stop` returns.** A `SkillCaptureResult`, which is `CaptureResult` (the `types.ts` contract) plus:

- `log`: the live readings;
- `notesHeard`.

### Auto-stop rules (`AUTO_STOP_RULES`)

| Exercise | Rule | Ends when |
|---|---|---|
| Pitch test | `held-note` {1.5 s, 50 cents, cap 5 s} | A steady note has been held 1.5 s |
| Match | `manual` {cap 20 s} | The lock tracker (score) or the button; the cap |
| Sing interval | `notes` {2, 1.2 s, cap 8 s} | Two notes heard, then 1.2 s without singing |
| Sequence of n | `notes` {n, 1.2 s, cap min(30, 4 + 1.5n)} | n notes heard, then 1.2 s without singing |
| Hiss | `sustain` {0.8 s, cap 90 s} | Sound started, then 0.8 s below the silence line |
| Long tone | `sustain` {0.8 s, cap 60 s} | The same |

**Silence line.** A reading is silent when it is below max(-55 dBFS, room floor + 6 dB).

- The room floor is the median level of the first 0.5 s.
- If that median is louder than -45 dBFS, the singer started at once, so a quiet room (-60) is assumed.
- After that, the floor drops whenever a quieter 300 ms window turns up.
- "Singing" means a voiced reading above the silence line.
- For `sustain`, any level above the line counts as sound, because a hiss is unvoiced.

**Live note count.** It follows the SPEC:

- A note counts after 150 ms within 50 cents of its centre, judged on the pitch averaged over 150 ms (about one
  vibrato cycle; ±40 cents of vibrato leaves about ±8).
- A new note starts after a gap of 80 ms or more between voiced readings.
- A new note also starts after a move of more than 70 cents held for 120 ms.

The count is deliberately cautious. If it counts too few, the cap or the singer's key ends the take. If it counted
too many, a line could be cut off during a breath.

### Where this differs from the SPEC, and why

1. **Moves are detected on the raw pitch.** A move is a reading more than 70 cents from the note centre for 120 ms.
   The new note is centred on the median of those raw readings, and the smoothing restarts there. With the smoothed
   pitch alone, the 150 ms average blurred each new note with the last one. On the synthetic "7 6 5 4 3 2", one note
   was missed and each count came 0.45 s late. Now each note is counted 0.15-0.4 s after it starts, and all six are
   counted.
2. **One extra rule for lines of four or more notes.** Once all but one note has been heard, 2.4 s of silence (twice
   1.2 s) also ends the take, in case the singer skipped a note or two notes ran together. Intervals do not use this
   rule, because a pause to think between the two notes is normal.
3. **The held-note rule bridges dropouts.** Voiced readings up to 0.15 s apart count as one note (breathy dropouts of
   about 0.12 s).
4. **The live smoother takes the median of five readings, not three.** The synthetic voice produced two-frame octave
   flicks, which a median of three let through.
5. **`promptThenCapture` and the rule helpers are additions.** `promptThenCapture`, `AUTO_STOP_RULES`, the
   `recorderFactory` test seam and the `stalled` flag on the playback handle all keep to the agreed signatures.

## Tests (52, `npx vitest run src/skills/audio`)

- **`autoStop.test.ts` (24)** feeds reading streams every 30 ms. It covers:
  - held notes with ±40-cent vibrato, a 150-cent scoop and a breathy dropout;
  - moving and sliding pitch, and silence;
  - lines of six detached, legato (80 ms glides) and fast (0.35 s) notes;
  - a breath pause mid-line, a missing note, and a 2.5 s pause inside an interval;
  - room noise;
  - a hiss in a quiet room, in a noisy room (-46 dBFS) and starting at once;
  - a long tone, the manual cap, the floor tracker, and the SPEC rule values.
- **`capture.test.ts` (12)** runs on the synthetic singer from `src/testing/synth.ts` (48 kHz, ±40 cents of vibrato,
  0.5 % jitter, breath 0.1) through a fake recorder and analyser. `detectPitch` is the real one. It covers:
  - `readLive` at A4 440 and 442;
  - the smoother;
  - the pitch test stopping by itself at 2.0-2.4 s;
  - "7 6 5 4 3 2" sung an octave low: six notes, stopped 1.2 s after the last one;
  - a legato "2 7- 6- 5-";
  - a hiss stopped 0.8 s after it ends;
  - key stop, cap, cancel, interruptions, a denied microphone and a throwing callback.
- **`prompts.test.ts` (16)** uses a fake AudioContext. It covers:
  - cadence, line, interval and harmonic schedules, with exact times and frequencies;
  - `onEvent` order, `done`, `stop`, `stopAllPrompts`, the stalled clock, no Web Audio, volume and the drone;
  - the iPhone session hand-back;
  - the cadence voice leading;
  - `promptThenCapture`: the microphone opens only at least 0.35 s after the prompt has rung out, and an abort
    before or after the microphone opens.

**Not verified here.** Nothing was tested in a real browser:

- Safari or Chrome on a Mac, or an iPhone;
- real microphones and room noise;
- the speaker-to-microphone ring-out (0.35 s is the SPEC's number);
- whether an iPhone resumes the prompt context outside a tap after a take. The `stalled` path covers it if not.
