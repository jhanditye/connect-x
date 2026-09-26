# Mimic — vocal coach

Mimic listens to you sing and coaches you toward the sound of **Shawn Mendes**, **Daniel Caesar** or
**Jalen Ngonda**, with the focus on mixed voice: how you carry your voice through the passaggio, how
airy or bright your tone is, and how you use vibrato, falsetto and runs.

Record a take in the browser (or upload a voice memo). Mimic analyses it on your device, scores it
against the singer you picked, and gives you a prioritised plan with exercises you can play along
with. Your audio never leaves the device.

## What it measures

| Measure | What it tells you | How it's estimated |
|---|---|---|
| Pitch and range | Where you sang, your tessitura, how in tune held notes are | YIN pitch tracking at 10 ms steps, tuning-corrected note segmentation |
| Chest / mix / head above the passaggio | How much of your upper range is carried in chest, mix or head voice/falsetto | Acoustic proxies: H1–H2 (balance of the first two harmonics), breath noise (HNR, CPP) and loudness against pitch |
| Loudness climb | Whether you get louder as you go up (pushing chest weight) | Loudness vs pitch regression in the upper range |
| Breathiness | Clear vs airy tone | Cepstral peak prominence and harmonics-to-noise ratio |
| Brightness | Dark/warm vs bright/forward tone | Noise-compensated balance of upper vs lower harmonics |
| Rasp | Grit or roughness | Subharmonics (period doubling) and pitch/amplitude irregularity |
| Vibrato | How often, how fast, how wide | Sinusoid fit on the pitch contour of held notes |
| Runs | Fast melismatic passages | Short-note sequences inside phrases |
| Onsets | Breathy, balanced or hard starts to phrases | Aspiration before voicing and attack speed |
| Register flips | Sudden switches into falsetto | Register changes paired with a pitch jump |

Register labels are **estimates** from the sound, not a diagnosis. They are most reliable on open
vowels ("ah", "oh", "uh"), and the microphone and room shift them too. The Guide page in the app
explains each measure and its limits.

## The singer profiles

Each built-in profile is a set of hand-set targets (with tolerances and weights) based on listening
and published descriptions of the singer's voice, plus study songs, signature moves and range
estimates. They are estimates, not measurements of the artists' recordings.

For a measured target, upload a **reference clip** from music you own (an isolated vocal or an a
cappella section works best). Mimic analyses it the same way it analyses you, targets those numbers,
and compares your take phrase by phrase after aligning the two pitch contours (key-shift-invariant
DTW, so singing an octave lower is fine).

## Features

- Record with a live tuner (note and cents), level meter and pitch trace, or upload WAV, MP3, M4A,
  AAC, OGG, WebM or FLAC. A demo take lets you see the results without singing.
- Results: overall match, a coaching plan ranked by what matters most for the chosen singer, a style
  radar, per-measure meters, a pitch plot coloured by register with the passaggio shaded, a piano
  range strip, register shares above the passaggio, signature moves to try and vocal-health notes.
  Switch singers to see the same take scored against each.
- Practice: 24 exercises (lip-trill sirens, straw phonation, "ng" sirens, "nay" and "gee/gug" mix
  work, level-volume scales, vowel narrowing, onset drills, vibrato pulses, runs, falsetto flips and
  blended leaps, soul falsetto, messa di voce and more) with a built-in pattern player transposed to
  your voice type, and "record this drill".
- Progress: save takes and track your match score and each measure over time (stored in your browser).
- Optional AI coach: add your own Anthropic API key in Settings to ask Claude follow-up questions
  about a take. Only the numeric analysis is sent, never audio. The key stays in your browser.

## Run it

Requires Node 22+.

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit and integration tests (Vitest)
npm run typecheck
npm run build        # static site in dist/
npm run build:single # one self-contained HTML file in dist-single/
```

Microphone access needs `https://` or `localhost`. On a phone, open the deployed site (see below) or
record a voice memo and upload it.

## Deploy to GitHub Pages

`.github/workflows/pages.yml` builds and deploys on every push to `main`, and `ci.yml` runs the
typecheck, tests and build on every push. Both assume this folder is the root of its repository.
Enable Pages once under **Settings → Pages → Build and deployment → Source: GitHub Actions**.
GitHub Pages on a private repository needs a paid plan; on a free plan, make the repository public
first.

If this folder is sitting inside another repository (for example `connect-x/mimic-vocal-coach`),
GitHub won't see the workflows. Move it into its own repository with its history:

```bash
# from the parent repository
git subtree split --prefix mimic-vocal-coach -b mimic-vocal-coach
# create an empty repository called mimic-vocal-coach on GitHub, then:
git push git@github.com:<you>/mimic-vocal-coach.git mimic-vocal-coach:main
```

## Privacy

Analysis runs in your browser. Recordings, reference clips and results stay on your device; saved
progress and settings live in this site's local storage. The fonts are bundled, so the app makes no
third-party requests. The only exception is the optional AI coach, which sends the numeric analysis
summary (never audio) to Anthropic's API with your own key.

## How it works

```
audio ─► decode + mono ─► resample 22.05 kHz ─► YIN pitch (10 ms) ─► spectral measures per voiced frame
      ─► registers, phrases, notes, vibrato, runs, onsets ─► style vector ─► compare with singer targets
      ─► coaching plan + exercises
```

- `src/dsp` — FFT, band-limited resampler, YIN pitch tracker, spectral measures (H1–H2, tilt,
  alpha ratio, CPP, subharmonics).
- `src/analysis` — the analysis pipeline, run in a Web Worker (`analyzeInWorker`).
- `src/coach` — singer profiles, scoring, coaching plans, exercises, reference-clip comparison and
  the optional Claude coach.
- `src/ui`, `src/state` — the React app; charts are hand-built SVG.
- `src/testing/synth.ts` — a deterministic singing-voice synthesiser used by the tests to check the
  analysis against known ground truth.

`SPEC.md` documents the module contracts and design rules.

## Vocal health

Mimic never asks you to push louder. Warm up, stay hydrated, keep sessions short, and stop if you
feel pain, tightness or hoarseness. Hoarseness that lasts more than two weeks is a reason to see an
ENT doctor or laryngologist.

Mimic is an independent practice tool and is not affiliated with the artists.
