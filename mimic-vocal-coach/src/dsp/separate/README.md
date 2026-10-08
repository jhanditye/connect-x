# Vocal isolation: the signal pipeline

This folder turns a full song into an isolated vocal. It does everything except the neural network: cutting the song
into the pieces the network expects, feeding them to it, and turning what comes back into audio. The network is
handed in from outside (a `MaskModel`), so this code can be tested with fake models and later backed by
onnxruntime-web without changing a line of it.

It is written for Deezer's Spleeter "2 stems" model (vocals + accompaniment). The numbers it uses (sample rate, window
size, patch size, frequency range) are in `constants.ts`.

## What it does, step by step

1. **Resample** the song to 44.1 kHz if it is not already (the network only knows 44.1 kHz). A mono song is treated as
   a stereo song with two identical channels.
2. **Cut it into patches.** The song is analysed with a short-time Fourier transform (4096-sample Hann window, a new
   frame every 1024 samples). Every 512 frames (about 11.9 seconds) become one patch. Only the lowest 1024 of the 2049
   frequency bins (0 to 11.025 kHz) are shown to the network.
3. **Ask the network** about each patch. It looks at the loudness of every time/frequency cell of both channels and
   answers with a "vocal mask" between 0 and 1 for the same cells: 1 means "this is the singer", 0 means "this is the
   band".
4. **Apply the mask** to the song's own spectrum (so the phase of the original recording is kept), set everything
   above 11.025 kHz to zero, and turn it back into audio. The two channels are averaged, so the result is one mono
   vocal.
5. **Resample back** to the caller's sample rate and make the result exactly as long as the input.

The song is processed one patch at a time. The code never holds the whole spectrogram: a few patches of spectrum
(about 20 MB) are alive at once, plus the input song and the output vocal (4 bytes per sample each).

## Using it

```ts
import { separateVocals, type MaskModel } from './separate';

const model: MaskModel = {
  // input: Float32Array of 512 * 1024 * 2 magnitudes, order [time][frequency][channel]
  // return: the vocal mask, same length, same order, values 0..1
  async run(input) { /* run the network, e.g. with onnxruntime-web, and return the mask */ },
};

const { vocals } = await separateVocals({
  channels: [left, right],           // or just [mono]
  sampleRate: 48000,
  model,
  overlap: 0.5,                      // optional, see below
  onProgress: (fraction, info) => {},
  signal: abortController.signal,    // optional
});
```

`vocals` is a mono `Float32Array` at the same sample rate and with the same length as the input.

### Overlap

By default (`overlap: 0`) the patches do not overlap, exactly as Spleeter itself does. The network sees each patch
with no knowledge of its neighbours, so its answer can change a little at the seam between two patches, and that can
be heard as a faint step in the vocal every 12 seconds.

With `overlap: 0.5` each patch starts half a patch after the previous one, so every moment of the song (except the
first and last half patch) is judged twice. The two masks are cross-faded smoothly across the overlap, so there is no
seam. The cost is twice as many network runs.

### Cancelling and progress

The cancel signal is checked between patches and between resampling steps, and the promise rejects with an
`AbortError` (use `isAbortError` from `src/analysis/abort`). Between patches the code waits for the event loop, so a
page or worker stays responsive. Progress is a fraction that never goes backwards and finishes at exactly 1.

## Limits worth knowing

- **Not instant, and the network dominates.** Everything in this folder (Fourier transforms, masking, overlap-add)
  took about 2 seconds for a 3-minute stereo song at 44.1 kHz on the development machine with a do-nothing model
  (about 16 patches, or 30 with overlap). The network itself is far slower on a phone. Run it in a worker, not on the
  main thread.
- **Resampling is a single blocking call per channel.** For a 3-minute 48 kHz song that was about 5 seconds in total
  on the development machine, with no chance to cancel in the middle (cancel is honoured between the steps). If the
  audio is already 44.1 kHz it is skipped entirely.
- **Memory.** The song is held as 44.1 kHz float32: about 106 MB per channel for 10 minutes. A 10-minute stereo
  song needs roughly 212 MB for the input, 106 MB for the output vocal and about 20 MB of working patches, plus
  whatever the network runtime uses. If the input is not at 44.1 kHz, add the resampled copy of the song.
- **Mono output, 11 kHz ceiling.** The vocal is the average of the two channels' vocal estimates, and the network
  only works up to 11.025 kHz, so breathiness and "air" above that are gone. That is fine for pitch, tone and
  loudness work, not for a studio-quality stem.
- **It is an estimate.** Backing vocals, doubled lead vocals, reverb tails and some instruments (especially
  sustained synth leads and distorted guitars) can leak through or be partly removed. The quality is that of the
  network, not of this code.
- **Quiet and silent songs** are fine: a silent input gives a silent output.
- **Length 0** returns an empty vocal straight away.
- Inputs with more than two channels must be mixed down by the caller. NaN or out-of-range values in the network's
  mask are clamped (NaN counts as 0), and NaN or infinite samples in the audio itself are replaced by 0 before
  anything else happens (the caller's arrays are not changed).
- **The output is not limited.** Band-limiting a loud, clipped mix can overshoot +-1 a little (a 4x-gain, hard-clipped
  test clip peaks at about 1.66); ordinary material does not. The caller clamps when it converts to 16-bit PCM.

## How it was checked

- `separate.test.ts` (35 tests, about 8 seconds) uses fake networks. It checks that the transform and its inverse
  reproduce a signal better than -80 dB (even at the first and last sample); that an all-ones mask keeps a 1 kHz tone
  and removes a 15 kHz tone; that an all-zeros mask gives exact silence; that a mask keeping one of two tones isolates
  it by far more than 30 dB; that the network input really is `[time][frequency][channel]` and unnormalised; that
  patches line up in both overlap modes and cross-fade as described; that output length equals input length;
  mono/stereo handling; cancelling; progress; the 48 kHz, 32 kHz and 22.05 kHz paths (including a sample-for-sample
  comparison that would notice a time shift); and that one NaN or infinite input sample cannot reach the network
  or the output. A small numpy golden (a few STFT bins and 19 output samples of a masked stereo signal, no audio and
  no weights) pins the window shape, alignment, scale and channel order, which the self-consistency tests cannot.
- The same noise signal and a mask that changes with time, frequency and channel was run through this code and through
  a separate Python/numpy implementation of Spleeter's graph (which had itself been compared with the original
  TensorFlow graph). The two agree to -144.5 dB (largest sample difference 4.5e-8), so the frame positions, the
  one-frame lead-in, the patch layout and the normalisation match Spleeter.

## Checked in a real browser with the real network

The same pipeline was run in headless Chromium inside a module Web Worker with onnxruntime-web 1.19.2 (WASM, one
thread, no SharedArrayBuffer, page not cross-origin isolated) and the int8mix Spleeter ONNX model, then compared with
the converter's Python/onnxruntime reference output (the mean of its two channels, because this module returns mono):
10.9 s clip (1 patch) 134.7 dB signal-to-difference, 54.4 s clip made of the same clip five times (5 patches)
136.3 dB. Largest sample difference 2.4e-7. The first and last 4096 samples agree to better than 104 dB.

## Where the numbers come from

Spleeter's own source (`spleeter/model/__init__.py`, `configs/2stems/base_config.json`): 44.1 kHz, frame length 4096,
frame step 1024, T = 512 frames per patch, F = 1024 bins, periodic Hann window, one frame of zeros in front of the
song, the end padded to a whole frame, patches cut with no overlap, mask above bin 1024 set to zero, overlap-add
divided by the summed squared window (Spleeter writes this as a fixed factor of 2/3 for its 75 % overlap).
Spleeter's final mask is a ratio of two networks' outputs (vocals squared over vocals squared plus accompaniment
squared); this module expects that ratio to be inside the `MaskModel`, i.e. the model returns the finished vocal mask.

## Licence of the model this is meant for

Spleeter is by Deezer (Deezer SA, 2019 onwards). Its code is published under the **MIT licence**, which allows use,
modification and redistribution with the licence notice kept. The project's README does not state a separate licence
for the downloadable pretrained checkpoints, so the assumption here is that they are covered by the same MIT terms;
confirm that before shipping the weights inside a public release of the app. The training data is not public. Deezer
also asks users to obtain the rights holders' authorisation when using Spleeter on copyrighted recordings; for this
app the intended use is practising on songs the user already owns, on the user's own device, with nothing uploaded.
No audio and no model weights belong in this repository.
