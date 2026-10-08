// The words of the import flow: what to tell someone who has no file yet, what works, what does not, and what each refusal
// means. Plain strings and small data so the Trainer's empty state, the import sheet and the Guide say the same thing.
// No imports from the app: safe to load anywhere.

export { PROTECTED_FILE_TIP, VIDEO_SHORTCUT_TIP } from '../audio/decode';

/** What the picker accepts, in words. */
export const IMPORT_FORMATS = 'WAV, MP3, M4A, AAC, FLAC, CAF, AIFF and OGG files, and the sound of phone videos (.mov, .mp4, .m4v).';

export const IMPORT_LEDE =
  'Add clips from music you own. Isolated vocals work best, and a whole song works too. Everything stays on this device.';

export interface ImportStep {
  title: string;
  body: string;
}

/** The three steps shown in the Trainer's empty state, the import sheet and the Guide. */
export const IMPORT_STEPS: readonly ImportStep[] = [
  {
    title: 'Get a file into Files',
    body: 'AirDrop it, save it to iCloud Drive, or use Share and then Save to Files from another app. A Voice Memo: open it, tap Share, then Save to Files.',
  },
  {
    title: 'Add it here',
    body: 'Tap Add clips and pick one or more files. A video from your Photos works too: only its sound is used.',
  },
  {
    title: 'Practise phrase by phrase',
    body: 'Mimic finds the phrases. Check them, save, then sing along with each one and see how close you are.',
  },
];

/** Phone videos: what works and what to do with a big one. */
export const VIDEO_HELP =
  'Videos from your Photos or Files (.mov, .mp4, .m4v) work: only the sound is read. A video over 150 MB or 15 minutes is too big to open on a phone. ' +
  'Make an audio-only copy first: in the Shortcuts app use the "Encode Media" action with Audio Only switched on, or trim the video in Photos so it is shorter, share it to Files, and add that file here.';

export const PROTECTED_HELP =
  'Apple Music downloads and other copy-protected files cannot be read by a web app. Use a DRM-free copy of a song you own, for example a purchased download, a CD rip or a file from your computer.';

export const STEM_HELP =
  'No isolated vocal? A vocal-splitter app on a computer can pull the voice out of a song you own. A whole song can also be added: Mimic follows the lead vocal and judges pitch and timing only.';

/** Shown on the review of a full song, above the button that adds the vocal-only file. */
export const STEM_PROMPT =
  "If you have this song's isolated vocal, add it here: Mimic uses it for the melody and the phrases, and you still hear the whole song while you practise.";

export const OWNERSHIP_LABEL = 'I own this file or have the right to practise with it.';

export const PRIVACY_NOTE = 'Your files are read on this device and stored only here. Nothing is uploaded, and a backup export never includes audio.';

/** The title and body of the Trainer's empty state (no clips yet). */
export const IMPORT_EMPTY_STATE = {
  title: 'Practise with the voices you love',
  body: 'Add clips from music you own (isolated vocals work best). Everything stays on this device.',
  addLabel: 'Add clips',
  helpLabel: 'How do I get a vocal?',
} as const;

// Reasons a clip cannot be used, and what to do next.

/** What the analysis knew about a clip with too little singing, to choose the right advice. */
export interface LittleSingingContext {
  /** Length of the clip, seconds. */
  durationSec?: number;
  /** The clip is silent or nearly so (the analysis raised the quiet issue and found no voice at all). */
  silent?: boolean;
}

export function littleSingingReason(voicedSec: number, context: LittleSingingContext = {}): string {
  if (context.silent && !(voicedSec >= 0.5)) {
    return 'This clip is silent, or too quiet to hear any singing. Check that you picked the right file, then add it again. A clip with a few seconds of singing works best.';
  }
  if (context.durationSec !== undefined && context.durationSec > 0 && context.durationSec < 2) {
    return `This clip is only ${context.durationSec.toFixed(1)} s long, too short to practise from. Pick a clip with a few seconds of singing.`;
  }
  const heard =
    !(voicedSec >= 0.5)
      ? 'No clear singing could be heard in this clip'
      : `Only ${voicedSec < 10 ? voicedSec.toFixed(1) : Math.round(voicedSec)} s of clear singing could be heard in this clip`;
  return (
    `${heard}, so there is nothing to practise yet; backing music or effects may be covering the voice. ` +
    'Pick a clip with a few seconds of singing, an isolated vocal, or switch on "This is a full song" if the voice is over a band.'
  );
}

/** The context littleSingingReason needs, read from an analysis. */
export function littleSingingContext(analysis: { issues?: string[]; durationSec: number; voicedSec: number }): LittleSingingContext {
  return { durationSec: analysis.durationSec, silent: (analysis.issues ?? []).includes('too-quiet') && !(analysis.voicedSec >= 0.5) };
}

export const SPEECH_REASON =
  'This clip sounds mostly like short, speech-like syllables with few held notes, so Mimic cannot follow a melody in it. ' +
  'Pick a sung section with some held notes, or switch on "This is a full song" if the voice is over a band.';

export const NO_PHRASES_REASON = 'No phrases could be found in this clip. Pick a clip with a clearly sung melody and short breaths between lines.';

export const MIX_REASON =
  'This sounds like a full song: singing over instruments. Mimic follows the lead vocal and judges pitch and timing only; tone is not measured for full songs. ' +
  'Play the detected melody to check that it follows the singing.';

/** The lead-vocal reading of a full song found too little singing to practise with. */
export function littleMixSingingReason(voicedSec: number): string {
  const heard = !(voicedSec >= 0.5)
    ? 'Mimic could not follow a lead vocal in this clip'
    : `Mimic could follow only ${voicedSec < 10 ? voicedSec.toFixed(1) : Math.round(voicedSec)} s of lead vocal in this clip`;
  return (
    `${heard}, so there is nothing to practise yet. It may be an instrumental part, or the voice sits too far below the band. ` +
    'Keep a part of the song with continuous singing, add the vocal-only version of the song, or pick another clip.'
  );
}

/** The automatic full-song pass failed after the solo pass had found a band: the solo reading is shown instead. */
export function mixAutoFailedWarning(why: string | null): string {
  return (
    'Mimic found a band in this clip but could not follow the lead vocal automatically' +
    (why && why.trim() ? ` (${why.trim().slice(0, 140).replace(/[.\s]+$/, '')})` : '') +
    '. The solo reading is shown, which may follow the band instead of the voice. Switch on "This is a full song" to try again.'
  );
}

export const BAND_WARNING =
  'This clip sounds like it has instruments in it. If the detected melody does not follow the singing, switch on "This is a full song".';

export const NOISY_WARNING = 'There is a lot of background noise in this clip, so the notes may be harder to follow.';

/** A voice well above the band (+6 dB and more) reads as a clean solo with background noise: the extra notes in the guide would be the band's. */
export const VOCAL_FORWARD_HINT = 'If there are instruments with the voice, switch on "This is a full song".';
export const CLIPPING_WARNING = 'The recording is distorted (clipping), which can confuse the pitch tracking.';
export const QUIET_WARNING = 'This clip is very quiet, so quiet notes may be missed.';

export const NOT_FOR_TARGETS_MIX = 'Full songs cannot count toward a singer\'s measured targets, because the band changes the tone.';

// ---------------------------------------------------------------------------------------------
// Isolating the vocal of a song on the device (src/audio/separation). Optional, off by default.

export const ISOLATE_LABEL = 'Isolate the vocal first (AI)';
/** The label on a clip whose audio is an isolated vocal. */
export const ISOLATED_KIND_LABEL = 'Isolated vocal (AI)';

/** The WebAssembly engine that runs the model, in MB (the size of the runtime's .wasm file); it is fetched with the model on first use. */
export const ISOLATE_ENGINE_MB = 11;

/** What it costs, said before anything is downloaded or run. `size` is the model's size in MB, from its manifest when known. */
export function isolateCostText(sizeMb: number | null, kept = false): string {
  const model = sizeMb && sizeMb > 0 ? Math.round(sizeMb) : 20;
  const download = kept
    ? 'The model is already on this phone, so there is no download.'
    : `The first time, Mimic downloads about ${model + ISOLATE_ENGINE_MB} MB from this site (the model, about ${model} MB, and the engine that runs it, about ${ISOLATE_ENGINE_MB} MB) and keeps them on the phone (Settings shows them, and can remove them).`;
  return (
    `${download} Splitting a song takes minutes, not seconds (longer on an older phone), uses a lot of battery and makes the phone warm, so plug it in and keep this screen open: locking the phone can pause it. ` +
    'It all happens on this device; nothing is uploaded.'
  );
}

/** The honest limit, shown wherever the option is offered. */
export const ISOLATE_LIMIT_TEXT =
  'The vocal it pulls out is approximate: it keeps traces of the band and has small artefacts, so tone numbers measured on it are estimates. A real isolated vocal file is always better.';

/** Added to a clip's warnings after isolation. */
export const ISOLATED_VOCAL_WARNING =
  'The vocal was pulled out of the song on this device, so it has small artefacts and traces of the band. Listen to it before you trust the phrases.';

/** Added after isolation when the vocal still reads as having instruments in it: the split left the band in, so the phrases may follow it. */
export const ISOLATED_BAND_LEFT_WARNING =
  'The band is still in this vocal: the split did not take it out, so the detected melody may follow the instruments. Try another part of the song, or add the vocal-only version.';

/** Shown on an isolated clip and next to every tone number measured on one. */
export const ISOLATED_TONE_NOTE =
  'This vocal was pulled out of a song by AI on this phone, so it carries small artefacts and traces of the band. Treat the tone numbers (breathiness, brightness, strain) as rough estimates; pitch and timing are less affected.';

/** Counting an isolated clip toward a singer's measured targets. */
export const ISOLATED_TARGETS_NOTE = 'This clip is an AI-isolated vocal, so its tone numbers are estimates. Counting it adds them to the singer\'s targets as they are.';

export const ISOLATE_UNDO_NOTE = 'To go back to the whole song, add the file again without this option.';

/** The long-song rule: how much of a song is split in one go. */
export function isolateCapText(maxMinutes: number): string {
  return `Only up to ${maxMinutes} minutes of a song are split at a time. For a longer song, choose where to start; the part you pick is what is stored.`;
}

/** Shown on the Add clips screen when an earlier split was cut off (the page ended mid-split: memory, or a locked screen). */
export function interruptedSplitText(fileName: string, seconds: number): string {
  const part = seconds >= 90 ? `${Math.round(seconds / 60)} minutes` : `${Math.max(1, Math.round(seconds))} seconds`;
  return `The last split ("${fileName}", ${part} of it) did not finish. The phone may have run out of memory, or the screen locked and paused it. Try a shorter part (one minute is a good start), keep this screen open and plug the phone in.`;
}

export const ISOLATE_MODEL_MISSING = 'This copy of Mimic does not include the vocal-isolation model. Add the vocal-only version of the song instead.';

export const ISOLATE_NOT_FOR_MIX = 'An isolated vocal is read as a single voice. To read this clip as a full song again, add the file again without isolating it.';
