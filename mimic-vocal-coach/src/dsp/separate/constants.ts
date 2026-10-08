// Geometry of the Spleeter 2-stems vocal separator (Deezer, MIT licence). Everything the signal pipeline needs to
// agree with the neural network on lives here, so a differently-shaped model only has to change this one object.
//
// Source of the numbers: deezer/spleeter configs/2stems/base_config.json and spleeter/model/__init__.py
// (EstimatorSpecBuilder._build_stft_feature / _build_masks / _inverse_stft).

/** The network was trained on, and only accepts, 44.1 kHz audio. Anything else is resampled to this and back. */
export const MODEL_SAMPLE_RATE = 44100;

/** The network always sees two audio channels (a mono recording is duplicated). */
export const MODEL_CHANNELS = 2;

export interface SeparationParams {
  /** STFT window length in samples. A power of two. Spleeter: 4096. */
  frameLength: number;
  /** STFT hop in samples. Must divide frameLength. Spleeter: 1024 (75 % overlap). */
  frameStep: number;
  /** F: how many of the lowest STFT bins the network sees and masks; bins above are zeroed. Spleeter: 1024 of 2049 (0..11.025 kHz). */
  modelBins: number;
  /** T: STFT frames per network patch. Even. Spleeter: 512 (about 11.9 s). */
  patchFrames: number;
}

export const SPLEETER_PARAMS: Readonly<SeparationParams> = Object.freeze({
  frameLength: 4096,
  frameStep: 1024,
  modelBins: 1024,
  patchFrames: 512,
});

export const FRAME_LENGTH = SPLEETER_PARAMS.frameLength;
export const FRAME_STEP = SPLEETER_PARAMS.frameStep;
export const MODEL_BINS = SPLEETER_PARAMS.modelBins;
export const PATCH_FRAMES = SPLEETER_PARAMS.patchFrames;

/** Number of floats in one model input or output patch: T x F x 2, in [t][f][c] order. */
export function patchLength(p: SeparationParams = SPLEETER_PARAMS): number {
  return p.patchFrames * p.modelBins * MODEL_CHANNELS;
}

/** Merge overrides over the Spleeter defaults and check the result is usable. */
export function resolveParams(overrides?: Partial<SeparationParams>): SeparationParams {
  const p: SeparationParams = { ...SPLEETER_PARAMS, ...overrides };
  const isPow2 = (n: number) => Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
  if (!isPow2(p.frameLength)) throw new Error(`frameLength ${p.frameLength} must be a power of two`);
  if (!Number.isInteger(p.frameStep) || p.frameStep < 1 || p.frameLength % p.frameStep !== 0) {
    throw new Error(`frameStep ${p.frameStep} must be a whole divisor of frameLength ${p.frameLength}`);
  }
  if (p.frameLength / p.frameStep < 4) {
    // Below 75 % overlap the Hann window cannot be inverted everywhere (the analysis window touches zero).
    throw new Error('frameStep must give at least 75 % window overlap (frameLength / frameStep >= 4)');
  }
  if (!Number.isInteger(p.modelBins) || p.modelBins < 1 || p.modelBins > p.frameLength / 2 + 1) {
    throw new Error(`modelBins ${p.modelBins} must be between 1 and ${p.frameLength / 2 + 1}`);
  }
  if (!Number.isInteger(p.patchFrames) || p.patchFrames < 2 || p.patchFrames % 2 !== 0) {
    throw new Error(`patchFrames ${p.patchFrames} must be an even number >= 2`);
  }
  return p;
}
