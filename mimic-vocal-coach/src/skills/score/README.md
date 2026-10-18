# Skills scoring engine

These are pure scorers that take a mono take (`Float32Array` plus a sample rate). They use `trackPitch` at 10 ms. The
contracts are in `../SPEC.md` section 3 and every threshold is in `constants.ts`. No scorer returns a made-up number:
a take with too little sound comes back as `too-quiet`, and a take with sound but no sung note comes back as
`no-pitch`. Either way the numbers are `null` and the result carries a plain finding that says why.

| File | What it does |
|---|---|
| `frames.ts` | `analyseTake`, which builds the MIDI pitch track at the singer's A4. Also: take status, octave folding, smoothing, voiced stretches, and `heldPitch`, which fits the vibrato centre. |
| `segment.ts` | `buildNote` (one `SungNote` from a range of frames) and `segmentNotes`. |
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

The numbers below come from one run on 2026-10-18 and are reproducible, because the synthesiser is seeded.
`npx vitest run src/skills/score` runs 43 tests in 3 files, and each file takes about 9 to 11 s.

### Held notes (pitch test / match)

| Case | Measured | Requirement |
|---|---|---|
| In tune: A2 E3 A3 E4 (baritone range), C4 C5 (soprano range) | −1.1, −0.3, −0.2, +0.5, −0.3, +0.3 | \|error\| < 5 |
| Detuned +30 / −30 cents | +30.1 / −30.6 | 30 ± 5 |
| Vibrato 4.5 / 6 / 7 Hz at ±50 cents, held (stability) | −0.8 (2.5) / −0.8 (6.7) / −0.9 (7.6) | bias < 5 |
| Flat landing (glide in, sit at −60 for 250 ms, then correct): landing / held / time to land | −60.9 / −3.0 / 0.50 s | landing < −50, held within 5 |
| 150-cent linear scoop over 120 ms: landing / held / time to land | +1.0 / −0.2 / 0.12 s | held within 5 (see deviation 1) |
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
| 300 ms notes | 12 −1 1 1 −2 2 |
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

## Where this differs from SPEC.md, and why

1. **Landing.** The spec defines landing as "the mean of the first 200 ms after the smoothed slope first drops under
   3 st/s", and I implemented exactly that. That definition places a quick linear scoop *before* the landing.
   - So a 150-cent scoop over 120 ms lands at about 0, and the scoop shows in `timeToLandSec` (0.12 s) instead.
   - The test plan's "scoop → landing < −50" therefore does not hold, so the test checks a flat landing instead (−60.9).
   - A flat landing that is later corrected is the case the "you arrive under the note" finding is for.
   - For held notes, landing is measured from the voice onset over the whole voiced stretch, so the glide-in counts.
2. **Held pitch.** The spec's held pitch is "the median over the steady part". It is now a least-squares fit:
   - The fit is pitch = c + d·t + a·sin(ωt) + b·cos(ωt), with ω searched from 3.5 to 8.5 Hz.
   - It falls back to the median when there is no clear vibrato (amplitude under 8 cents, or the fit explains under 30 % of the variance).
   - The median of 1.5 vibrato cycles on a 0.5 s note was 10 to 15 cents off. The fit is within 4.
   - This is the "mean over whole vibrato cycles" the brief asked for.
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

## Not verified

- No real voices or real microphones have been tested; everything here is synthetic. Real rooms with reverb, a Mac
  fan or speech in the background, and real "sss" sounds may need the hiss thresholds tuned: HF share ≥ 35 % above
  2 kHz, at least 8 dB over the floor, and periodicity < 0.5.
- Very fast lines (notes under about 250 ms with vibrato) were not calibrated. The 300 ms test still had one note 12
  cents off.
- Heavy period-doubling (rasp) on high notes reads an octave low in `trackPitch`. Pitch-class folding hides this in
  the cents, but a whole-take octave offset may then show.
- Scoring a 28.5 s line at 48 kHz took 0.85 s in Node, so screens should show a short "Scoring…" state.
