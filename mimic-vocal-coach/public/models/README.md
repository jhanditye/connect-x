# Vocal-isolation model (not committed)

The optional "Isolate the vocal first (AI)" feature needs one file here, which is too big to commit:

    public/models/vocal-isolation.onnx     (about 19 MB, git-ignored)
    public/models/vocal-isolation.json     (committed: name, version, bytes, sha256, licence, source, inputRate)

The app asks for the manifest (`.json`) first. If it is missing, or the `.onnx` it describes is not served, the option is simply not
offered and nothing else changes. The model is downloaded once, only when a person turns the option on, checked against the manifest's
size and SHA-256, and kept in the browser's Cache Storage (`mimic-vocal-model-v1`), not in the app's offline precache.

## Putting the model in place

    node scripts/prepare-separator-model.mjs --from /path/to/spleeter2_vocals_ratio_int8mix.onnx
    node scripts/prepare-separator-model.mjs --check      # verify the file against the manifest

`npm run build` copies everything in `public/` into `dist/`, so build after running it. The single-file build (`vite build --mode single`)
leaves `models/` out and reports the feature unavailable.

## What the file is

Deezer Spleeter 2-stems (vocals), converted from the TensorFlow 1 checkpoint to ONNX: both U-Nets, with the ratio mask computed in the
graph, and the big weights stored as int8 (per-channel) or fp16, computed in fp32. Input `mix_magnitude` float32 `[1, 512, 1024, 2]`
(|STFT| of a 44.1 kHz stereo patch), output `vocals_ratio_mask` in `[0, 1]`. The signal pipeline around it is `src/dsp/separate`.
Measured on the test clip: vocals -47.2 dB against the fp32 model (the fp16 variant is -77.9 dB and twice the size: use it if the int8
variant ever sounds worse).

## Licence

Spleeter's code is MIT (Copyright (c) 2019-present Deezer SA); the notice is shown in the app (Guide, Settings). Deezer publishes no
separate licence for the pretrained weights and says they were trained on a private dataset. That is an open question to settle before
this app is shared publicly. The runtime, onnxruntime-web, is MIT (Microsoft).
