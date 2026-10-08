# The attempt scorer (`trainer/score/*`) and how comparePhrase uses it

One score per attempt. `score.ts` `scoreAttempt(ref, attempt, opts)` is the authority for the overall number, the four sub-scores
(pitch 40 / timing 25 / tone 20 / expression 15, re-normalised over what could be measured), the gates, the trust level and the ranked
fixes. `trainer/compare.ts` `comparePhrase` runs the alignment once, hands it to `scoreAttempt`, and builds the screen's per-note table,
sync model and plain-words tone findings **from the scorer's own readings**. `trainer/feedback.ts` words the scorer's ranked fixes.

## Rules that keep the table, the words and the score consistent

- **A flag is a charge.** `wrong-note`, `octave-displaced` and `missed` are always shown (a wrong note has lost its pitch credit).
  `flat`, `sharp`, `late`, `early`, `short`, `long` stay on a note only if the note belongs to a ranked fix of that skill (fixes are listed
  from 0.7 points up). The figures stay in the table either way. A take scoring 99-100 therefore has no flagged note.
- **The table never has a second opinion.** Cents, entrance (ms) and length (ms) in `NoteCompare` are `NoteScore.cents`, `onsetMs`
  and `durRatio` (turned into ms at the fitted tempo). `comparePhrase` adds only what the scorer does not report: `merged` notes (one
  sung note over two reference notes: their entrance and length are dropped), registers, vibrato starts, note names in the singer's key.
- **One time model.** The scorer fits `attemptT = lag + tempo * refT` (Theil-Sen). The screen's `syncOffsetMs` is `lag - refStart`
  (raw, latency not subtracted, so "play both" lines up), `tempoRatio` is the scorer's. `score.timing.lagMs` is the same minus the
  click-probe latency and is null when no entrance anchored the model.
- **Tone words use the tone score's dead zones.** A breathiness / brightness / rasp finding exists only past `TONE_DEAD + per-semitone
  allowance` after the key bias and the singer's own offsets are removed; vibrato, register and level findings exist only where the
  matching score component also found a difference. Only normalised indices are ever compared, never dB features. Grit is described, never
  asked for; softer is never "fixed" by pushing.
- **Short phrases** (fewer than 5 notes or under 4 s of singing; about twice as noisy): `diagnostics.shortPhrase`, a caution, and
  `scoresOf` rounds the shown overall to the nearest 5 (never up to 100 below 98). The exact number stays in `AttemptScore.overall`.
- **Mix-derived references** (`ref.mode === 'mix'` or the `accompaniment` issue): tone, dynamics and attack are not scored or worded;
  weights are re-normalised over pitch, timing and expression; trust is `caution`.
- **Speech-like phrases:** weights 15 / 45 / 25 / 15, pitch is the intonation shape, rows carry no cents and no flags.
- **Tracker range.** Notes that would sit outside 65 Hz .. 1400 Hz in the singer's key (`untrackableNotes`) are left out of the
  coverage (neither credited nor "missed"), the take gets a caution and a line saying why and what to do; a take that cannot be scored of
  a low reference gets the same hint. The table says "out of range", not "missed".
- **Gates:** `low-evidence` (reference under 2 notes / 1 s, take under 1 s), `no-match` (coverage under 0.25, sameness under 0.4, not
  rigid with the time model, implausible tempo, **key shift beyond 24 semitones**). A gated take has no fixes and no per-note claims.
- **Speaker bleed:** sing-along only; median entrance error under 12 ms and median pitch error under 5 cents on an octave-equivalent key
  is `trust: invalid` and `diagnostics.bleedSuspect`. The engine discards such a take.
- **Per-user tone bias:** `estimateToneBias` / `toneBiasFromAttempts` (median offset after at least 6 attempts, capped at +-0.15,
  never rasp); `comparePhrase(..., { toneBias })`; `toneBiasToCalibration` / `toneBiasFromCalibration` for `LibraryExport.calibration`.
- **Tracker slips.** `prepare` folds an octave slip shorter than 0.4 s back to its neighbours' octave (and drops other big jumps) before
  anything is measured: a 150 ms octave error in a perfect copy used to read as a note that came in 160 ms late.

## Files

`align.ts` contour DTW, key shift, rigid time model. `pitch.ts`, `timing.ts`, `tone.ts`, `expression.ts` one skill each (formulas in
the headers). `score.ts` combination, gates, trust, fixes, flags. `constants.ts` every number. `contour.ts` / `transitions.ts` /
`util.ts` / `ctx.ts` helpers. `testkit.ts` test-only synthesiser, error injectors and PSOLA; `realVoice.ts` optional real clips.

## Tests

`score.test.ts` (acceptance), `injectedErrors.test.ts` (one error, one sub-score; `MIMIC_PRINT_TABLE=1` prints the table),
`scoreContract.test.ts` (flags, mixes, range, bleed, tone bias, fuzz), `contour.test.ts`, `scoreReal.test.ts` (real clips through PSOLA,
skipped when the files are not at `MIMIC_REAL_VOICE_DIR`; the clips are never copied into the repository).

## Honest limits (unchanged from the design notes)

Calibrated on synthetic voices and four short real clips, no human ratings: a score is closeness to the original, not quality. Tone
is the weakest skill (a vowel or lyric change moves brightness 0.3-0.5). Poor singers make the key ambiguous by one semitone (the
constant detune absorbs it). Partial speaker bleed is not detected. Short phrases are noisy. Real iPhone microphones are untested.
