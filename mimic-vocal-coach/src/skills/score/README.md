# Skills scoring engine

These are pure scorers that take a mono take (`Float32Array` plus a sample rate). They use `trackPitch` at 10 ms. The
contracts are in `../SPEC.md` section 3 and every threshold is in `constants.ts`. No scorer returns a made-up number:
a take with too little sound comes back as `too-quiet`, and a take with sound but no sung note comes back as
`no-pitch`. Either way the numbers are `null` and the result carries a plain finding that says why: too quiet, no
steady note, a note too short to measure, or a pure electronic tone rather than a voice. A note that was sung but
cannot be measured reliably keeps its number and is marked `confidence: 'low'`; it is then kept out of every average,
drift and progress figure, and `within` is never claimed on it. It is not hidden, though (fix round 3, N1): in a line a
rough note that is a different note even after allowing for its margin (its own 10-90 % pitch range, at least 30
cents) is still
named and counted as not in tune, and one that reads off by more than the tolerance and beyond its margin is named as
a rough reading. A line gets "Well pitched" only with at least 80 % of its notes measured with confidence, and no
accuracy figure at all (null, "not scored") with fewer than half.

| File | What it does |
|---|---|
| `frames.ts` | `analyseTake`, which builds the MIDI pitch track at the singer's A4. Also: take status, octave folding, smoothing, voiced stretches, `heldPitch`/`heldPitchFit` (vibrato centre), `jointVibratoRate` (one rate for a whole take), `vibratoStep` (a pitch step with the vibrato fitted across it), `voiceCheck`/`isPureTone`, and the "too short" reason. |
| `segment.ts` | `buildNote` (one `SungNote` from a range of frames, with its confidence) and `segmentNotes` (two passes: candidate notes, then the take's vibrato rate, real steps only, scoops folded in). |
| `align.ts` | `alignNotes`, a DP that tolerates missing and extra notes, plus the choice of a whole-take octave offset. |
| `held.ts` | `scoreHeldNote`, `summarisePitchTest` and `createLockTracker` (live lock-in for "Match the note"). |
| `line.ts` | `scoreSequence` and `scoreSungInterval`. |
| `breath.ts` | `scoreHiss` and `scoreLongTone`. |
| `format.ts` | `formatCents`, `centsMeaning` and `sharpFlat`. |
| `fixtures.ts` | Test-only synthetic takes: the calibration singer, room noise, hiss and speech-like babble. |

## Calibration (synthetic singer, real numbers)

**Test conditions:**
- The singer is `synthMelody`/`synthVoice` with:
  - vibrato at 5.5 Hz, ±40 cents, starting after 0.15 s;
  - 0.5 % jitter;
  - breath noise at 0.1;
  - the vowel /a/.
- Every take has 0.4 s of room noise (about −62 dBFS) before and after it, and the same noise underneath it.
- The sample rate is 22.05 kHz unless a row says otherwise.
- Strictness is Standard (25 cents).
- Cents are measured sung minus asked.

The numbers below come from one run on 2026-10-18 (accuracy fixes re-measured on 2026-10-19) and are reproducible,
because the synthesiser is seeded. `npx vitest run src/skills/score` runs 72 tests in 4 files, about 9 to 20 s each.

### Held notes (pitch test / match)

| Case | Measured | Requirement |
|---|---|---|
| In tune: A2 E3 A3 E4 (baritone range), C4 C5 (soprano range) | −1.1, −0.3, −0.2, +0.5, −0.3, +0.3 | \|error\| < 5 |
| Detuned +30 / −30 cents | +30.1 / −30.6 | 30 ± 5 |
| Vibrato 4.5 / 6 / 7 Hz at ±50 cents, held (stability) | −0.8 (2.5) / −0.8 (6.7) / −0.9 (7.6) | bias < 5 |
| Flat landing (glide in, sit at −60 for 250 ms, then correct): landing / held / time to land | −76.2 / −3.0 / 0.53 s (was −60.9) | landing < −50, held within 5 |
| 150-cent linear scoop over 120 ms: landing / held / time to land | −33.5 / −0.2 / 0.1 s (landing was +1.0) | landing −60 to −30, held within 5 (see deviation 1) |
| Octave below / above: offset, held | −1, −1.1 / +1, −0.1 | flagged, judged on pitch class |
| Breathy (breath noise 0.6) / bass F2 / 48 kHz detuned +12 | −0.5 / −1.4 / +11.4 | |
| Amplitude 0.002 / silence / room noise / loud hiss / babble | too-quiet / too-quiet / too-quiet / no-pitch / no-pitch | not scored |

### "7 6 5 4 3 2" in E♭ major (tenor range, 0.5 s notes)

Each row lists the per-note error in cents, followed by:
- **acc**: the share of notes within 25 cents;
- **miss**: missing notes;
- **extra**: extra notes;
- **oct**: the whole-take octave offset;
- **drift**: the drift over the line, in cents;
- the time taken to score the take.

| Case | Measured |
|---|---|
| In tune | −1 −1 0 3 1 0; acc 100 %; miss 0; extra 0; oct 0; drift 1.9; 20 ms |
| 7 sung −40 | **−41** −1 0 4 1 0; acc 83 %; drift 5.5 (no drift finding) |
| 5 left out | −1 0 – 1 2 1; miss 1 (at index 2); extra 0 |
| Extra 150 ms note after the 5 | −1 −1 1 0 −1 −1; extra 1; miss 0 |
| 80 ms legato glides | −1 −1 0 3 0 0; extra 0 (glides are not notes) |
| Whole line an octave down | 0 −4 1 −2 1 1; oct −1; acc 100 % |
| Only the 4 an octave down | −1 −1 1 3 0 0; oct 0; the 4 is flagged `octaveSlip` |
| Linear slide 0 → −40 | −1 −9 −16 −21 −31 −40; drift −38.8 (requirement −40 ± 8) |
| Detached, 200 ms gaps | 0 0 2 1 2 2 |
| 300 ms notes | 12.2 −2.7 0.5 1.3 0.9 0.4 (review harness, 2026-10-19); 4 of 6 marked low confidence (shown, not counted), drift not computed |
| 48 kHz | −1 0 1 3 1 0; 38 ms |
| 15-note line, 28.5 s at 48 kHz | acc 100 %; **854 ms** to score |

### Sung intervals

| Case | Measured | Requirement |
|---|---|---|
| Major 6th up, sung 30 wide from a start 20 cents sharp: reference / interval / target | +17.7 / +32.0 / +49.7 | 20 ± 5 / 30 ± 5 |
| Perfect 4th down, sung an octave low: offset / interval | −1 / −0.9 | |
| Minor 3rd down instead of major 6th up (same note name) | `wrongDirection`, not within | flagged |

### Breath

| Case | Measured | Requirement |
|---|---|---|
| Hiss, 10 s after 0.6 s of room noise | 10.00 s, SD 0.1 dB, floor −62.0 dB | 10 ± 0.5 s |
| Hiss, 3 s (also at 48 kHz) | 3.00 s / 3.00 s | 3 ± 0.2 s |
| Hiss that starts the instant capture opens, 8 s | 8 ± 0.3 s (test) | |
| 2 s + a 0.2 s catch + 2 s | 4.20 s, SD 1.4 dB (the catch is bridged and not counted as unevenness) | |
| Hiss with a ±6 dB, 0.7 Hz wobble | SD 4.2 dB, "a bit uneven" | |
| 60 s hiss at 48 kHz | 60.00 s, 779 ms to score | |
| Sung vowel / room noise only / babble | voiced / too-quiet / voiced | not scored |
| Long tone, 8 s with vibrato: duration / pitch SD / loudness SD | 8.00 s / 3.8 cents / 0.1 dB | |
| Long tone with a 1 Hz ±40 cent wander | pitch SD 27.0 cents ("a little wobbly") | |

## Accuracy fixes, 2026-10-19: before and after

"Before" is the scorer as it stood at the start of this round (frozen copy), "after" is this code; same synthetic takes.

### Wide vibrato in lines (M3)

Grid: "7 6 5 4 3 2" and "1 2 3 4 5 6 7 8", vibrato 4.5 / 5 / 5.5 / 6 / 7 Hz, legato and detached (0.15 s gaps), 20
takes per row, everything in tune. "Confident" excludes notes marked low confidence (before, nothing was marked).

| Notes, vibrato | Before: max \|err\| (mean), extra, missing, false drift findings | After: max \|err\| (mean) on confident notes, low-confidence notes (their max \|err\|), extra, missing, false drift |
|---|---|---|
| 0.3 s, ±50 | 30.5 (6.4), 0, 0, 0 | 7.0 (2.4); 108 of 140 low (26); 0, 0, 0 |
| 0.45 s, ±50 | 4.7 (1.0), 0, 0, 0 | 3.3 (1.0); 0 low; 0, 0, 0 |
| 0.6 s, ±50 | 2.9 (1.0), 0, 0, 0 | 2.9 (1.0); 0 low; 0, 0, 0 |
| 0.8 s, ±50 | 2.9 (1.0), 0, 0, 0 | 2.9 (1.0); 0 low; 0, 0, 0 |
| 0.3 s, ±100 | **80.2** (25.6), 0, 3, 3 | 6.6 (3.1); 126 of 140 low (80); 0, 0, 0 |
| 0.45 s, ±100 | **42.8** (11.5), 2, 0, 3 | **5.3** (1.5); 4 low (1); 0, 0, 0 |
| 0.6 s, ±100 | **35.7** (2.8), 0, 0, 0 | **3.9** (1.4); 0 low; 0, 0, 0 |
| 0.8 s, ±100 | 3.8 (1.3), 1, 0, 0 | 3.6 (1.3); 0 low; 0, 0, 0 |

Review harness rows ("7 6 5 4 3 2", 0.5 s notes, vibrato starting at 0.1 s), per-note error in cents:

| Case | Before | After |
|---|---|---|
| 4 Hz ±80 | **32.1** −0.5 0.4 3.2 0.3 1.9 | −2.3 −0.5 0.4 3.2 0.3 1.9 |
| 4 Hz ±100 | 3 −0.8 0.7 3.3 0.3 **−37.4**, 1 extra note | −2.5 −0.8 0.7 3.3 0.3 1.4, no extra |
| 5 Hz ±80 / ±100 | **33.2** … / **33.8** … 7.1 … | −1.8 … 3.9 … / −2.4 … 4.1 … |
| 6 Hz ±100 | −2.7 **−33.6** 2 5.5 0.3 **40.7**, drift +43.4 with a "slid sharp" finding | −2.7 −1 2 5.5 0.3 2, drift 4.8, no finding |
| 7 Hz ±100 | −2.8 −1.3 3.1 **−37.2 −29.1** 2.7 | −2.8 −1.3 3.1 5.2 0.9 2.7 |
| Segmentation, 4 Hz ±100, 0.8 s notes | 7 notes (a vibrato swing split off) | 6 notes |

Causes: the fit's guard fell back to the median whenever the vibrato centre sat more than 30 cents from the median of
a partial cycle (with ±100 cents it always can), the rate was searched per note in two or three cycles, and the slope
term traded off against the vibrato phase. Fixes: one vibrato rate for the whole take (`jointVibratoRate`), a
3-parameter centre fit on notes under two cycles, a guard of 30 cents plus the vibrato extent, pitch boundaries kept
only when the step survives a joint vibrato fit (`vibratoStep`), and a confidence on every note (steady part ≥ 200 ms,
≥ one vibrato cycle, and centres fitted on the first and last 70 % agreeing within 10 cents).

### First note of a line (e2e-F3)

Not reproduced on the current scorer. A 40-cent-flat 7 at 0.6 s in four keys, in the octave asked and an octave low,
reads (error against the truth, cents): before −2.1 0.5 −2.5 0.2 −1 −1.8 −1.8 0.5, after −2.1 0.5 −2.5 0.2 −1 −1.8 −1.8
1.1. The UI path (`RealScoring.test.tsx` setup, tonic 48, an octave low) reads −39.5 for the 7. With the synthesiser's
vibrato switched off, the first note reads −0.2 (with vibrato +0.2), so there is no onset scoop or smoothing edge
effect left. The "−35" was most likely measured before the vibrato-centre fit landed. A test now pins it to −40 ± 3.

### Notes too short to measure (L4)

| Case | Before | After |
|---|---|---|
| Held note 0.25 s | `no-pitch`, "I heard sound but no steady sung note" | `no-pitch`, "I heard a note, but only for about 0.3 seconds: too short to measure" |
| Held note 0.4 s, in tune | 5.2 cents sharp, scored as a normal note | 1.1, marked low confidence, "this reading is rough", left out of the pitch-test summary |
| Held note 0.6 s | −1.8, normal | −1.8, confident again (fix round 3: the held threshold is 0.26 s of steady pitch, so notes from 0.45 s are trusted; 0.45 / 0.5 / 0.6 s notes read within 3.5 / 1.9 / 1.8 cents at A2, A3, E4) |
| Held note 0.35 s sung +30 | — | +24.5, low, `within` false (was true) |
| Pitch test of 10 rough notes | — | "All 10 notes were too short or too unsteady to measure reliably" (was "Check the microphone") |
| 2 s soft falsetto G5 marked low | — | "hard to pin down (very soft or unsteady)" (was "That note was short (about 2.0 seconds)") |
| Lines with 0.3 s notes | numbers up to 80 cents off counted (see M3) | those notes marked low, a finding says how many, accuracy/drift use the rest |

### Scoops (M7)

Held-note landing (mean of the first 200 ms from the voice onset; was "200 ms after the slope drops under 3 st/s"):

| Scoop | Before | After |
|---|---|---|
| −100 over 0.1 / 0.2 / 0.35 s | −2.7 / −45.5 / −65.3 | −14.6 / −40.0 / −61.8 |
| −200 over 0.1 / 0.2 / 0.35 s | +2.0 / −5.6 / −138.5 | −37.2 / −88.0 / −132.5 |
| −300 over 0.1 / 0.2 / 0.35 s | +2.5 / −6.1 / −1.8 | −59.1 / −135.5 / −201.9 |
| "Arrived under the note" finding fires | 3 of 9 | 8 of 9 (not on −100 over 0.1 s) |

The held pitch is unchanged (within ±0.2 everywhere). In-tune notes with a vibrato starting 150 ms late read +3 to
+21 (4-7 Hz, ±100), below the finding's 30.

Lines "1 3 5 3 1", 0.6 s notes, a scoop into every note: before, −200 over 0.25 s gave 2 extra notes and −300 over
0.25 s gave 1; after, 0 extra and 0 missing on all of −100 to −300 over 0.08 to 0.25 s, every note within 8 cents. A short
straight ramp heading into the next note now belongs to that note. Some notes shortened by a slow scoop are marked low
confidence (for −200 over 0.25 s, 3 of 5).

### Sag at the end (L2)

`endDriftCents` = the last 0.5 s of the steady part (long tone: 0.6 s) against the steady part before it, vibrato
centres. A finding fires at 10 cents or more.

| Case | Before | After |
|---|---|---|
| Held 2.4 s, linear sag to −30 over the last second | −5.3, "In tune: 5 cents flat", nothing about the sag | −5.3; end drift −13.6, "Towards the end the pitch sagged about 14 cents flat" |
| Held 2.4 s, steady | 0.1 | 0.1; end drift +3.2, no finding |
| Long tone 8 s, sag to −30 over the last second | SD 5.9, "pitch very steady", nothing else | SD 5.9; end drift −15.6; "very steady until the last second" (a `work` finding) plus "Over the last second the pitch sagged about 16 cents flat" |
| Long tone 8 s, steady | SD 3.8 | SD 3.8; end drift +0.6, no finding |

### Voice check (L5)

A note is refused as a pure tone when, on up to 12 frames, the harmonics 2 to 10 above the inter-harmonic noise sum
to under −30 dB of the fundamental, at most one harmonic stands 13 dB above that noise, AND the pitch roughness (SD of
the second difference of the pitch track) is under 2.5 cents.

| Input | Harmonics (dB) / roughness (cents) | Before | After |
|---|---|---|---|
| Sine at the target, A2 / A3 / A4 / E5, peak 0.3 | −63 / 1.5, −72 / 0.4, −75 / 0.3, −79 / 0.1 | in tune, 0 cents | `no-pitch`, "a pure electronic tone" |
| Sine A3 peak 0.05; sine + white noise at −50 dBFS | −52 / 2.0; −49 / 1.6 | in tune | refused |
| Sine long tone 6 s; line of sines "5 4 3 2 1" | | SD 0 / accuracy 100 % | `no-pitch` / `no-pitch` |
| Voice, breath noise 0 / 0.3 / 1 (A2 to G5) | −38 to +4 / 4.3 to 24.5 | ok | ok, unchanged |
| Falsetto-like (tilt −20 dB/oct, H1 +8 dB), vowels a u i o, breath 0 to 1, E4 to G5, peak 0.3 and 0.01 | −83 to −13 / 4.1 to 25.5 | ok | ok (the "u" at G5 has H2 at −83 dB, like a sine; its jitter of 4 cents is what passes it) |
| Soft voice, peak 0.02 and 0.01 | +0.5 / 7 to 9.5 | ok | ok |

## Where this differs from SPEC.md, and why

1. **Landing.** For held notes, landing is now the mean pitch of the first 200 ms from the voice onset (SPEC.md was
   updated). The earlier "first 200 ms after the smoothed slope drops under 3 st/s" put a quick scoop *before* the
   landing, so a 300-cent scoop over 0.35 s read −1.8 and the scoop finding never grew with the scoop.
   - A 150-cent scoop over 120 ms now reads −33.5 (the test plan's "landing < −50" needs a slower or deeper scoop).
   - A window of exactly one vibrato cycle was tried and dropped: when the vibrato starts 150 ms late, an in-tune note
     read +31 cents.
   - Line notes keep the slope-based landing (it is not shown or used for findings in lines).
2. **Held pitch.** The spec's held pitch is "the median over the steady part". It is now a least-squares fit:
   - The fit is pitch = c + d·t + a·sin(ωt) + b·cos(ωt), with ω searched from 3.5 to 8.5 Hz.
   - It falls back to the median when there is no clear vibrato (amplitude under 8 cents, or the fit explains under 30 % of the variance).
   - The median of 1.5 vibrato cycles on a 0.5 s note was 10 to 15 cents off. The fit is within 4.
   - This is the "mean over whole vibrato cycles" the brief asked for.
   - In a line, ω is the take's own vibrato rate (`jointVibratoRate`, all notes fitted together), and notes under two
     cycles drop the slope term d. The fit is accepted while its centre is within 30 cents plus the vibrato extent of
     the median (the old 30-cent guard rejected correct centres on ±100-cent vibrato: M3 above).
3. **Steady part on short notes.** The spec skips the first 250 ms and the last 150 ms. On short notes I skip at most
   25 % and 15 % of the note, because on a 0.4 s line note the fixed skips leave nothing.
4. **Drift.** Drift uses the Theil–Sen slope (the median of pairwise slopes) instead of least squares.
   - With least squares, a flat 7 at the start of "7 6 5 4 3 2" read as a +33 cent "drift sharp" and produced a wrong finding.
   - With Theil–Sen that line reads +5.5, and a genuine slide still reads −38.8.
5. **`no-pitch`.** The spec calls every take with less than 0.3 s of voicing `too-quiet`. Here a take with less than
   0.3 s of voicing is `no-pitch` when it is loud (90th-percentile level ≥ −45 dBFS), as noise or speech-like sound
   is. The finding then says "I heard sound but no steady sung note" instead of telling a loud singer to sing louder.
6. **Gaps between notes.**
   - Gaps under 60 ms are always bridged.
   - Gaps from 60 to 100 ms are bridged only when the level does not dip by 6 dB. This keeps a tracker dropout inside a vowel as one note, while a re-sung repeated note splits.
   - Longer gaps always split.
7. **Hiss.** The level steadiness uses hiss frames only, so a bridged catch in the airflow does not count as
   unevenness. The noise floor also considers the quietest 200 ms of the take, so a hiss that starts the moment capture
   opens is still measured. Speech-like input reads as `voiced`, because `HissScore.status` has no `no-pitch`.
8. **Interval octave errors.** The interval is folded to ±600 cents (pitch class), but whenever the unfolded error is
   over 600 cents it is never `within`, and a finding says so. An inverted interval (a minor 3rd down for a major 6th
   up) also sets `wrongDirection`.
9. **`createLockTracker`.** `centsNow` averages the voiced readings of the last 200 ms, so vibrato does not throw the
   needle out of the band. A dropout up to 150 ms keeps the hold going. `lockSec` is the time from the first voiced
   reading to the start of the hold that locked, so 0 means the singer found the note straight away.

### Rough notes in lines and intervals (fix round 3)

Line "7 6 5 4 3 2", 0.3 s notes, no vibrato, calibration singer otherwise:

| Case | Before | After |
|---|---|---|
| 3rd note sung −100 (reads −100.2, low) | "1 of 1 notes within 25 cents. Well pitched." | "Your 5 was clearly a different note (it read about 100 cents flat, but it was short, so that size is rough)."; accuracy null |
| 3rd note sung +100 (reads +98.3, low) | "1 of 1 … Well pitched." | named as a semitone sharp; accuracy null |
| 3rd note sung −40 (reads −40.0, low) | "2 of 2 … Well pitched." | "Your 5 sounded about 40 cents flat, but it was too short to measure reliably."; accuracy null |
| All in tune | "2 of 2 … Well pitched." | no praise, "4 notes … not counted, and the line is not scored" |
| 0.6 s notes, in tune | 6 of 6, Well pitched | unchanged |

Intervals: "m2 down in tune" (55 → 54, 0.9 s notes) read −1202.6 cents, "a major 7th up", because the pitch tracker read
0.37 s of the second note an octave up and that span was taken as the second note. Two spans that touch with no gap
and sit an exact octave apart (± 50 cents) inside the second note are now one note, kept in the octave nearer the
expected note: −3.1, "A clean minor 2nd". An interval with a rough note no longer also says "A clean …".

## Not verified

- No real voices or real microphones have been tested; everything here is synthetic. Real rooms with reverb, a Mac
  fan or speech in the background, and real "sss" sounds may need the hiss thresholds tuned: HF share ≥ 35 % above
  2 kHz, at least 8 dB over the floor, and periodicity < 0.5.
- Very fast lines (notes under about 350 ms with vibrato) mostly come out as low confidence: shown, not counted. On the
  0.3 s grid, 32 of 140 (±50) and 14 of 140 (±100) notes stayed confident, all within 7 cents.
- Notes squeezed by slow legato glides (0.2 s glides into 0.6 s notes, or slow scoops) can be marked low confidence
  even when their number is right, because less than 200 ms of steady pitch is left. This is deliberately cautious. A
  looser rule (120 ms, 0.6 cycle) let 0.3 s notes through as confident with errors up to 47 cents.
- The voice check can miss a quiet pure tone at low pitch: a sine at A2 peaking at 0.05 (−26 dBFS) in −62 dBFS room
  noise reads 3.7 cents of roughness from tracker noise and is scored. It catches loud sines and quiet ones from A3 up.
  Speaker distortion (2nd harmonic at −34 dB) is still refused. A prompt with harmonics (the piano or the organ drone)
  is not a pure tone, so this check does not catch it. Headphones are still the fix for that.
- The sag measure is the mean over the last 0.5 s (long tone 0.6 s), so a linear sag reaching −30 at the release
  reads about −14 to −16.
- Heavy period-doubling (rasp) on high notes reads an octave low in `trackPitch`. Pitch-class folding hides this in
  the cents, but a whole-take octave offset may then show.
- Scoring a 28.5 s line at 48 kHz took 0.85 s in Node, so screens should show a short "Scoring…" state.
