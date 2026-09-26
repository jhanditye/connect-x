// Built-in singer profiles, display metadata for every style dimension, and small helpers the
// comparison and coaching modules share.
//
// The targets are hand-set estimates, NOT measurements of the artists' recordings. They translate
// published descriptions (reviews, interviews, vocal-coach write-ups) and widely shared listening
// impressions onto the 0..1 anchors and units documented on StyleVector in src/types.ts. Where the
// sources are thin (vibrato, run speed, exact ranges) the bands are deliberately wide and the
// weights low, so an uncertain guess cannot dominate the overall match. A reference clip
// (coach/reference.ts) replaces these guesses with measured targets.
//
// Tolerance scale (distance outside the band at which a dimension scores 0), kept consistent with
// coach/reference.ts: 0.3 for 0..1 tone indices (0.25 for rasp), 0.35-0.4 for shares, 1.5 Hz for
// vibrato rate, 35 cents for vibrato width, 1 dB/semitone for loudness climb, 4 notes/s for
// agility, 10 dB for dynamic range, 25 cents for pitch accuracy, 3 per minute for flips.

import type { SingerProfile, StyleKey, TargetBand } from '../types';

/** Every StyleKey in a fixed display order (tone, vibrato, registers, dynamics, pitch). */
export const STYLE_KEYS: readonly StyleKey[] = [
  'breathiness',
  'brightness',
  'rasp',
  'vibratoPresence',
  'vibratoRateHz',
  'vibratoExtentCents',
  'chestInUpperRange',
  'mixInUpperRange',
  'headInUpperRange',
  'loudnessClimbDbPerSemitone',
  'agility',
  'dynamicRangeDb',
  'softOnsetRatio',
  'pitchAccuracyCents',
  'flipsPerMinute',
];

// ---------------------------------------------------------------------------------------------
// Number formatting shared by labels, comparison summaries and coaching copy

function trimZero(s: string): string {
  // "-0.0" and "-0" read as noise in copy.
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

export function fixed(v: number, digits: number): string {
  return trimZero(v.toFixed(digits));
}

export function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function signedFixed(v: number, digits: number): string {
  const s = fixed(v, digits);
  return v > 0 && s !== fixed(0, digits) ? `+${s}` : s;
}

/** The value as a compact number with its unit: "0.42", "38%", "5.4 Hz", "±35 cents", "+0.8 dB/semitone". */
export function formatStyleValue(key: StyleKey, v: number): string {
  switch (key) {
    case 'breathiness':
    case 'brightness':
    case 'rasp':
      return fixed(v, 2);
    case 'vibratoPresence':
    case 'chestInUpperRange':
    case 'mixInUpperRange':
    case 'headInUpperRange':
    case 'softOnsetRatio':
      return percent(v);
    case 'vibratoRateHz':
      return `${fixed(v, 1)} Hz`;
    case 'vibratoExtentCents':
      return `±${Math.round(Math.abs(v))} cents`;
    case 'loudnessClimbDbPerSemitone':
      return `${signedFixed(v, 1)} dB/semitone`;
    case 'agility':
      return `${fixed(v, 1)} notes/s`;
    case 'dynamicRangeDb':
      return `${Math.round(v)} dB`;
    case 'pitchAccuracyCents':
      return `${Math.round(v)} cents`;
    case 'flipsPerMinute':
      return `${fixed(v, 1)} per min`;
  }
}

/** True for dimensions whose describe() already contains the number (so copy need not repeat it). */
export function describeIncludesNumber(key: StyleKey): boolean {
  return key !== 'breathiness' && key !== 'brightness' && key !== 'rasp';
}

// ---------------------------------------------------------------------------------------------
// Style labels

export interface StyleLabel {
  label: string;
  /** '' for 0..1 indices; '%' for 0..1 shares (display value * 100); otherwise the physical unit. */
  unit: string;
  lowWord: string;
  highWord: string;
  describe: (v: number) => string;
}

function breathinessWords(v: number): string {
  // Bands follow the StyleVector anchors in src/types.ts. A low reading on its own means a clean,
  // firm tone; it only indicates pressed phonation together with a strongly negative H1-H2, which
  // this label cannot see, so it never says "pressed".
  if (v < 0.2) return 'very clean and firm';
  if (v < 0.3) return 'clean';
  if (v < 0.5) return 'clear and balanced';
  if (v < 0.6) return 'slightly airy';
  if (v < 0.8) return 'quite airy';
  if (v < 0.9) return 'very airy';
  return 'close to a whisper';
}

function brightnessWords(v: number): string {
  if (v < 0.2) return 'dark and covered';
  if (v < 0.35) return 'warm';
  if (v < 0.45) return 'warm-neutral';
  if (v < 0.6) return 'neutral';
  if (v < 0.7) return 'fairly bright';
  return 'bright and forward';
}

function raspWords(v: number): string {
  if (v < 0.15) return 'clean';
  if (v < 0.2) return 'mostly clean';
  if (v < 0.4) return 'slightly gritty';
  if (v < 0.6) return 'noticeably raspy';
  return 'heavily raspy';
}

function climbWords(v: number): string {
  const n = `${signedFixed(v, 1)} dB per semitone`;
  if (v < -0.2) return `${n}, getting quieter as you climb`;
  if (v <= 0.25) return `${n}, level as you climb`;
  if (v <= 0.8) return `${n}, a little louder as you climb`;
  if (v <= 1.3) return `${n}, clearly louder as you climb`;
  return `${n}, much louder as you climb`;
}

export const STYLE_LABELS: Record<StyleKey, StyleLabel> = {
  breathiness: { label: 'Breathiness', unit: '', lowWord: 'clear', highWord: 'airy', describe: breathinessWords },
  brightness: { label: 'Brightness', unit: '', lowWord: 'warm', highWord: 'bright', describe: brightnessWords },
  rasp: { label: 'Rasp', unit: '', lowWord: 'clean', highWord: 'raspy', describe: raspWords },
  vibratoPresence: {
    label: 'Vibrato on held notes',
    unit: '%',
    lowWord: 'straight',
    highWord: 'vibrato-rich',
    describe: (v) => (v <= 0.005 ? 'no vibrato on held notes' : `vibrato on ${percent(v)} of held notes`),
  },
  vibratoRateHz: {
    label: 'Vibrato speed',
    unit: 'Hz',
    lowWord: 'slow',
    highWord: 'fast',
    describe: (v) => `about ${fixed(v, 1)} Hz${v < 4.5 ? ', slow' : v > 6.8 ? ', fast' : ''}`,
  },
  vibratoExtentCents: {
    label: 'Vibrato width',
    unit: 'cents',
    lowWord: 'narrow',
    highWord: 'wide',
    describe: (v) => `about ±${Math.round(Math.abs(v))} cents${v < 20 ? ', narrow' : v > 70 ? ', wide' : ''}`,
  },
  chestInUpperRange: {
    label: 'Chest above the passaggio',
    unit: '%',
    lowWord: 'light',
    highWord: 'chest-heavy',
    describe: (v) => `${percent(v)} chest`,
  },
  mixInUpperRange: {
    label: 'Mix above the passaggio',
    unit: '%',
    lowWord: 'little mix',
    highWord: 'mostly mix',
    describe: (v) => `${percent(v)} mix`,
  },
  headInUpperRange: {
    label: 'Falsetto/head above the passaggio',
    unit: '%',
    lowWord: 'little falsetto',
    highWord: 'mostly falsetto',
    describe: (v) => `${percent(v)} falsetto/head`,
  },
  loudnessClimbDbPerSemitone: {
    label: 'Loudness climb',
    unit: 'dB/semitone',
    lowWord: 'level',
    highWord: 'pushing louder',
    describe: climbWords,
  },
  agility: {
    label: 'Run speed',
    unit: 'notes/s',
    lowWord: 'no or slow runs',
    highWord: 'fast runs',
    describe: (v) => (v <= 0.05 ? 'no runs' : `about ${fixed(v, 1)} notes per second in runs`),
  },
  dynamicRangeDb: {
    label: 'Dynamic range',
    unit: 'dB',
    lowWord: 'even',
    highWord: 'contrasting',
    describe: (v) => `${Math.round(v)} dB from soft to loud${v < 8 ? ', very even' : v > 24 ? ', very wide' : ''}`,
  },
  softOnsetRatio: {
    label: 'Soft (airy) onsets',
    unit: '%',
    lowWord: 'clean starts',
    highWord: 'airy starts',
    describe: (v) => `${percent(v)} of phrases start airy`,
  },
  pitchAccuracyCents: {
    label: 'Pitch accuracy',
    unit: 'cents',
    lowWord: 'precise',
    highWord: 'loose',
    describe: (v) => `about ${Math.round(v)} cents off on average`,
  },
  flipsPerMinute: {
    label: 'Register flips',
    unit: 'per min',
    lowWord: 'few flips',
    highWord: 'frequent flips',
    describe: (v) => (v <= 0.05 ? 'no register flips' : `about ${fixed(v, 1)} flips per minute`),
  },
};

// ---------------------------------------------------------------------------------------------
// Singer profiles

function band(ideal: number, low: number, high: number, tolerance: number, weight: number): TargetBand {
  return { ideal, low, high, tolerance, weight };
}

function sourceNote(name: string, pronoun: string): string {
  return (
    `These targets are hand-set estimates based on listening and on published descriptions of ${name}'s singing ` +
    `(reviews, interviews and vocal-coach write-ups). They are not measurements of ${pronoun} recordings, and range ` +
    `and voice-type figures quoted online disagree. For a measured target, add a reference clip of ${name} from ` +
    `music you own; isolated vocals work best.`
  );
}

const SHAWN: SingerProfile = {
  id: 'shawn-mendes',
  name: 'Shawn Mendes',
  tagline: 'Soft chest verses that build to a bright, chest-coloured mix, with falsetto for contrast.',
  description:
    'Shawn Mendes usually sings verses in a soft, speech-like chest voice, then builds to strong, bright choruses ' +
    'carried in a chest-dominant mix up around A4 to B♭4. Vocal coaches describe a little controlled grit on his ' +
    'loudest notes. He uses falsetto for contrast on hooks and final choruses, and has said he only figured out ' +
    'falsetto while writing "Where Were You in the Morning?". His phrasing is rhythmic and guitar-driven: he ' +
    'stretches key words and pulls back on the rest.',
  traits: [
    'Soft, speech-like chest voice in verses',
    'Bright, chest-dominant mix in choruses (around A4–B♭4 in his keys)',
    'Occasional controlled grit on the loudest peaks: seasoning, not the core sound',
    'Falsetto for contrast on tags and final choruses',
    'Mostly straight tone, with a moderate, fairly narrow vibrato at the ends of long notes (listening impression)',
    'Rhythmic, guitar-player phrasing',
  ],
  studySongs: [
    {
      title: 'Stitches',
      listenFor:
        'The step from a restrained low-chest verse to the belted chorus around A♭4. Notice how the vowels open ' +
        'and any grit appears only on the top notes (chest and mix above the passaggio, rasp, dynamic range).',
    },
    {
      title: 'Mercy',
      listenFor:
        'A quiet, breathier low verse, a pre-chorus crescendo, then a driven chest-mix chorus. A model for building ' +
        'volume gradually instead of getting loud early (dynamic range, loudness climb, breathiness).',
    },
    {
      title: 'Treat You Better',
      listenFor:
        'A syncopated chorus in a bright, chest-dominant mix in the upper-middle range. Listen for the forward ' +
        'vowels and crisp consonants on the groove (brightness, mix above the passaggio).',
    },
    {
      title: 'Where Were You in the Morning?',
      listenFor:
        'An unhurried, R&B-leaning delivery and bright falsetto in the last two choruses. He has said this is the ' +
        'song where he figured out falsetto (falsetto above the passaggio, register flips).',
    },
    {
      title: 'Lost in Japan',
      listenFor:
        'Funk-pop phrasing and the lingering high falsetto notes on the final chorus line (register flips, ' +
        'falsetto above the passaggio).',
    },
    {
      title: 'In My Blood',
      listenFor:
        'Falsetto and chest voice in the same song, and a build from an intimate verse to a full-voiced chorus ' +
        '(dynamic range, register flips).',
    },
  ],
  // Range sites mostly cite about G2 to B4/C#5 for his connected voice, with falsetto above. Song
  // ranges run from about B2 up to the A4-Bb4 chorus belts. Tessitura estimated at E3-F#4.
  typicalRange: { lowMidi: 43, highMidi: 73, tessituraLowMidi: 52, tessituraHighMidi: 66 },
  targets: {
    // Clear, forward choruses with little air; breathier only in quiet verses and falsetto.
    breathiness: band(0.35, 0.22, 0.48, 0.3, 0.6),
    // Warm low end but bright and forward choruses: the brightest of the three.
    brightness: band(0.62, 0.5, 0.75, 0.3, 0.7),
    // "Controlled rasp on belts" (coach sites). The band starts at 0 so a clean tone is always on-style
    // and the app never tells anyone to add grit.
    rasp: band(0.15, 0, 0.32, 0.25, 0.25),
    // Listening impression: mostly straight onsets, vibrato released on some long notes.
    vibratoPresence: band(0.4, 0.22, 0.58, 0.4, 0.35),
    // Pop-typical rate; no published figure, so wide band and low weight.
    vibratoRateHz: band(5.5, 4.9, 6.2, 1.5, 0.15),
    // "Moderate, fairly narrow" (listening impression).
    vibratoExtentCents: band(35, 22, 50, 35, 0.25),
    // Chest-dominant mix and belt in choruses: the most chest of the three, but not all chest.
    chestInUpperRange: band(0.4, 0.25, 0.58, 0.35, 0.75),
    // The chest-coloured mix is the defining chorus sound.
    mixInUpperRange: band(0.42, 0.28, 0.58, 0.35, 1),
    // Falsetto is a contrast colour on tags and final choruses. The three register ideals sum to 1.
    headInUpperRange: band(0.18, 0.06, 0.32, 0.35, 0.5),
    // Choruses build in intensity, but the lift comes from brightness, not volume (see the
    // bright-chest-mix move), so a level climb is on-style too. Above 0.8 dB/semitone reads as pushing
    // chest weight up, the same threshold as the health note; only top notes that fade away (below
    // -0.3) get "more" coaching.
    loudnessClimbDbPerSemitone: band(0.3, -0.3, 0.8, 1, 0.5),
    // Soft verses to strong choruses: the widest dynamics of the three.
    dynamicRangeDb: band(16, 11, 22, 10, 0.45),
    // Speech-like verse onsets, firmer at chorus peaks: few aspirated starts.
    softOnsetRatio: band(0.25, 0.1, 0.42, 0.4, 0.35),
    pitchAccuracyCents: band(5, 0, 15, 25, 0.5),
    // Occasional sudden drops into falsetto for contrast: once or twice a song, so a take without a
    // flip is still on-style.
    flipsPerMinute: band(1.2, 0, 2.5, 3, 0.35),
  },
  signatureMoves: [
    {
      id: 'shawn-verse-to-chorus-build',
      name: 'Verse-to-chorus build',
      description: 'Start the verse soft and speech-like in chest, then build to a bright, chest-coloured chorus without shouting.',
      howTo: [
        'Speak the verse lyric at a relaxed speaking pitch, then sing it at the same soft level with the same diction.',
        'Through the pre-chorus, add energy step by step: brighter vowels and steadier breath, not a jump in volume.',
        'In the chorus, aim the top notes forward on a slightly narrowed vowel ("ay" toward "eh", "ah" toward "uh").',
        'If a chorus note only works by shouting, move the song down a semitone or two.',
      ],
    },
    {
      id: 'shawn-bright-chest-mix',
      name: 'Bright chest-dominant mix',
      description: 'Carry speech-like strength just above the passaggio with a forward, buzzy "nay" quality instead of pulling full chest up.',
      howTo: [
        'Sing the chorus melody on "nay" at a moderate volume until it feels easy and buzzy.',
        'Keep the "nay" placement and swap in the lyrics, narrowing wide vowels on the top notes.',
        'Keep the volume roughly level as the line rises; let brightness carry it, not loudness.',
        'Check the analysis: loudness climbing more than about 0.8 dB per semitone means you are pushing.',
      ],
    },
    {
      id: 'shawn-falsetto-contrast',
      name: 'Falsetto contrast',
      description: 'Drop suddenly from full voice to a light falsetto on a tag or a final chorus line.',
      howTo: [
        'Pick the last line of a chorus and sing its top note in falsetto on "hoo" first.',
        'Lighten the note before the switch instead of pushing into it.',
        'Repeat until the falsetto note lands in tune, then put the words back.',
        'Use it once or twice per song so it stays a contrast.',
      ],
    },
    {
      id: 'shawn-rhythmic-phrasing',
      name: 'Guitar-driven phrasing',
      description: 'Stretch one key word per line and keep the words around it short and on the groove.',
      howTo: [
        'Tap or strum the groove and speak the lyric in rhythm before singing it.',
        'Choose one word per line to stretch; clip the words around it.',
        'Land consonants right on the beat in syncopated lines, as in the "Treat You Better" chorus.',
        'Record against the track and listen back for timing (the app does not measure timing).',
      ],
    },
  ],
  color: '#b97a12',
  source: 'builtin',
  sourceNote: sourceNote('Shawn Mendes', 'his'),
};

const DANIEL: SingerProfile = {
  id: 'daniel-caesar',
  name: 'Daniel Caesar',
  tagline: 'Hushed, velvety R&B: a breathy close-mic tone, falsetto hooks and gospel-rooted phrasing.',
  description:
    'Daniel Caesar grew up singing in church, and gospel shows in his chord language and occasional runs. His lead ' +
    'vocal is mostly hushed and intimate: a warm, slightly dark, often breathy tone sung close to the mic at low ' +
    'volume. Hooks and emotional peaks lift into a light falsetto rather than a belted high chest note. He keeps the ' +
    'dynamics narrow for most of a song and swells at gospel-style climaxes. His 2025 album Son of Spergy keeps ' +
    'some raw edges and small cracks rather than polishing them away.',
  traits: [
    'Breathy, close-mic delivery near speaking volume',
    'Warm, slightly dark midrange',
    'Falsetto hooks and choruses instead of belted high notes',
    'Soft, often aspirated phrase starts',
    'Short, intentional gospel-style runs and turns at phrase ends',
    'Sparing, gentle vibrato; falsetto often close to straight tone (listening impression)',
    'Narrow dynamics that swell at climaxes',
  ],
  studySongs: [
    {
      title: 'Get You (feat. Kali Uchis)',
      listenFor:
        'The slow, intimate verse, and how late and lightly the falsetto arrives at the emotional peaks (falsetto ' +
        'above the passaggio, breathiness, register flips).',
    },
    {
      title: 'Best Part (feat. H.E.R.)',
      listenFor:
        'Relaxed, low-effort onsets and a floating falsetto over the guitar. A model for soft sustained tones (soft ' +
        'onsets, breathiness, vibrato on held notes).',
    },
    {
      title: 'Japanese Denim',
      listenFor:
        'A falsetto chorus over a humming choir, and a bluesy, laid-back verse (falsetto above the passaggio, ' +
        'brightness).',
    },
    {
      title: 'Hold Me Down',
      listenFor:
        'His most openly gospel vocal: a raw, upward-reaching chorus. The song interpolates Kirk Franklin\'s ' +
        '"Hold Me Now" (dynamic range, run speed).',
    },
    {
      title: 'Blessed',
      listenFor:
        'Soft verse phrasing leading into a choir-and-piano breakdown. Practise keeping your line quiet enough to ' +
        'blend (dynamic range, soft onsets).',
    },
    {
      title: 'Who Knows',
      listenFor:
        'His recent, more unvarnished style (from the 2025 album Son of Spergy): a whispery, conversational ' +
        'delivery with raw edges (breathiness, soft onsets).',
    },
  ],
  // One range site gives C#3 to F#5, with full voice to about G#4 and falsetto above. Melodies sit
  // in a comfortable middle range; tessitura estimated at G3-G4.
  typicalRange: { lowMidi: 49, highMidi: 78, tessituraLowMidi: 55, tessituraHighMidi: 67 },
  targets: {
    // Breathy, hushed, close-mic delivery: the airiest of the three and the most defining trait.
    breathiness: band(0.68, 0.55, 0.82, 0.3, 1),
    // Warm, slightly dark midrange.
    brightness: band(0.35, 0.22, 0.48, 0.3, 0.6),
    // Essentially clean; rawness is cracks and thin edges, not grit.
    rasp: band(0.06, 0, 0.2, 0.25, 0.3),
    // Vibrato used sparingly; falsetto lines near straight tone (listening impression).
    vibratoPresence: band(0.22, 0.08, 0.4, 0.4, 0.4),
    // Gentle and unhurried where present; no published figure.
    vibratoRateHz: band(5.2, 4.5, 5.9, 1.5, 0.15),
    // Small, gentle vibrato.
    vibratoExtentCents: band(22, 10, 35, 35, 0.25),
    // Rarely carries chest up; lighter TA-reduced mix and falsetto instead.
    chestInUpperRange: band(0.15, 0.03, 0.3, 0.35, 0.6),
    mixInUpperRange: band(0.35, 0.2, 0.5, 0.35, 0.6),
    // Hooks and peaks lift into falsetto. The three register ideals sum to 1.
    headInUpperRange: band(0.5, 0.33, 0.7, 0.35, 0.85),
    // Stays level or gets softer going up into falsetto.
    loudnessClimbDbPerSemitone: band(0.1, -0.4, 0.45, 1, 0.5),
    // Short, controlled gospel runs. Only Daniel targets run speed; weight is low because many takes
    // simply contain no runs (agility is then 0).
    agility: band(6, 4, 8.5, 4, 0.2),
    // Narrow, quiet dynamics for most of a song.
    dynamicRangeDb: band(10, 6, 14, 10, 0.45),
    // Soft, often breathy onsets: the most aspirated starts of the three.
    softOnsetRatio: band(0.6, 0.4, 0.85, 0.4, 0.7),
    pitchAccuracyCents: band(5, 0, 15, 25, 0.45),
    // Frequent flips into falsetto on hooks.
    flipsPerMinute: band(2.5, 1.2, 4.5, 3, 0.5),
  },
  signatureMoves: [
    {
      id: 'daniel-hushed-close-mic',
      name: 'Hushed close-mic delivery',
      description: 'Sing at or below speaking volume with air in the tone, as if singing to one person in a quiet room.',
      howTo: [
        'Keep your usual 20–30 cm from the mic or phone and sing at speaking volume or softer; the intimacy comes from the low volume, not from moving closer.',
        'Start each phrase on a quiet "h" so the air arrives just before the tone.',
        'Keep the jaw loose and the vowels rounded and warm.',
        'Let phrase ends fade out on air instead of cutting them off.',
      ],
    },
    {
      id: 'daniel-falsetto-hook',
      name: 'Falsetto on the hook',
      description: 'Lift the hook\'s top notes into a light, airy falsetto instead of belting them.',
      howTo: [
        'Sing the hook\'s top note in falsetto on a soft "hoo" before adding the words.',
        'Enter falsetto late and lightly: drop the volume a little on the note before.',
        'Let some air into the falsetto, but keep the pitch centred.',
        'Come back down into a soft, rounded middle voice without a bump in volume.',
      ],
    },
    {
      id: 'daniel-gospel-turn',
      name: 'Short gospel turn',
      description: 'A brief, controlled run or turn on the last word of a phrase.',
      howTo: [
        'Learn a four- or five-note pentatonic turn slowly on "ah".',
        'Speed it up only while every note stays clear.',
        'Keep it light and quiet, and put it on the last word of a phrase.',
        'Use one per section, not one per line.',
      ],
    },
    {
      id: 'daniel-behind-the-beat',
      name: 'Laid-back timing',
      description: 'Sit slightly behind the beat for a relaxed, conversational feel (a listening impression, not a measured trait).',
      howTo: [
        'Speak the lyric over the groove first, relaxed, as if talking.',
        'Let the first word of each phrase land a fraction after the beat.',
        'Keep consonants soft so the late placement sounds relaxed rather than late.',
        'Record against the track and compare with the original (the app does not measure timing).',
      ],
    },
  ],
  color: '#3a7556',
  source: 'builtin',
  sourceNote: sourceNote('Daniel Caesar', 'his'),
};

const JALEN: SingerProfile = {
  id: 'jalen-ngonda',
  name: 'Jalen Ngonda',
  tagline: 'Vintage soul falsetto: sweet, sustained and controlled, with gritty chest wails at the climax.',
  description:
    'Jalen Ngonda sings in the tradition of Smokey Robinson, Curtis Mayfield and Marvin Gaye, singers he names as ' +
    'influences. Much of his lead singing sits high, in a sweet, clear, well-controlled falsetto that often carries ' +
    'whole lines, with a slight tremble on held notes. For contrast he switches to a reedier, grittier chest voice ' +
    'for climaxes, with the odd growl. Reviewers point to his restraint: devotional, Motown-style phrasing ' +
    'rather than long runs.',
  traits: [
    'Lead falsetto that carries whole lines, sweet and clear rather than breathy',
    'Steady, controlled sustain with a slight, quick tremble on held notes',
    'Grittier chest "wails" and occasional growls saved for climaxes',
    'Restrained, devotional Motown-style phrasing',
    'Short \'60s-soul ornaments (scoops, slides and turns) rather than long runs',
    'Forward, ringing placement in falsetto',
  ],
  studySongs: [
    {
      title: 'Come Around and Love Me',
      listenFor:
        'A soaring falsetto lead over strings and vibraphone. Listen for how steady it is and for the gentle ' +
        'tremble on held notes (falsetto above the passaggio, vibrato on held notes).',
    },
    {
      title: "If You Don't Want My Love",
      listenFor:
        'Sustained falsetto and Smokey-style devotional phrasing. Good for practising falsetto that stays supported ' +
        'rather than breathy (breathiness, brightness, pitch accuracy).',
    },
    {
      title: "That's All I Wanted From You",
      listenFor:
        'His grittier chest voice over a Motown-style groove, and the dynamic build in the bridge (chest above the ' +
        'passaggio, dynamic range, rasp).',
    },
    {
      title: 'It Takes a Fool',
      listenFor: 'A delicate, restrained tone over a slinky bass line. Study the soft, clean onsets (soft onsets, breathiness).',
    },
    {
      title: "Just As Long As We're Together",
      listenFor:
        'Sweet mid-tempo soul phrasing. Compare where he uses a light mix and where he goes to falsetto (mix and ' +
        'falsetto above the passaggio, register flips).',
    },
    {
      title: 'Burning Temptation',
      listenFor:
        'A neo-Motown groove that pulls back so he can wail. The full-voiced climax contrasts with his falsetto ' +
        'elsewhere (chest above the passaggio, dynamic range).',
    },
  ],
  // No reliable note-by-note range data was found. Estimate from listening: a high-sitting voice with
  // falsetto-led lines. These numbers are the least certain of the three profiles.
  typicalRange: { lowMidi: 50, highMidi: 77, tessituraLowMidi: 60, tessituraHighMidi: 71 },
  targets: {
    // Falsetto reads airier than chest acoustically, but his is described as sweet and supported,
    // so the ideal sits between Shawn's clear chest-mix and Daniel's hushed tone.
    breathiness: band(0.46, 0.34, 0.58, 0.3, 0.6),
    // Forward, ringing falsetto; a reedier chest. Brighter than Daniel, a touch less than Shawn.
    brightness: band(0.56, 0.44, 0.68, 0.3, 0.55),
    // "A hint of grit" and growls at climaxes; clean most of the time. Low edge 0 for safety.
    rasp: band(0.1, 0, 0.28, 0.25, 0.25),
    // "Trembling" falsetto on held notes: the most vibrato of the three.
    vibratoPresence: band(0.6, 0.42, 0.8, 0.4, 0.55),
    // Quick, fairly narrow vibrato in the '60s soul-falsetto lineage (listening impression).
    vibratoRateHz: band(6, 5.3, 6.8, 1.5, 0.35),
    vibratoExtentCents: band(28, 16, 42, 35, 0.3),
    // Chest reserved for climaxes.
    chestInUpperRange: band(0.14, 0.03, 0.28, 0.35, 0.55),
    // Tends to commit to falsetto rather than hold a mix up high: the least mix of the three.
    mixInUpperRange: band(0.2, 0.08, 0.35, 0.35, 0.5),
    // Falsetto is the centre of his sound: the most head/falsetto of the three and the heaviest weight.
    headInUpperRange: band(0.66, 0.5, 0.85, 0.35, 1),
    // Controlled, even falsetto lines.
    loudnessClimbDbPerSemitone: band(0.2, -0.2, 0.55, 1, 0.45),
    // Restraint, with fuller moments in bridges and climaxes.
    dynamicRangeDb: band(13, 9, 18, 10, 0.35),
    // Gentle but clean falsetto entries.
    softOnsetRatio: band(0.3, 0.12, 0.5, 0.4, 0.35),
    // "Expertly controlled" falsetto: tuning matters a little more here.
    pitchAccuracyCents: band(5, 0, 15, 25, 0.6),
    // Stays in falsetto for long stretches, so fewer switches than Daniel, and none is fine.
    flipsPerMinute: band(1, 0, 2.2, 3, 0.3),
  },
  signatureMoves: [
    {
      id: 'jalen-sustained-falsetto',
      name: 'Sustained soul falsetto',
      description: 'Hold a whole line in a sweet, supported falsetto with a forward, ringing placement.',
      howTo: [
        'Find falsetto on a light "ng" hum a little above your passaggio.',
        'Keep the airflow steady so the tone stays clear, not breathy: think of a thin, bright line.',
        'Open to the vowel while keeping the buzz at the front of your face.',
        'Hold the note straight at first and let a small, quick vibrato arrive near the end.',
      ],
    },
    {
      id: 'jalen-chest-wail',
      name: 'Chest wail at the climax',
      description: 'Contrast soft falsetto with a fuller, reedy chest-mix cry on one climactic line.',
      howTo: [
        'Pick one climactic line; keep everything before it in falsetto.',
        'Sing the climax in a bright "nay"-style mix at moderate volume, not a shout.',
        'Put the emotion into the vowel and a slight cry quality, not throat pressure. Any grit is optional and light.',
        'Go back to falsetto afterwards to frame it.',
      ],
    },
    {
      id: 'jalen-motown-phrasing',
      name: 'Devotional Motown phrasing',
      description: 'Restrained, swooning phrasing with small scoops and slides into held falsetto notes.',
      howTo: [
        'Speak the lyric softly and sincerely, as if singing to one person.',
        'Scoop gently into a held note from just below the pitch, then settle right in the centre.',
        'Keep ornaments short: a slide or a turn, not a run.',
        'Hold back volume; let the sustained notes carry the feeling.',
      ],
    },
  ],
  color: '#b23c49',
  source: 'builtin',
  sourceNote: sourceNote('Jalen Ngonda', 'his'),
};

export const SINGERS: SingerProfile[] = [SHAWN, DANIEL, JALEN];

export function getProfile(id: string): SingerProfile | undefined {
  return SINGERS.find((p) => p.id === id);
}

/**
 * Style dimensions each signature move exercises, and which way the move pushes each one ('more' =
 * raises it). The coaching plan uses them to personalise the signature-move hints, and only
 * recommends a move for a dimension the take needs to move the same way. Moves mapped to {} are
 * about things the app does not measure (timing).
 */
export const MOVE_FOCUS: Record<string, Partial<Record<StyleKey, 'more' | 'less'>>> = {
  'shawn-verse-to-chorus-build': { dynamicRangeDb: 'more', loudnessClimbDbPerSemitone: 'less' },
  'shawn-bright-chest-mix': { mixInUpperRange: 'more', chestInUpperRange: 'more', brightness: 'more', loudnessClimbDbPerSemitone: 'less' },
  'shawn-falsetto-contrast': { flipsPerMinute: 'more', headInUpperRange: 'more' },
  'shawn-rhythmic-phrasing': {},
  'daniel-hushed-close-mic': { breathiness: 'more', softOnsetRatio: 'more', dynamicRangeDb: 'less', brightness: 'less' },
  'daniel-falsetto-hook': { headInUpperRange: 'more', flipsPerMinute: 'more', chestInUpperRange: 'less' },
  'daniel-gospel-turn': { agility: 'more' },
  'daniel-behind-the-beat': {},
  'jalen-sustained-falsetto': { headInUpperRange: 'more', breathiness: 'less', vibratoPresence: 'more', vibratoRateHz: 'more' },
  'jalen-chest-wail': { chestInUpperRange: 'more', dynamicRangeDb: 'more' },
  'jalen-motown-phrasing': { pitchAccuracyCents: 'less', dynamicRangeDb: 'less' },
};

/**
 * The builtin singer a profile is (or was built from). Reference profiles copy their base
 * profile's signature moves, so a shared move id identifies the base. Undefined for a reference
 * profile made without a base.
 */
export function builtinBaseOf(profile: Pick<SingerProfile, 'id' | 'signatureMoves'>): SingerProfile | undefined {
  const direct = getProfile(profile.id);
  if (direct) return direct;
  const moveIds = new Set(profile.signatureMoves.map((m) => m.id));
  return SINGERS.find((s) => s.signatureMoves.some((m) => moveIds.has(m.id)));
}

/** How copy refers to the profile: "Shawn" for builtins, "the reference" for reference-clip profiles. */
export function whoOf(profile: Pick<SingerProfile, 'name' | 'source'>): string {
  if (profile.source === 'reference') return 'the reference';
  return profile.name.split(/\s+/)[0] || profile.name;
}

/** "Shawn's" / "the reference's". */
export function whoseOf(profile: Pick<SingerProfile, 'name' | 'source'>): string {
  return `${whoOf(profile)}'s`;
}
