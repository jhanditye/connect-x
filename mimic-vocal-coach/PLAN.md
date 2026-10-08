# Mimic: next phase plan

Goal: sound like Shawn Mendes, Daniel Caesar and Jalen Ngonda by copying real clips of them,
phrase by phrase, on an iPhone, with everything staying on the device.

## Ground rules

- **No commercial recordings are downloaded, bundled or shared by the app or by us.** No YouTube or
  Google ripping. The clips come from music the user already has (MP3/M4A/WAV files, audio from
  phone videos), imported on their own device and stored only there.
- **Local first.** No GitHub hosting, no server of ours, no accounts. Analysis runs on the device.
- **iPhone first.** Phone layouts, one hand, headphones, Home Screen install, offline.
- **Be honest about what is estimated.** Singer targets are estimates until measured from clips;
  tone comparisons are approximate; real WebKit behaviour is untested here and gets a device checklist.

## What exists (v1, 604 tests)

Analysis engine (pitch, registers, notes, vibrato, runs, onsets, style vector), three singer
profiles, coaching plans, 24 exercises, reference-clip comparison (DTW), measure-singers-from-clips,
progress history, optional AI coach, Studio/Results/Practice/Progress/Guide/Settings, an installable
offline PWA with iPhone fixes (applied from the iOS research patch).

## Research decisions (from five parallel studies)

| Topic | Decision | Evidence |
|---|---|---|
| Storage | Clip audio as mono Int16 PCM in 10 s IndexedDB chunks (about 5.5 MB per minute); metadata separate; library export never contains audio | trainer design, prototype store with tests |
| Playback and recording | One AudioContext for guide playback, count-in and stamped capture; sample-exact start; slow and transposed guides pre-rendered with WSOLA | prototype verified in Chromium within 5 ms |
| Latency | Estimate the sync offset from the singing itself; never trust `outputLatency` | synthetic and one real recording |
| Speaker bleed | Sing-along only on headphone-like routes; default to listen-then-sing otherwise; click probe and "too perfect" checks | bleed tests |
| Scoring | Contour-first scorer: key-invariant pitch, onsets judged against a fitted lag-and-tempo model, tone from normalised breathiness/brightness/rasp only; weights 40/25/20/15 | 47 tests; perfect copies score 99-100, injected errors move the intended sub-score |
| Full songs | Lead-vocal melody extractor (stationary-background suppression, harmonic salience, Viterbi): pitch accuracy 0.82 vs 0.32 for today's tracker on 360 proxy mixes; pitch, timing, vibrato and loudness contour only; tone measures hidden on mixes | 28 tests, 3.2 s for 4 min |
| AI vocal separation | Built as an opt-in, off by default (see `src/trainer/README.md`, "Vocal isolation"): Deezer Spleeter 2-stems converted to ONNX (int8 weights, about 20 MB), run by onnxruntime-web (single thread, an 11 MB WebAssembly engine) in a module worker, downloaded once from this site and kept on the phone. Still open before it is relied on: nobody has listened to the result, it has never run on an iPhone (memory, speed, screen lock, WebKit), and the licence of the pretrained weights is unconfirmed (the code is MIT) | desktop Chromium end to end; numerics match a Python reference to -144 dB |
| iPhone | Installable PWA, offline service worker, recorder interruption handling, share-sheet saves, 44 px targets; microphone needs HTTPS, so a loose HTML file cannot record on iPhone | 27/27 Chromium emulation checks; WebKit untested |

## Workstreams

| ID | Work | Source prototypes | Acceptance |
|---|---|---|---|
| W0 | Contracts: additive types, module stubs with final signatures, fakes, routes, `addMeasuredClip`, `transposeHint` | trainer `spec/` | typecheck, tests, build green with stubs |
| W1 | Data: IndexedDB clip store, memory fallback, library export/import, quota and persistence, `TrainerProvider` | `lib/idb.ts`, `store.ts`, `pcm.ts` | one shared store contract test runs against both stores; Chromium IndexedDB run |
| W2 | Import: multi-file and video import, classification, mix mode switch, phrase segmentation and editor, one-tap contribution to a singer's measured targets | `lib/segment.ts` | import a clean clip, a mix and a video in a browser test; phrases editable |
| W3 | Audio: duplex session, phrase player, WSOLA stretch and transpose, click probe, route and wake lock, Diagnostics page | `lib/duplex.ts`, `wsola.ts`, `latency.ts` | fake-AudioContext tests and a Chromium loopback check |
| W4 | Compare: scorer plus per-note table, tone words, three fixes, mastery and spaced review, overlay plot and tables | `scoring/lib/*`, `lib/compare.ts`, `feedback.ts`, `srs.ts` | scenario tests with synthetic ground truth; one score authority |
| W5 | Full-song front end: `extractVocalMelody`, mix mode in `analyzeTake`, confidence badge, hidden tone measures | `melody/src/` | proxy-mix regression test; demo take unchanged |
| W6 | Screens: Trainer route and five-tab phone nav, library, import sheet, phrase practice, result sheet, More, empty and error states, Guide copy | trainer spec section 6 | every screen works against fakes, then against real modules |
| W7 | iOS app project (Capacitor) for a Mac with Xcode, local and offline, no hosting | none | project generated and documented; unbuilt without a Mac, stated plainly |
| W8 | Integration, review lenses, Chromium iPhone-emulation end-to-end, fixes, delivery | | all checks green, delivery files built |

## Verification

- Unit tests with synthetic ground truth (known detune, lag, tempo, tone changes).
- Real clips already on disk for regression (a cappella singers; mixes).
- Chromium with iPhone emulation, fake microphone, offline mode, service worker checks.
- Independent review lenses (code, UX and accessibility, scoring honesty, robustness) with skeptical verification.
- WebKit is not installed here, so real Safari audio behaviour (silent switch, Bluetooth routes,
  permission prompts, Voice Memos decoding) is checked by the on-device checklist in the Guide
  and the Diagnostics page.

## Delivery

1. `Mimic-Vocal-Coach.html`: single file, desktop browsers, no network.
2. `mimic-pwa.zip`: the built site; works installed on iPhone when served from any HTTPS address.
3. `ios-native/`: Capacitor project to build to the user's own iPhone from a Mac.
4. The private claude.ai page for quick use from Safari (uploads only; that viewer blocks the mic).

## Not doing

- Downloading, bundling or sharing commercial recordings.
- Hosting on GitHub.
- Shipping the AI separation model before the licence and hosting are settled.
- Claiming anything about real iPhone behaviour that was not tested on a phone.
