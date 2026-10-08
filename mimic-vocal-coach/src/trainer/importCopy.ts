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

export const OWNERSHIP_LABEL = 'This is a file I own or have the right to practise with. It stays on this device.';

export const PRIVACY_NOTE = 'Your files are read on this device and stored only here. Nothing is uploaded, and a backup export never includes audio.';

/** The title and body of the Trainer's empty state (no clips yet). */
export const IMPORT_EMPTY_STATE = {
  title: 'Practise with the voices you love',
  body: 'Add clips from music you own (isolated vocals work best). Everything stays on this device.',
  addLabel: 'Add clips',
  helpLabel: 'How do I get a vocal?',
} as const;

// Reasons a clip cannot be used, and what to do next.

export function littleSingingReason(voicedSec: number): string {
  const heard =
    !(voicedSec >= 0.5)
      ? 'No clear singing could be heard in this clip'
      : `Only ${voicedSec < 10 ? voicedSec.toFixed(1) : Math.round(voicedSec)} s of clear singing could be heard in this clip`;
  return (
    `${heard}, so there is nothing to practise yet; backing music or effects may be covering the voice. ` +
    'Pick a clip with a few seconds of singing, an isolated vocal, or switch on "This is a full song" if the voice is over a band.'
  );
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

export const NOISY_WARNING =
  'There is a lot of background noise in this clip, so the notes may be harder to follow. If there is music behind the voice, switch on "This is a full song".';
export const CLIPPING_WARNING = 'The recording is distorted (clipping), which can confuse the pitch tracking.';
export const QUIET_WARNING = 'This clip is very quiet, so quiet notes may be missed.';

export const NOT_FOR_TARGETS_MIX = 'Full songs cannot count toward a singer\'s measured targets, because the band changes the tone.';
