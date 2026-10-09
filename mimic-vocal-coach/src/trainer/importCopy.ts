// The words of the import flow: what to tell someone who has no file yet, what works, what does not, and what each refusal
// means. Plain strings and small data so the Trainer's empty state, the import sheet and the Guide say the same thing.
// No imports from the app: safe to load anywhere.

import { isDesktopKind, type PlatformKind } from '../pwa/platform';
import { onLocalServer } from '../pwa/words';

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
export function isolateCostText(sizeMb: number | null, kept = false, kind: PlatformKind = 'other'): string {
  const model = sizeMb && sizeMb > 0 ? Math.round(sizeMb) : 20;
  const desk = isDesktopKind(kind);
  const where = desk ? (kind === 'mac' ? 'this Mac' : 'this computer') : 'this phone';
  // The Mac download serves everything from its own folder: nothing comes from the internet, the files are copied into the browser.
  const fromFolder = desk && onLocalServer();
  const download = kept
    ? `The model is already on ${where}, so there is no download.`
    : fromFolder
      ? `The first time, Mimic copies about ${model + ISOLATE_ENGINE_MB} MB (the model, about ${model} MB, and the engine that runs it, about ${ISOLATE_ENGINE_MB} MB) from the Mimic folder on ${where} and keeps them in this browser (Settings shows them, and can remove them).`
      : `The first time, Mimic downloads about ${model + ISOLATE_ENGINE_MB} MB from this site (the model, about ${model} MB, and the engine that runs it, about ${ISOLATE_ENGINE_MB} MB) and keeps them ${desk ? 'in this browser' : 'on the phone'} (Settings shows them, and can remove them).`;
  const work = desk
    ? 'Splitting a song takes minutes, not seconds (longer on an older computer) and works the processor hard, so the fans may spin up. Keep this tab in front and the computer awake, and plug a laptop in: a locked screen or sleep can pause it. '
    : 'Splitting a song takes minutes, not seconds (longer on an older phone), uses a lot of battery and makes the phone warm, so plug it in and keep this screen open: locking the phone can pause it. ';
  return `${download} ${work}It all happens on this device; nothing is uploaded.`;
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

/** ISOLATED_TONE_NOTE in the words of the device ("on this Mac"). */
export function isolatedToneNote(kind: PlatformKind = 'other'): string {
  return isDesktopKind(kind) ? ISOLATED_TONE_NOTE.replace('on this phone', kind === 'mac' ? 'on this Mac' : 'on this computer') : ISOLATED_TONE_NOTE;
}

/** Counting an isolated clip toward a singer's measured targets. */
export const ISOLATED_TARGETS_NOTE = 'This clip is an AI-isolated vocal, so its tone numbers are estimates. Counting it adds them to the singer\'s targets as they are.';

export const ISOLATE_UNDO_NOTE = 'To go back to the whole song, add the file again without this option.';

/** The long-song rule: how much of a song is split in one go. */
export function isolateCapText(maxMinutes: number): string {
  return `Only up to ${maxMinutes} minutes of a song are split at a time. For a longer song, choose where to start; the part you pick is what is stored.`;
}

/** Shown on the Add clips screen when an earlier split was cut off (the page ended mid-split: memory, or a locked screen). */
export function interruptedSplitText(fileName: string, seconds: number, kind: PlatformKind = 'other'): string {
  const part = seconds >= 90 ? `${Math.round(seconds / 60)} minutes` : `${Math.max(1, Math.round(seconds))} seconds`;
  if (isDesktopKind(kind)) {
    return `The last split ("${fileName}", ${part} of it) did not finish. The browser may have run out of memory, or the tab went to the background or the computer went to sleep and paused it. Try a shorter part (one minute is a good start), keep this tab in front and, on a laptop, plug it in.`;
  }
  return `The last split ("${fileName}", ${part} of it) did not finish. The phone may have run out of memory, or the screen locked and paused it. Try a shorter part (one minute is a good start), keep this screen open and plug the phone in.`;
}

export const ISOLATE_MODEL_MISSING = 'This copy of Mimic does not include the vocal-isolation model. Add the vocal-only version of the song instead.';

export const ISOLATE_NOT_FOR_MIX = 'An isolated vocal is read as a single voice. To read this clip as a full song again, add the file again without isolating it.';

// ---------------------------------------------------------------------------------------------
// The words of the import flow for a Mac or another computer. A phone (and anything unrecognised) keeps the constants above.

export interface ImportWays {
  title: string;
  body: string;
}

export interface ImportWords {
  formats: string;
  lede: string;
  steps: readonly ImportStep[];
  /** The same steps inside the Add clips sheet, where the "Add clips" button of the page is not on screen. */
  sheetSteps: readonly ImportStep[];
  videoHelp: string;
  videoSummary: string;
  protectedHelp: string;
  stemHelp: string;
  /** The Trainer empty state: every way to get a file. */
  ways: readonly ImportWays[];
  waysSummary: string;
  /** The Guide's section title. */
  guideTitle: string;
}

const DESKTOP_FORMATS = 'WAV, MP3, M4A, AAC, FLAC, AIFF, CAF and OGG files, and the sound of videos (.mov, .mp4, .m4v).';

/** Apple Music subscription downloads and very old iTunes purchases are copy-protected; purchases since 2009, CD rips and plain files are not. */
export const DESKTOP_PROTECTED_HELP =
  'Songs downloaded with an Apple Music subscription are copy-protected, and so are very old iTunes purchases (.m4p files): a web app cannot read them. ' +
  'Songs you bought from the iTunes Store since 2009 are normally plain M4A files and work, and so do CD rips and any file without copy protection. ' +
  'In the Music app, right-click a song you bought and choose Show in Finder to find its file.';

export const DESKTOP_VIDEO_HELP =
  'Videos (.mov, .mp4, .m4v) work: only the sound is read. A video over 150 MB or 15 minutes is too big to open in a browser. ' +
  'Make an audio-only copy first: in QuickTime Player choose File, then Export As, then Audio Only, or trim the video so it is shorter, and add that file here.';

export const DESKTOP_STEM_HELP =
  'No isolated vocal? Switch on "Isolate the vocal first (AI)" when you add a song you own, or use a vocal-splitter app to pull the voice out first. A whole song can also be added as it is: Mimic follows the lead vocal and judges pitch and timing only.';

export function importWords(kind: PlatformKind = 'other'): ImportWords {
  if (!isDesktopKind(kind)) {
    return {
      formats: IMPORT_FORMATS,
      lede: IMPORT_LEDE,
      steps: IMPORT_STEPS,
      sheetSteps: IMPORT_STEPS,
      videoHelp: VIDEO_HELP,
      videoSummary: 'Videos from your phone',
      protectedHelp: PROTECTED_HELP,
      stemHelp: STEM_HELP,
      ways: [
        {
          title: 'From the Files app',
          body: 'Anything in On My iPhone or iCloud Drive can be picked, and so can files from Dropbox or Google Drive that show up in Files. AirDrop a file from a Mac and save it to Files.',
        },
        { title: 'From Voice Memos', body: 'Open the memo, tap Share, then Save to Files. Then add it here.' },
        { title: 'Music you bought without copy protection', body: `Downloads from stores that sell DRM-free files, CD rips and files from your computer all work. ${PROTECTED_HELP}` },
        { title: 'Vocal stems', body: STEM_HELP },
        { title: 'Sound from a phone video', body: VIDEO_HELP },
      ],
      waysSummary: 'Ways to get a vocal onto your phone',
      guideTitle: 'Getting a vocal onto your phone',
    };
  }
  const where = kind === 'mac' ? 'your Mac' : 'your computer';
  const desktopSteps: readonly ImportStep[] = [
    {
      title: 'Find the file',
      body: `Songs and recordings you own are ordinary files on ${where}: in Finder, your Music or Downloads folder, or iCloud Drive. A Voice Memo can be dragged out of the Voice Memos app onto the desktop first.`,
    },
    { title: 'Add it here', body: 'Click Add clips and pick one or more files, or drag them onto this window. A video works too: only its sound is used.' },
    IMPORT_STEPS[2],
  ];
  return {
    formats: DESKTOP_FORMATS,
    lede: 'Add clips from music you own. Isolated vocals work best, and a whole song works too. Everything stays in this browser on this computer.',
    steps: desktopSteps,
    sheetSteps: desktopSteps.map((st) =>
      st.title === 'Add it here' ? { ...st, body: 'Choose files above, or drag them onto this window. A video works too: only its sound is used.' } : st,
    ),
    videoHelp: DESKTOP_VIDEO_HELP,
    videoSummary: 'Videos',
    protectedHelp: DESKTOP_PROTECTED_HELP,
    stemHelp: DESKTOP_STEM_HELP,
    ways: [
      {
        title: kind === 'mac' ? 'From Finder' : 'From a folder',
        body: `Anything in Downloads, Music, Documents or iCloud Drive can be picked, and so can files in Dropbox or Google Drive folders on ${where}. You can also drag files onto this window.`,
      },
      { title: 'From Voice Memos', body: 'Drag the recording out of Voice Memos onto the desktop or into a folder, then add it here.' },
      { title: 'Music you bought without copy protection', body: DESKTOP_PROTECTED_HELP },
      { title: 'Vocal stems', body: DESKTOP_STEM_HELP },
      { title: 'Sound from a video', body: DESKTOP_VIDEO_HELP },
    ],
    waysSummary: `Ways to get a vocal onto ${where}`,
    guideTitle: `Getting a vocal onto ${where}`,
  };
}
