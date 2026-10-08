# The attempt scorer (`trainer/score/*`) and how comparePhrase uses it

One score per attempt. `score.ts` `scoreAttempt(ref, attempt, opts)` is the authority for the overall number, the four sub-scores
(pitch 40 / timing 25 / tone 20 / expression 15, re-normalised over what could be measured), the gates, the trust level and the ranked
fixes. `trainer/compare.ts` `comparePhrase` runs the alignment once, hands it to `scoreAttempt`, and builds the screen's per-note table,
sync model and plain-words tone findings **from the scorer's own readings**. `trainer/feedback.ts` words the scorer's ranked fixes.

## Rules that keep the table, the words and the score consistent

- **A flag is a charge.** `wrong-note`, `octave-displaced` and `missed` are always shown (a wrong note has lost its pitch credit).
  `flat`, `sharp`, `late`, `early`, `short`, `long` stay on a note only if the note belongs to a ranked fix of that skill. The figures
  stay in the table either way. A take scoring 99-100 therefore has no flagged note.
- **What is a wrong note.** A non-ornament note 150 cents or more off. Run notes and notes under 0.2 s ("judged loosely") are flat or
  sharp, never wrong; an octave-displaced note (the name is right) is information (`pitch.octave`), also what a tracker slip looks like.
  `compare.ts` `wrongNoteCount` is the one definition the result sentence, the stored attempt and mastery use. The wording of a wrong
  note comes from the measured error ("about 2 semitones above it"), names the sung note only when it agrees with that error, and
  never prints a placeholder.
- **Which fixes are shown.** A fix is listed from 0.7 points but shown only from `FIX_SHOWN_POINTS` (1.5), or when it is the one thing
  to say about a take under `FIX_ONLY_BELOW` (95). Identical performances through phone-like channels moved the top fix by about a point
  and reordered it in 56 % of takes; at 1.5 that was about a fifth. Nothing stood out is a fine answer for a 98.
- **The sentence beside the score** (`notes[0]` when there are fixes) is a verdict from the notes ("3 of 11 notes were more than 25 cents
  from the original", or closest / furthest skill), never the first card's own words and never the key, offset or lag line (those follow
  the fix texts; the screen prints them beside the dial).
- **The table never has a second opinion.** Cents, entrance (ms) and length (ms) in `NoteCompare` are `NoteScore.cents`, `onsetMs`
  and `durRatio` (turned into ms at the fitted tempo). `comparePhrase` adds only what the scorer does not report: `merged` notes (one
  sung note over two reference notes: their entrance and length are dropped), registers, vibrato starts, note names in the singer's key.
- **Slow practice** (`guideRate`, default `rate`, 0.5-1): a take that follows a guide played at 0.5x runs twice as long. The reference
  is laid out at the played speed (`stretch.ts`: frames repeated, every time multiplied by 1 / rate) before the alignment, which then
  runs at tempo 1: the expected path is the diagonal, the gate's warp measure does not grow with 1 / rate, and tempo is judged against
  what was played (`tempoRatio` 1 = the speed of the guide). Reported note windows stay in the reference's own time; `diagnostics.tempoRaw`
  is attempt time per original reference time (what `compare.ts` uses). Before: perfect takes at 50 % / 60 % of a 12 s phrase were
  no-match; after: 93-97 on real clips, 99-100 on synthetic ones, also 10 % and 20 % off the chip.
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
- **Doubtful notes** (full-song references that carry the extractor's `leadExtraction.noteTrust`, MIX): a reference note with a trust under
  `DOUBTFUL_NOTE_TRUST` (0.4) is as likely a bass or guitar note as a sung one. A take that does not sing it is not charged a missed note
  (not in the coverage figure, not in the "missed:" list), and a far-off answer to it is not a wrong note; only when the take spans at least
  60 % of the original (the extractor's doubt is no excuse for stopping). `leadExtraction.roughGuide` (too little of the line is the lead
  voice, `purity`) makes the reference a rough guide even when the clip confidence is high (a moving bass line keeps it at 0.9).
- **Rough guide** (`diagnostics.roughGuide`). The melody extracted from a full song can contain the band, so the reference has more
  notes than were sung and the score would blame the singer for them (a near-exact copy scored 20-75 at -6 dB). A mix reference is a
  rough guide when it has at least `ROUGH_NOTE_RATIO` (1.4) times the notes of the take while the take spans at least `ROUGH_SPAN_SHARE`
  (0.6) of it, or when its extractor confidence is under `ROUGH_CONFIDENCE` (0.8); a solo-read reference needs the `noisy` issue too (a
  vocal-forward song read as solo; a singer who simplifies a run also sings fewer notes). In a rough guide: completeness is not applied,
  a note the take answers with a far-off pitch is treated as not sung (not as a wrong note), only whole-take fixes remain (`timing.tempo`,
  `pitch.drift`, `pitch.height`), there is no `coverage` fix, trust is `caution` with the plain reason, a solo-read one loses its tone
  score like a mix, and a gated take says why (`noMatchWhy = 'rough-reference'`). Nothing is forgiven to a take that spans under 60 % of
  the original: a half-sung take is still told to finish, whatever the reference is. `coverage` stays the honest raw figure, so such a take (most of the reference not matched) is not a
  full-phrase attempt for mastery; a low-confidence reference sets `diagnostics.refLowConfidence`, which the practice verdict (`judgeTake`) must
  read as not countable. Measured on the synthetic song (band at 0 / -3 / -6 dB, near-exact copy): 94-97 / 85-94 / 73-92 (was 82-95 / 66-92 /
  20-75), half-sung takes 21-56 (unchanged), two injected wrong notes 79-94: the cost of this mode is that a wrong note against a band is
  not provable, which is why the label and the mastery rule exist.
- **Speech-like phrases:** weights 15 / 45 / 25 / 15, pitch is the intonation shape, rows carry no cents and no flags.
- **Tracker range.** Notes that would sit outside 65 Hz .. 1400 Hz in the singer's key (`untrackableNotes`) are left out of the
  coverage (neither credited nor "missed"), the take gets a caution and a line saying why and what to do; a take that cannot be scored of
  a low reference gets the same hint. The table says "out of range", not "missed".
- **Gates:** `low-evidence` (reference under 2 notes / 1 s, take under 1 s), `no-match` (coverage under 0.25, sameness under 0.4, not
  rigid with the time model, implausible tempo, **key shift beyond 24 semitones**). A gated take has no fixes and no per-note claims.
  `diagnostics.noMatchWhy` says why when the scorer can tell, and `notes[0]` is then the explanation: `pitch-far` (the entrances agree with
  the time model but the notes are about a semitone or more off: "the rhythm matched, but many notes were far"), `locked-key` (singing
  along, in a key that is not an octave of the guide's: which key you sang and what to do), `rough-reference`. Without one the notice is
  the generic one. The screen should show `notes[0]` for these instead of the microphone advice.
- **Speaker bleed:** sing-along only; median entrance error under 12 ms and median pitch error under 5 cents on an octave-equivalent key
  is `trust: invalid` and `diagnostics.bleedSuspect`. The engine discards such a take.
- **Per-user tone bias:** `estimateToneBias` / `toneBiasFromAttempts` (median offset after at least 6 attempts, capped at +-0.15,
  never rasp); `comparePhrase(..., { toneBias })`; `toneBiasToCalibration` / `toneBiasFromCalibration` for `LibraryExport.calibration`.
- **Where pitch is read.** The warp (DTW) is free to slide along a note that moves, which hid injected errors: +-50 cents on the long notes
  of a real clip read as 19 cents (note 9: injected 50, read 2). After the time model is fitted, the flat middle of each sustained
  reference note whose mapped window agrees with the model (start within 90 ms, end within 150 ms) is read again at the model time, and
  the larger of the two errors stands (`align.ts` step 5; never the smaller). Same clips now read 42-47 of 50 (long_voice 19 -> 42,
  vocadito10 42 -> 47); an identical copy still reads under 10 cents on every note.
- **Entrances that cannot be read.** An onset pair is timing evidence only if the take has a sound of its own there (`found`: a voiced
  run start, or the pitch step in the right direction, near the model time) and the note and its predecessor are not far off in pitch
  (a missing or reversed step kept a stale warp corner and invented "starts early by 580 ms"). Sweeps with random per-note pitch error:
  a timing fix in 3 of 8 takes at sd 80 before, 0 of 8 after.
- **Key of a poor take.** A key found by the aligner that is not an octave multiple but within two semitones of one is reported only
  when the take is also tidy in it (70 % of aligned frames within 25 cents of one offset); otherwise the nearest octave multiple is
  used and the constant detune absorbs the rest. Simulated poor singers in the original key: told "1 semitone lower" in 7 of 12, now 0
  of 12; a tidy take one semitone up is still a transposition.
- **Tone words.** One size scale (`toneSize`: a little / clearly / much) for the fix card and the tone panel. Rasp is named before
  breathiness when the rasp index differs past its dead zone (a rough voice also reads as airier); "let more air in" is never given when
  the rasp index differs or the reference has any (above 0.1); the evidence says it is an estimate and prints no index numbers. When the
  rasp fix is given, the breathiness finding becomes an info line that does not say "airier" (a raspy take is not also told it is airier).
- **Quiet takes.** A take below the quiet-take level (`diagnostics.quietTake`: the recording is flagged too quiet, or the median voiced level is
  under `QUIET_VOICED_DB`) gets no `coverage` fix ("Sing the whole phrase"): the notes may have been sung softly, not skipped. The trust line
  already says the recording is very quiet, and the practice notice says to hold the phone about a hand-span away, never to sing louder.
- **Tracker slips.** `prepare` folds an octave slip shorter than 0.4 s back to its neighbours' octave (and drops other big jumps) before
  anything is measured: a 150 ms octave error in a perfect copy used to read as a note that came in 160 ms late.

## Files

`align.ts` contour DTW, key shift, rigid time model, second pitch reading. `stretch.ts` the reference laid out at the guide's speed. `pitch.ts`, `timing.ts`, `tone.ts`, `expression.ts` one skill each (formulas in
the headers). `score.ts` combination, gates, trust, fixes, flags. `constants.ts` every number. `contour.ts` / `transitions.ts` /
`util.ts` / `ctx.ts` helpers. `testkit.ts` test-only synthesiser, error injectors and PSOLA; `realVoice.ts` optional real clips.

## Tests

`score.test.ts` (acceptance), `injectedErrors.test.ts` (one error, one sub-score; `MIMIC_PRINT_TABLE=1` prints the table),
`scoreContract.test.ts` (flags, mixes, range, bleed, tone bias, fuzz), `contour.test.ts`, `slowPractice.test.ts` (perfect copies at 0.5-0.9
speed), `fairness.test.ts` (ornaments, phantom timing, key of poor takes, no-match reasons, tone, copy), `roughGuide.test.ts` (full-song
references, on `testing/songMix.ts`), `scoreReal.test.ts` and `scoreRealFair.test.ts` (real clips through PSOLA, skipped when the files are
not at `MIMIC_REAL_VOICE_DIR`; the clips are never copied into the repository).

## Honest limits

Calibrated on synthetic voices and four short real clips, no human ratings: a score is closeness to the original, not quality. Tone
is the weakest skill (a vowel or lyric change moves brightness 0.3-0.5). Poor singers make the key ambiguous by one semitone (the
constant detune absorbs it). Partial speaker bleed is not detected. Short phrases are noisy. Real iPhone microphones are untested.
