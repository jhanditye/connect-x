// Turns a comparison into a prioritised, singer-specific coaching plan.
//
// The technique cues come from a content matrix indexed by dimension x direction, with extra cues
// for each builtin singer. Everything is phrased to be vocally safe: no cue asks for more volume or
// effort. When a dimension wants "more" (more chest, a steeper climb) the cues work through vowel
// shape, how firmly the vocal folds meet, and brightness, never pushing. As a backstop, the plan
// never coaches toward more rasp, or toward chest weight or a loudness climb that its own health
// notes call pushing, whatever the target profile (reference clips of full mixes can ask for both).

import { midiToNoteName } from '../dsp/music';
import type {
  AnalysisIssue,
  CoachingItem,
  CoachingPlan,
  Comparison,
  DimensionResult,
  Direction,
  SingerProfile,
  StyleKey,
  TargetBand,
  VoiceAnalysis,
} from '../types';
import { describeWithNumber, isScoreable, keyAdviceNames, singerPassaggioLow } from './compare';
import { getExercise } from './exercises';
import {
  MOVE_FOCUS,
  STYLE_LABELS,
  builtinBaseOf,
  describeIncludesNumber,
  fixed,
  formatStyleValue,
  percent,
  signedFixed,
  whoOf,
  whoseOf,
} from './profiles';

export type Flavour = 'shawn' | 'daniel' | 'jalen' | 'generic';
type FixDirection = 'more' | 'less';

/** Dimensions scoring below this become coaching items (inside the band always scores >= 80). */
const ITEM_SCORE_THRESHOLD = 78;
const STRENGTH_SCORE = 80;
const MAX_DIMENSION_ITEMS = 4;
const MAX_ITEMS = 5;
/**
 * Register items that coach the same move from different sides, so their cues and drills repeat:
 * releasing the top into falsetto ("more falsetto", "less mix"), or connecting a light top back to
 * a fuller sound ("more chest", "less falsetto", "more mix"). A plan keeps one item per group.
 */
const REGISTER_GROUP: Record<string, 'release' | 'connect'> = {
  'headInUpperRange-more': 'release',
  'mixInUpperRange-less': 'release',
  'chestInUpperRange-more': 'connect',
  'headInUpperRange-less': 'connect',
  'mixInUpperRange-more': 'connect',
};
/** The only measures a speech-like take can support: tone colour, not registers, vibrato or runs. */
const SPEECH_RELIABLE = new Set<StyleKey>(['breathiness', 'brightness', 'rasp']);
/** Transposition (semitones) at which key advice becomes its own item. */
const RANGE_ITEM_SEMITONES = 3;
/** Loudness climb (dB/semitone) above which the voice is being pushed; health notes flag it. */
const PUSHING_CLIMB_DB = 0.8;
/** Share of chest above the passaggio above which the take is carrying heavy chest; health notes flag it. */
const HEAVY_CHEST_SHARE = 0.6;

function flavourOf(profile: SingerProfile): Flavour {
  switch (builtinBaseOf(profile)?.id) {
    case 'shawn-mendes':
      return 'shawn';
    case 'daniel-caesar':
      return 'daniel';
    case 'jalen-ngonda':
      return 'jalen';
    default:
      return 'generic';
  }
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

/** A value as a short number for running text; a take without runs reads "no runs", not "0.0 notes/s". */
function compactValue(key: StyleKey, v: number): string {
  return key === 'agility' && v <= 0.05 ? 'no runs' : formatStyleValue(key, v);
}

/**
 * A run-speed or flip-rate target of zero (a reference clip without runs or flips): copy says
 * "no runs" / "no register flips", not "0.0 notes/s" / "0.0 per min".
 */
const NONE_WORDS: Partial<Record<StyleKey, string>> = { agility: 'no runs', flipsPerMinute: 'no register flips' };

function noneTarget(key: StyleKey, t: TargetBand): boolean {
  return key in NONE_WORDS && t.ideal <= 0.05;
}

/** "62% vs about 38%" / "7.5 notes/s vs no runs": the take against the target, for running text. */
function versusTarget(d: DimensionResult, take: string): string {
  return noneTarget(d.key, d.target) ? `${take} vs ${NONE_WORDS[d.key]}` : `${take} vs about ${formatStyleValue(d.key, d.target.ideal)}`;
}

/** Words plus number without nested brackets: "quite airy, 0.68" / "62% chest". */
function wordsAndNumber(key: StyleKey, v: number): string {
  const words = STYLE_LABELS[key].describe(v);
  return describeIncludesNumber(key) ? words : `${words}, ${formatStyleValue(key, v)}`;
}

/** Lower-cases a title-style name for mid-sentence use, leaving acronyms ("R&B") and quotes alone. */
function nameInSentence(name: string): string {
  return /^[A-Z][a-z]/.test(name) ? lowerFirst(name) : name;
}

/**
 * What copy addressed to the user calls the light upper register. Most teachers call it falsetto in
 * male voices and head voice in female voices (alto and up), so every instruction to the user (cues,
 * singer cues, signature-move steps, drill names) follows the user's voice type. Descriptions of the
 * three (male) artists' own register ("Jalen's falsetto", "his falsetto") keep "falsetto".
 */
type LightWord = 'falsetto' | 'head voice';

function lightWordFor(analysis: Pick<VoiceAnalysis, 'passaggio'>): LightWord {
  return analysis.passaggio.lowMidi >= 67 ? 'head voice' : 'falsetto';
}

function withLightWord(text: string, light: LightWord): string {
  if (light === 'falsetto') return text;
  return text
    .replace(/falsetto or head voice/g, 'head voice')
    .replace(/falsetto\/head/g, 'head voice')
    // no regex lookbehind (iOS before 16.4 cannot parse it): a "'s " / "his " prefix is captured and the match is left alone
    .replace(/((?:'s|\bhis) )?\b([Ff])alsetto\b/g, (m: string, pre: string | undefined, c: string) => (pre ? m : c === 'F' ? 'Head voice' : 'head voice'));
}

/**
 * An instruction worded for the user's voice type: "falsetto" becomes "head voice" for alto,
 * mezzo and soprano. The Results page applies it to the signature-move steps it lists, so they match
 * the "Start here" step in the plan's hints.
 */
export function forUserVoice(text: string, analysis: Pick<VoiceAnalysis, 'passaggio'>): string {
  return withLightWord(text, lightWordFor(analysis));
}

/**
 * True for a "more" gap the plan must not coach toward: more rasp (never manufactured), or chest
 * weight / a loudness climb beyond what the health notes call pushing, judged on both the take and
 * the target (a reference clip can target either).
 */
function isUnsafeMore(d: DimensionResult): boolean {
  if (d.direction !== 'more') return false;
  const v = d.value ?? NaN;
  switch (d.key) {
    case 'rasp':
      return true;
    case 'loudnessClimbDbPerSemitone':
      return v > PUSHING_CLIMB_DB || d.target.ideal > PUSHING_CLIMB_DB;
    case 'chestInUpperRange':
      return v > HEAVY_CHEST_SHARE || d.target.ideal > HEAVY_CHEST_SHARE;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Content matrix: how to fix each dimension in each direction

interface FixCell {
  /** Imperative title. */
  title: string;
  /** Technique cues that apply to any target singer, most useful first. */
  cues: string[];
  /** Singer-specific cues, placed before the general ones. */
  singerCues?: Partial<Record<Flavour, string[]>>;
  exercises: string[];
  /** Singer-specific exercise preferences, placed before the general ones. */
  singerExercises?: Partial<Record<Flavour, string[]>>;
  /**
   * Cues that would contradict another item while the take needs `key` to go `dir` (for example
   * "not an 'h'" next to an item asking for airy onsets). Matching cues are dropped and `instead`
   * goes in after the singer cues.
   */
  conflicts?: { key: StyleKey; dir: FixDirection | 'ok'; drop: RegExp; instead: string[] }[];
}

export const FIXES: Record<StyleKey, Record<FixDirection, FixCell>> = {
  breathiness: {
    more: {
      title: 'Let more air into the tone',
      cues: [
        'Start each phrase on a quiet "h" and let a little of that air stay in the tone for the first word.',
        'Bring the volume down a notch: an airy tone lives between speaking and soft singing, not at full voice.',
        'Sigh the phrase on "hah" first, then sing it with the same easy airflow.',
        'Keep your usual 20–30 cm from the mic and let the softness come from lower volume, not from moving closer: takes only compare fairly at the same distance.',
      ],
      singerCues: {
        daniel: [
          'Sing as if to one person in a quiet room, at about speaking level with air in the tone, the way Daniel sings his verses.',
          'Let the ends of phrases fade out on air instead of cutting them off.',
        ],
        shawn: ['Use the airier, speech-like tone for quiet verses and save the clearer tone for the chorus, as Shawn does.'],
        jalen: ['In falsetto, allow a soft edge of air as the note starts, then let it clear as the note settles.'],
      },
      exercises: ['aspirate-onsets', 'airy-falsetto-float', 'straw-phonation-slides'],
      // With phrase starts that need to be cleaner, the air goes into the tone, not in front of it.
      conflicts: [
        {
          key: 'softOnsetRatio',
          dir: 'less',
          drop: /quiet "h"|as the note starts/,
          instead: ['Start phrases cleanly, then let a little air into the tone once the note is going.'],
        },
      ],
    },
    less: {
      title: 'Clear up the tone',
      cues: [
        'Let your vocal folds meet a little more fully, without pressing: sing the phrase on "nay" or "nee" first, then go back to the words with the same buzz.',
        'Use less air rather than more push. Picture the tone as a thin, focused line instead of a sigh.',
        'Start notes with a balanced onset (air and sound together), not an "h".',
        'Brighten the vowel slightly (toward "eh" or "ih") so the tone has more of a core.',
      ],
      singerCues: {
        jalen: [
          'Hum the line on "ng" to find a clear, ringing falsetto like Jalen\'s, then open to the vowel without letting air in.',
        ],
        shawn: ['For choruses, find the clearer, forward chest-mix of "nay" and keep that clarity on the words, as Shawn does.'],
        daniel: ['Keep some air, but make sure the pitch centre is clearly audible under it: even Daniel\'s airy sound has a core.'],
      },
      exercises: ['balanced-onsets', 'nay-bright-mix', 'straw-phonation-slides'],
      singerExercises: { jalen: ['soul-falsetto-forward'] },
      // With phrase starts that need more air, or airy starts that already match the singer, a light
      // "h" in front of the first word is fine: only the rest of the note needs to clear up.
      conflicts: [
        {
          key: 'softOnsetRatio',
          dir: 'more',
          drop: /not an "h"/,
          instead: ['Keep any "h" to the very start of a phrase; once the note is going, the tone itself should be clear.'],
        },
        {
          key: 'softOnsetRatio',
          dir: 'ok',
          drop: /not an "h"/,
          instead: ['Keep any "h" to the very start of a phrase; once the note is going, the tone itself should be clear.'],
        },
      ],
    },
  },
  brightness: {
    more: {
      title: 'Brighten the sound and bring it forward',
      cues: [
        'Lift the cheeks slightly, as in a small inner smile, and think of the vowel sitting just behind your top teeth.',
        'Narrow wide vowels a little ("ah" toward "uh", "ay" toward "eh"). That adds ring without extra volume.',
        'Sing the line on a bratty "nyah", then keep that forward buzz when you go back to the words.',
        'Don\'t press the larynx down to sound deeper; let it sit where it does when you speak.',
      ],
      singerCues: {
        shawn: ['Sing a Shawn chorus line on "nay", aim the sound at the front of your face with a loose jaw, then keep that ring on the words.'],
        jalen: ['Keep a bright "ee"-like placement even on open vowels, so the falsetto rings the way Jalen\'s does.'],
      },
      exercises: ['nay-bright-mix', 'ng-siren', 'vowel-narrowing'],
      singerExercises: { jalen: ['soul-falsetto-forward'] },
    },
    less: {
      title: 'Make the tone warmer and rounder',
      cues: [
        'Round the mouth shape a little, as if there were an "oh" inside the "ah".',
        'Release the smile and the tongue, and let the soft palate lift as at the start of a yawn, without pressing the larynx down.',
        'Take the volume down slightly; brightness often climbs with effort.',
        'Hum the phrase first, then open into the words, keeping the warm quality of the hum.',
      ],
      singerCues: {
        daniel: [
          'Sing at low volume with rounded vowels, as if to someone beside you, for Daniel\'s warm, slightly dark middle.',
        ],
      },
      exercises: ['mum-five-tone', 'octave-slide-wee-oo', 'airy-falsetto-float'],
    },
  },
  rasp: {
    more: {
      title: 'Add texture lightly, if at all',
      cues: [
        'Treat grit as optional seasoning: get the clean, easy version of the phrase right first.',
        'If you add texture, add it only to one or two peak words, at moderate volume, with an open "silent laugh" throat. Never squeeze.',
        'Try the light-texture drill for a couple of minutes at most, and stop at once if anything scratches, tickles or hurts.',
      ],
      singerCues: {
        shawn: ['Sing the verses completely clean; if you add texture at all, keep it to the top of one chorus note, as Shawn does.'],
        jalen: ['Keep every line clean and sweet; if you add a growl at all, save it for one climactic word, as Jalen does.'],
      },
      exercises: ['light-texture-onset', 'balanced-onsets', 'straw-phonation-slides'],
    },
    less: {
      title: 'Take the grit out',
      cues: [
        'Sing the phrase clean and a little softer until it feels easy.',
        'Reset with a few minutes of straw phonation or lip trills before singing the song again.',
        'Keep the throat open with a "silent laugh" feeling instead of squeezing.',
        'If the rasp is there even when you sing softly or speak, rest and drink water. See an ENT doctor if hoarseness lasts two weeks or more.',
      ],
      singerCues: {
        daniel: ['Sing the line clean; if you want Daniel-style rawness, let one word crack softly or thin out, and never add grit.'],
        jalen: ['Sing every line clean and sweet, and save any growl for one climactic word, as Jalen does.'],
        shawn: ['Sing the verses completely clean and keep any grit to a brief colour on one or two chorus peaks, as Shawn does.'],
      },
      exercises: ['straw-phonation-slides', 'lip-trill-siren', 'balanced-onsets'],
    },
  },
  vibratoPresence: {
    more: {
      title: 'Let vibrato in on held notes',
      cues: [
        'On held notes, start straight and then let the note relax into a gentle wobble. Don\'t make it with the jaw or the stomach.',
        'Keep the airflow steady and the throat free on long notes; vibrato appears more easily when nothing is held tight.',
        'Practise slow half-step pulses and speed them up until they turn into vibrato.',
      ],
      singerCues: {
        jalen: ['Practise sustained falsetto "hoo" notes and let a slight, quick tremble arrive by itself, as on Jalen\'s held notes.'],
        shawn: ['Hold long chorus notes straight for the first beat, then let the vibrato in at the end, as Shawn does.'],
      },
      exercises: ['vibrato-pulses', 'straight-then-vibrato', 'messa-di-voce'],
      singerExercises: { jalen: ['soul-falsetto-forward'] },
    },
    less: {
      title: 'Hold notes straighter before any vibrato',
      cues: [
        'Hold notes straight for longer and decide where vibrato appears, rather than letting it run on every note.',
        'Save vibrato for the last beat of long notes.',
        'Keep short notes plain and speech-like.',
      ],
      singerCues: {
        daniel: ['Sing falsetto lines almost straight and let any vibrato come late and small, as Daniel does.'],
        shawn: ['Start every note straight and treat vibrato as a release at the end, as Shawn does, not a constant.'],
      },
      exercises: ['straight-then-vibrato', 'drone-tuning'],
    },
  },
  vibratoRateHz: {
    more: {
      title: 'Free up a quicker vibrato',
      cues: [
        'A slow wobble often comes from too much weight: lighten the note and bring the volume down a little.',
        'Do the pulse drill: begin with slow half-step pulses and speed them up gradually to about five or six a second.',
        'Keep the jaw and tongue still. The vibrato should come from a free, balanced voice, not from movement.',
      ],
      singerCues: {
        jalen: ['For Jalen\'s quick shimmer, sing the held note lighter and a little quieter and let the vibrato speed up on its own.'],
      },
      exercises: ['vibrato-pulses', 'straight-then-vibrato', 'lip-trill-siren'],
    },
    less: {
      title: 'Relax a fast, tight vibrato',
      cues: [
        'A fast, tight flutter usually means tension. Release the jaw, tongue and neck and let the note spin more slowly.',
        'Sing the note on a lip trill first, then sing it with the same looseness.',
        'Do the pulse drill at a slower tempo, around four or five pulses a second.',
      ],
      singerCues: {
        daniel: ['Let any vibrato be slow and small, as Daniel\'s is; if it flutters, straighten the note instead.'],
      },
      exercises: ['straw-phonation-slides', 'vibrato-pulses', 'lip-trill-siren'],
    },
  },
  vibratoExtentCents: {
    more: {
      title: 'Let the vibrato swing a little wider',
      cues: [
        'Relax the throat on held notes so the oscillation can swing a bit more freely.',
        'Don\'t clamp the pitch in place; let the note breathe around its centre.',
        'Pulse half-steps slowly, then let them blend into a vibrato of similar width.',
      ],
      exercises: ['vibrato-pulses', 'straight-then-vibrato'],
    },
    less: {
      title: 'Narrow the vibrato',
      cues: [
        'Lighten the weight on held notes; wide wobbles usually come from too much push or volume.',
        'Aim for a narrow shimmer: think of spinning the note rather than shaking it.',
        'Hold the note straight for a moment first, then allow only a small vibrato.',
      ],
      singerCues: {
        jalen: ['On held notes, keep the tremble small and quick, a shimmer rather than a swing, as on Jalen\'s falsetto lines.'],
        daniel: ['Keep any vibrato barely there: small, late and gentle, as Daniel does.'],
        shawn: ['Hold chorus notes straight and let only a small vibrato in at the very end, as Shawn does.'],
      },
      exercises: ['straight-then-vibrato', 'drone-tuning', 'messa-di-voce'],
    },
  },
  chestInUpperRange: {
    more: {
      title: 'Carry more speech-like strength up top',
      cues: [
        'Speak the high line at a lively speaking pitch first, then sing it with the same connection.',
        'Use "nay" or "gug" to keep your vocal folds meeting firmly as you climb, instead of flipping to a light, airy falsetto.',
        'Keep the volume moderate: chest colour comes from vocal folds that meet a little more firmly and a brighter vowel, not from shouting.',
        'Only go as high as stays comfortable. If it pinches, back off or move the song down.',
      ],
      singerCues: {
        shawn: [
          'Build Shawn\'s chest-coloured chorus sound on "nay" just above your passaggio, at a moderate volume, before adding the words.',
        ],
        jalen: ['Practise a fuller, reedy chest-mix like Jalen\'s on one climactic line, bright and moderate in volume, never shouted.'],
      },
      exercises: ['gee-gug-connected-mix', 'nay-bright-mix', 'blended-leap'],
    },
    less: {
      title: 'Lighten the weight above the passaggio',
      cues: [
        'Let the weight drop off note by note as you climb above your passaggio.',
        'Narrow the vowels on the high notes ("ah" toward "uh", "ay" toward "eh").',
        'Keep the volume level as you go up instead of getting louder.',
        'Keep your head level and your neck long; don\'t reach up with the chin.',
      ],
      singerCues: {
        shawn: ['Keep the core of the note but lose some weight: even Shawn\'s strongest choruses are a mix, not shouted chest.'],
        daniel: ['As the line rises past your passaggio, drop the volume a notch and let each note get lighter, as Daniel does, until the top ones float.'],
        jalen: ['Save chest for one climactic line and let every other high note go light, as Jalen does.'],
      },
      exercises: ['lip-trill-siren', 'level-volume-scale', 'vowel-narrowing', 'mum-five-tone'],
    },
  },
  mixInUpperRange: {
    more: {
      title: 'Blend into mix through the passaggio',
      cues: [
        'Slide on a lip trill or through a straw from chest up through the passaggio without letting it break or get louder.',
        'Sing "gug" or "nay" scales: they keep the connection while the weight drops off.',
        'Narrow the vowel on the top notes instead of opening wider.',
        'Keep the volume moderate. Mix comes from balance, not effort.',
      ],
      singerCues: {
        shawn: ['Build the mix on "nay", bright, speech-like and connected, then sing Shawn\'s words with the same buzz.'],
        daniel: ['Keep the mix quiet and light, as Daniel does, so the step up into falsetto stays smooth.'],
      },
      exercises: ['lip-trill-siren', 'gee-gug-connected-mix', 'mum-five-tone', 'falsetto-bridge-down'],
      singerExercises: { shawn: ['nay-bright-mix'] },
    },
    less: {
      title: 'Let the top notes release into falsetto',
      cues: [
        'Let the highest notes of a phrase release fully into falsetto instead of holding them in a mix.',
        'Lighten the start of high notes with a tiny "h" and let the tone float.',
        'Practise deliberate flips into falsetto on "hoo" so the switch becomes a choice.',
      ],
      singerCues: {
        jalen: ['Find falsetto on "ng", then sing the whole line there without drifting back into a mix, as Jalen does.'],
        daniel: ['On the hook, let the top notes float up into a light falsetto instead of holding them in a mix, as Daniel does.'],
      },
      exercises: ['falsetto-flip-leap', 'octave-slide-wee-oo', 'airy-falsetto-float'],
      singerExercises: { jalen: ['soul-falsetto-forward'] },
      // When flips should not increase (breaks to smooth out, or a target without flips), the release
      // is a smooth slide, not a practised flip.
      conflicts: [
        {
          key: 'flipsPerMinute',
          dir: 'less',
          drop: /deliberate flips/,
          instead: ['Slide up into falsetto on "hoo" without a break, so the top notes release smoothly rather than flipping.'],
        },
      ],
    },
  },
  headInUpperRange: {
    more: {
      title: 'Let high notes float into falsetto',
      cues: [
        'Let the high notes go into falsetto or head voice: lighten up and let the voice release upward rather than carrying weight.',
        'Start the top notes of a phrase softly on "hoo" or "oo", then add the words.',
        'Keep the falsetto supported with steady airflow so it doesn\'t collapse into breath.',
      ],
      singerCues: {
        jalen: ['Practise holding an entire phrase in falsetto with a sweet, forward placement, the way Jalen carries whole lines.'],
        daniel: ['On the hook\'s top word, drop the volume and float it into falsetto on "hoo" first, then add the word, as Daniel does.'],
        shawn: ['Try the last line of a chorus in falsetto, as a contrast to the fuller lines before it, the way Shawn uses it.'],
      },
      exercises: ['octave-slide-wee-oo', 'falsetto-flip-leap', 'ng-siren'],
      singerExercises: { jalen: ['soul-falsetto-forward'], daniel: ['airy-falsetto-float'] },
    },
    less: {
      title: 'Connect falsetto back into your mix',
      cues: [
        'Bridge down from falsetto into mix on "hoo" so the two registers meet.',
        'Use "gug" or "nay" to help your vocal folds meet a little more fully, without pushing.',
        'Keep the vowel narrow and the volume moderate so high notes stay connected instead of flipping.',
      ],
      singerCues: {
        shawn: ['Keep most chorus notes in a chest-coloured "nay" mix and save falsetto for one contrasting moment, as Shawn does.'],
      },
      exercises: ['falsetto-bridge-down', 'gee-gug-connected-mix', 'blended-leap'],
      singerExercises: { shawn: ['nay-bright-mix'] },
    },
  },
  loudnessClimbDbPerSemitone: {
    more: {
      title: 'Let the high notes bloom without pushing',
      cues: [
        'Keep enough breath energy on high notes that they don\'t fade away. Think of a lift in intensity, not in effort.',
        'Brighten the vowel on the top notes; brightness carries better than volume.',
        'Practise swelling easily on one note with messa di voce.',
        'If a high note only works by getting much quieter, try the song a little lower.',
      ],
      singerCues: {
        shawn: ['Get the chorus lift from a brighter, more forward vowel ("nay"), as Shawn does, and keep the throat as free as in the verse.'],
      },
      exercises: ['messa-di-voce', 'verse-chorus-build', 'nay-bright-mix'],
    },
    less: {
      title: 'Keep the volume level as you climb',
      cues: [
        'Aim to sing the top note no louder than the middle of the phrase.',
        'Narrow the vowel and lighten the weight instead of adding breath pressure.',
        'Practise a scale with a level-volume target, record it and check.',
        'If you feel effort in the throat, you are pushing: back off.',
      ],
      singerCues: {
        daniel: ['Let the top of each phrase get lighter, not louder, and softer still as it goes into falsetto, as Daniel does.'],
        jalen: ['Keep the volume flat as a falsetto line rises and let the placement do the work, as Jalen does.'],
        shawn: ['Get Shawn\'s chorus lift from a brighter, more forward vowel ("nay") rather than from extra volume.'],
      },
      exercises: ['level-volume-scale', 'lip-trill-siren', 'mum-five-tone', 'straw-phonation-slides'],
    },
  },
  agility: {
    more: {
      title: 'Add a short, clean run',
      cues: [
        'Start runs slowly and cleanly on a pentatonic pattern, and raise the tempo only when every note is clear.',
        'Keep runs light: less weight and volume make them easier.',
        'Add one short run at the end of a phrase rather than several.',
      ],
      singerCues: {
        daniel: ['Add one short gospel turn on the last word of a phrase, slowly at first, the way Daniel ends lines.'],
      },
      exercises: ['pentatonic-runs', 'gospel-run-patterns'],
    },
    less: {
      title: 'Slow your runs down for clarity',
      cues: [
        'Slow runs down so each note is heard; clarity beats speed.',
        'Use fewer runs and save them for phrase ends.',
        'Practise runs at about 70% of the tempo, with a metronome.',
      ],
      exercises: ['pentatonic-runs', 'gospel-run-patterns'],
    },
  },
  dynamicRangeDb: {
    more: {
      title: 'Widen the contrast between soft and full',
      cues: [
        'Mark one phrase "soft" and one "full", and exaggerate the difference.',
        'Get quieter by using less breath pressure, not by tightening the throat.',
        'Practise messa di voce to control swells on one note.',
      ],
      singerCues: {
        shawn: ['Give your take Shawn\'s arc: a soft, speech-like verse that builds into a fuller chorus.'],
        jalen: ['Keep most of the take gentle and save one full-voiced moment, so the climax stands out as it does for Jalen.'],
        daniel: ['Stay quiet for most of the take and save your fullest sound for one climactic swell, as Daniel does.'],
      },
      exercises: ['messa-di-voce', 'verse-chorus-build', 'aspirate-onsets'],
    },
    less: {
      title: 'Even out the dynamics',
      cues: [
        'Keep the soft passages audible and the loud ones easy, so the whole take sits in a narrower band.',
        'Keep the mic at a steady distance; moving closer and further away changes the level.',
        'Practise messa di voce with a smaller swell.',
      ],
      singerCues: {
        daniel: ['Hold most of the take at one quiet level and allow a single swell at the climax, as Daniel does.'],
        jalen: ['Rein in the louder moments and keep a single big moment for the climax, as Jalen does.'],
      },
      exercises: ['messa-di-voce', 'level-volume-scale'],
    },
  },
  softOnsetRatio: {
    more: {
      title: 'Start phrases on a soft, airy onset',
      cues: [
        'Start phrases with a gentle "h": air first, then tone.',
        'Sigh into the first word rather than hitting it.',
        'Keep the first note soft and let the phrase grow from there.',
      ],
      singerCues: {
        daniel: ['Begin each phrase on a hushed "h", as if the words start mid-breath, the way Daniel does.'],
      },
      exercises: ['aspirate-onsets', 'airy-falsetto-float', 'messa-di-voce'],
      // With a tone that needs to be clearer, only the start of the phrase gets the air.
      conflicts: [
        {
          key: 'breathiness',
          dir: 'less',
          drop: /"h"|Sigh into/,
          instead: [
            'Let only the first word of a phrase start on a light "h", then keep the tone itself clear.',
            'Practise just the start: a quiet "h" into the first vowel, then a clear, focused note straight after it.',
          ],
        },
      ],
    },
    less: {
      title: 'Start phrases cleanly',
      cues: [
        'Start phrases with a balanced onset: breath and sound begin together.',
        'Begin words as you would in speech, cleanly and without a sigh.',
        'Avoid hard glottal clicks; aim for balanced, not pressed.',
      ],
      singerCues: {
        shawn: ['Start verse words as you would speak them, with the air in the tone rather than in front of it, as Shawn does.'],
        jalen: ['Start falsetto notes gently but cleanly, with no "h" in front, as Jalen does.'],
      },
      exercises: ['balanced-onsets', 'nay-bright-mix'],
    },
  },
  pitchAccuracyCents: {
    more: {
      title: 'Keep your tuning tight',
      cues: [
        'Keep checking held notes against a reference.',
        'Hear each note in your head before you sing it.',
        'Slide gently into the centre of a note if you land off it.',
      ],
      exercises: ['drone-tuning'],
    },
    less: {
      title: 'Settle held notes in the centre of the pitch',
      cues: [
        'Slow down: sustain the problem notes against the played note and slide into the centre.',
        'Hear the note in your head before you sing it.',
        'Use less weight on high notes. Pushed notes tend to drift sharp or flat.',
        'Record, check the pitch plot, and repeat the phrase at a slower tempo.',
      ],
      singerCues: {
        jalen: ['Tune the falsetto notes against a played reference note until they sit still, for Jalen-style control.'],
      },
      exercises: ['drone-tuning', 'straight-then-vibrato', 'mum-five-tone'],
    },
  },
  flipsPerMinute: {
    more: {
      title: 'Use an intentional flip into falsetto',
      cues: [
        'Practise a deliberate flip: a comfortable low note in chest, then a leap up into falsetto on "hoo".',
        'Put flips on emotional peaks and phrase ends.',
        'Make the flip light: bring the volume down just before the leap.',
      ],
      singerCues: {
        daniel: ['Try a light flip into falsetto on the top word of your hook, as Daniel does in "Get You".'],
        shawn: ['On the last line of a chorus, switch suddenly from your full sound to a light falsetto, as Shawn does.'],
      },
      exercises: ['falsetto-flip-leap', 'octave-slide-wee-oo', 'ng-siren'],
    },
    less: {
      title: 'Smooth out register breaks',
      cues: [
        'Bridge down from falsetto into mix, and slide up on lip trills without letting the voice break.',
        'Keep the volume level and the vowel narrow as you cross the passaggio.',
        'If the break always happens on the same note, work around it slowly on "gug".',
      ],
      singerCues: {
        jalen: ['Choose one register per line and switch only on purpose, as Jalen does.'],
      },
      exercises: ['blended-leap', 'lip-trill-siren', 'gee-gug-connected-mix', 'falsetto-bridge-down'],
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Why each dimension matters, per singer

export const WHY: Record<StyleKey, Record<Flavour, string>> = {
  breathiness: {
    shawn:
      'Shawn\'s choruses are clear and forward, with little air; breathiness mostly shows up in his quiet verses and falsetto. The air level is what separates his soft verse sound from his chorus sound.',
    daniel:
      'Air in the tone is the most recognisable part of Daniel\'s sound: hushed, close-mic and intimate. Without it, the same melody sounds like a different singer.',
    jalen:
      'Jalen\'s falsetto is sweet and clear rather than breathy. That controlled air is what makes his long falsetto lines sound supported instead of whispery.',
    generic: 'Breathiness decides how intimate or how solid the tone sounds, and listeners notice it straight away.',
  },
  brightness: {
    shawn: 'Shawn\'s choruses ride a bright, forward sound over a warm lower range; the brightness lets chorus notes carry without shouting.',
    daniel: 'Daniel\'s midrange is warm and slightly dark. Too much brightness pulls the sound toward pop and away from his velvety tone.',
    jalen: 'Jalen\'s falsetto rings forward and sweet. A dull or covered falsetto loses the shine that sets his sound apart.',
    generic: 'Brightness, a forward ring versus a warm darkness, is a large part of a singer\'s tone colour.',
  },
  rasp: {
    shawn: 'Coaches describe a little controlled grit on Shawn\'s loudest chorus notes, but his verses are clean. The grit is seasoning, not the sound itself.',
    daniel: 'Daniel\'s tone is essentially clean; any rawness on his records is a soft crack or a thin edge, not grit.',
    jalen: 'Jalen\'s tone is clean and sweet most of the time; he saves a growl or a gritty wail for a few climactic words.',
    generic: 'Rasp changes the character of a voice a lot, and it is easy to overdo in a way that tires the voice.',
  },
  vibratoPresence: {
    shawn: 'Shawn mostly starts notes straight and lets a moderate vibrato in at the ends of long notes, especially in ballads (a listening impression rather than a measured fact).',
    daniel: 'Daniel uses vibrato sparingly. His falsetto lines are often close to straight, with a small vibrato arriving late.',
    jalen: 'The slight tremble on Jalen\'s held falsetto notes is part of the classic \'60s soul sound he draws on.',
    generic: 'How often vibrato appears on held notes is a clear stylistic fingerprint.',
  },
  vibratoRateHz: {
    shawn: 'Vibrato speed decides whether held notes sound relaxed or nervy. Shawn\'s sits in a moderate, pop-typical range (an estimate).',
    daniel: 'Daniel\'s occasional vibrato is gentle and unhurried; a fast flutter would sound tense against his relaxed delivery.',
    jalen: 'Jalen\'s falsetto vibrato is quick and shimmering (a listening impression), in the classic soul-falsetto tradition.',
    generic: 'Vibrato speed decides whether held notes sound relaxed, shimmering or nervy.',
  },
  vibratoExtentCents: {
    shawn: 'Shawn\'s vibrato is fairly narrow (a listening impression); a wide wobble sounds more like musical theatre than pop.',
    daniel: 'Daniel\'s vibrato is small and gentle; a wide wobble would break the intimate, close-mic feel.',
    jalen: 'Jalen\'s held-note tremble is quick and fairly narrow; a wide vibrato would sound operatic rather than Motown.',
    generic: 'Vibrato width shapes the style: narrow sounds pop and soul, wide sounds classical or theatrical.',
  },
  chestInUpperRange: {
    shawn: 'Shawn\'s choruses are chest-dominant: speech-like strength carried just above the passaggio, lightened into a mix rather than shouted.',
    daniel: 'Above the passaggio Daniel mostly lightens into a soft mix or falsetto rather than carrying chest weight up.',
    jalen: 'Jalen\'s high lines are mostly falsetto; he saves chest for emphatic, gospel-soul climaxes.',
    generic: 'How much chest weight you carry above the passaggio decides whether high notes sound belted, mixed or light. Carrying too much is the most common cause of strain.',
  },
  mixInUpperRange: {
    shawn: 'A bright, chest-coloured mix is the core of Shawn\'s chorus sound: strength without shouting, through the notes where the voice changes gear.',
    daniel: 'Daniel\'s upper-middle notes sit in a light, soft mix that lets him float into falsetto without a bump.',
    jalen: 'Jalen spends little time in a mix up high; he tends to commit to falsetto, so a lot of mix sounds more pop than soul.',
    generic: 'Mix, the blend of chest and head coordination, lets high notes keep some strength without being pushed.',
  },
  headInUpperRange: {
    shawn: 'Shawn uses falsetto for contrast, on tags and final choruses, rather than for whole lines.',
    daniel: 'Daniel lifts hooks and emotional peaks into a light, airy falsetto instead of belting them. That is a big part of his intimacy.',
    jalen: 'Falsetto is the centre of Jalen\'s sound. He often sings whole lines in a sweet, controlled falsetto in the tradition of Smokey Robinson and Curtis Mayfield.',
    generic: 'How much of the top of a song goes into falsetto or head voice is one of the clearest style choices a singer makes.',
  },
  loudnessClimbDbPerSemitone: {
    shawn: 'Shawn builds intensity into his choruses, but the lift comes from brightness and energy, not shouting. Keeping the volume in check as you climb is what keeps a mix a mix.',
    daniel: 'Daniel stays level or gets softer as he goes up into falsetto; getting louder as you climb pulls you out of his hushed sound.',
    jalen: 'Jalen\'s falsetto lines stay controlled and even as they rise; pushing the volume up drags chest weight into notes he sings lightly.',
    generic: 'Getting louder with every semitone is the usual sign of pushing chest weight up, which makes the passaggio harder and tires the voice.',
  },
  agility: {
    shawn: 'Shawn is not mainly a runs singer; his ornaments are short fills and scoops.',
    daniel: 'Daniel\'s gospel roots show in short, intentional runs and turns at phrase ends: controlled, not showy.',
    jalen: 'Jalen\'s ornaments are \'60s-soul style (scoops, slides and short turns) rather than long runs.',
    generic: 'Clean, well-placed runs are a style marker; messy ones pull attention from the song.',
  },
  dynamicRangeDb: {
    shawn: 'Shawn\'s songs often move from soft, speech-like verses to much fuller choruses, and that contrast is a big part of the lift.',
    daniel: 'Daniel keeps most of a song in a narrow, quiet range and saves swells for gospel-style climaxes.',
    jalen: 'Jalen\'s delivery is restrained, with fuller moments saved for bridges and climaxes.',
    generic: 'The spread between soft and loud shapes how a performance builds.',
  },
  softOnsetRatio: {
    shawn: 'Shawn\'s verse onsets are speech-like and firm up at chorus peaks; mostly airy starts sound more like R&B than his pop.',
    daniel: 'Daniel\'s phrases often start on a soft, breathy onset, which gives his hushed, close-to-the-ear quality.',
    jalen: 'Jalen\'s falsetto entries are gentle but clean; too many airy starts make the falsetto sound unsupported.',
    generic: 'How phrases begin, airy, balanced or hard, sets the mood before the first vowel is even finished.',
  },
  pitchAccuracyCents: {
    shawn: 'Shawn\'s chorus notes land squarely, and pitch drift stands out more in bright, forward singing. Style comes after tuning.',
    daniel: 'Daniel\'s delivery is relaxed and sometimes raw, but his held notes still settle in tune. Style comes after tuning.',
    jalen: 'Reviewers single out how controlled Jalen\'s falsetto is, and clean tuning is part of that polish.',
    generic: 'Whatever the style, held notes that settle near the centre of the pitch make a take sound finished.',
  },
  flipsPerMinute: {
    shawn: 'Shawn uses sudden drops from full voice into light falsetto for contrast, a few times per song.',
    daniel: 'Daniel flips into falsetto on hooks and emotional peaks; the flip itself is part of the style.',
    jalen: 'Jalen moves between falsetto and chest deliberately, mostly staying in falsetto and switching for climaxes, so accidental breaks stand out.',
    generic: 'Register flips can be a deliberate effect or an unwanted break; the target singer decides which.',
  },
};

/**
 * Reasons for the direction a WHY cell does not argue for. Most WHY texts describe where the singer
 * sits, which argues for moving one way (Daniel is airy, so "more air"); when the take is past the
 * singer the other way, the item needs the reason the singer stops short of that too.
 */
export const WHY_DIR: Partial<Record<StyleKey, Partial<Record<Flavour, Partial<Record<FixDirection, string>>>>>> = {
  breathiness: {
    shawn: {
      more: 'Shawn\'s tone is clear but never pressed: his quiet verses and falsetto carry a little air, and a tone with none at all sounds harder than his.',
    },
    daniel: {
      less: 'Daniel\'s tone is airy, but it never turns into a whisper: under the air there is always a clear, pitched core, and too much air hides it.',
    },
    jalen: {
      more: 'Jalen\'s falsetto is clear but never hard or pressed: a touch of air is what keeps it sweet.',
    },
  },
  brightness: {
    shawn: {
      less: 'Shawn\'s tone is bright but not piercing, over a warm lower range; past a point, brightness turns edgy instead of forward.',
    },
    daniel: {
      more: 'Daniel\'s midrange is warm, but not muffled: a little forward ring keeps his soft tone clear instead of dull.',
    },
    jalen: {
      less: 'Jalen\'s falsetto rings, but it stays sweet rather than sharp; a very bright, twangy tone sounds more like pop belting than \'60s soul.',
    },
  },
  vibratoPresence: {
    daniel: {
      more: 'Daniel uses vibrato sparingly, but not never: a small vibrato arriving late on long notes keeps his held notes from sounding stiff.',
    },
    jalen: {
      less: 'Jalen\'s tremble is slight and kept for held falsetto notes; vibrato on every note sounds more operatic than \'60s soul.',
    },
  },
  vibratoRateHz: {
    daniel: {
      more: 'Daniel\'s occasional vibrato is gentle and easy; a very slow wobble sounds heavy and theatrical rather than relaxed.',
    },
    jalen: {
      less: 'Jalen\'s vibrato is quick but relaxed; a fast, tight flutter sounds nervy rather than shimmering.',
    },
  },
  vibratoExtentCents: {
    shawn: {
      more: 'Shawn\'s vibrato is fairly narrow, but you can hear it at the ends of long notes; a very tight flutter sounds nervy rather than relaxed.',
    },
    daniel: {
      more: 'Daniel\'s vibrato is small but relaxed; a very tight, fast flutter sounds tense against his easy delivery.',
    },
    jalen: {
      more: 'Jalen\'s held-note tremble is narrow but audible; a flutter too small to hear loses the shimmer of his held notes.',
    },
  },
  chestInUpperRange: {
    shawn: {
      less: 'Shawn\'s choruses keep a chest colour, but it is lightened into a mix rather than shouted; carrying full chest weight up is what strains the voice.',
    },
    daniel: {
      more: 'Daniel lightens as he climbs, but his upper-middle notes keep a little chest colour, so the line doesn\'t turn thin the moment it passes the passaggio.',
    },
    jalen: {
      more: 'Jalen\'s high lines are mostly falsetto, but he saves a reedy chest sound for the climax; without it there is no contrast when the song peaks.',
    },
    generic: {
      more: 'How much chest weight you carry above the passaggio decides whether high notes sound belted, mixed or light; with too little, they can sound thin and disconnected from the rest of the voice.',
    },
  },
  mixInUpperRange: {
    shawn: {
      less: 'Shawn\'s choruses are chest-coloured, and he uses real falsetto for contrast; a lot of in-between mix up high sounds softer and less defined than his sound.',
    },
    daniel: {
      less: 'Daniel\'s mix is only a bridge: above it he floats into falsetto, so holding the high notes in a mix sounds heavier than his hooks.',
    },
    jalen: {
      more: 'Jalen tends to commit to falsetto, but the notes around the passaggio still pass through a light mix; without it, the switch into falsetto becomes a bump.',
    },
    generic: {
      less: 'How much of the top goes into mix, and how much is released into a light falsetto or head voice, is a style choice; holding every high note in a mix can sound effortful where a release would float.',
    },
  },
  headInUpperRange: {
    shawn: {
      more: 'Shawn saves falsetto for contrast, on tags and final choruses; with none at all, those moments lose their lift.',
    },
    daniel: {
      less: 'Daniel floats only the hooks and peaks into falsetto; the rest of his upper-middle line sits in a soft, connected mix, so a take that is mostly falsetto loses his warm middle.',
    },
    jalen: {
      less: 'Jalen\'s falsetto is supported and connected: he moves into a fuller chest-mix for climaxes, so a take that never leaves the light register misses that contrast.',
    },
  },
  loudnessClimbDbPerSemitone: {
    shawn: {
      more: 'Shawn\'s choruses lift as they climb: the high notes gain intensity from a brighter vowel and more energy, so a line that fades as it rises loses that build.',
    },
    daniel: {
      more: 'Daniel\'s high notes stay level rather than fading away: even his softest falsetto keeps enough breath energy to carry.',
    },
    jalen: {
      more: 'Jalen\'s falsetto lines stay even as they rise: they don\'t fade as they climb, so the top of a phrase carries as well as the bottom.',
    },
    generic: {
      more: 'High notes that fade as you climb often mean the breath energy drops off at the passaggio; a steady, easy intensity keeps the top of the phrase connected to the rest.',
    },
  },
  agility: {
    shawn: {
      more: 'Shawn is not mainly a runs singer, but short fills and scoops at phrase ends are part of his phrasing.',
    },
    jalen: {
      more: 'Jalen\'s ornaments are small (scoops, slides and short turns rather than long runs), but those small turns are part of his phrasing.',
    },
  },
  dynamicRangeDb: {
    shawn: {
      less: 'Shawn builds from soft verses to fuller choruses, but within a section his level stays steady; very wide swings sound less controlled than his builds.',
    },
    daniel: {
      more: 'Daniel keeps most of a song quiet, but his gospel-style swells at the climax need room to grow; a take that never changes level misses them.',
    },
  },
  softOnsetRatio: {
    shawn: {
      more: 'Shawn\'s verse onsets are speech-like but soft: some phrases start on a little air, which keeps his quiet verses intimate rather than clipped.',
    },
    daniel: {
      less: 'Daniel starts many phrases on a soft, breathy onset, but not every one; if every phrase sighs in, the words lose their shape.',
    },
    jalen: {
      more: 'Jalen\'s falsetto entries are gentle: some phrases start on a soft breath, which keeps the falsetto sweet rather than hard.',
    },
  },
  flipsPerMinute: {
    daniel: {
      less: 'Daniel flips into falsetto on purpose, on hooks and emotional peaks; flips anywhere else sound like breaks rather than style.',
    },
    jalen: {
      more: 'Jalen mostly stays in falsetto, but his switches out of it for a climax and back are deliberate; a take with none misses that contrast.',
    },
  },
};

/** Why the item matters, argued in the direction the item asks for. */
export function whyFor(key: StyleKey, flavour: Flavour, direction: FixDirection): string {
  return WHY_DIR[key]?.[flavour]?.[direction] ?? WHY[key][flavour];
}

// ---------------------------------------------------------------------------------------------
// "What we heard" and strengths

/** Compact names for running text (the full labels repeat "above the passaggio"). */
const SHORT_LABELS: Record<StyleKey, string> = {
  breathiness: 'breathiness',
  brightness: 'brightness',
  rasp: 'rasp',
  vibratoPresence: 'vibrato use',
  vibratoRateHz: 'vibrato speed',
  vibratoExtentCents: 'vibrato width',
  chestInUpperRange: 'chest weight up high',
  mixInUpperRange: 'mix up high',
  headInUpperRange: 'falsetto up high',
  loudnessClimbDbPerSemitone: 'loudness climb',
  agility: 'run speed',
  dynamicRangeDb: 'dynamics',
  softOnsetRatio: 'phrase onsets',
  pitchAccuracyCents: 'tuning',
  flipsPerMinute: 'register flips',
};

function shortLabel(key: StyleKey, light: LightWord): string {
  return withLightWord(SHORT_LABELS[key], light);
}

function rangeOf(key: StyleKey, band: TargetBand): string {
  return `${formatStyleValue(key, band.low)} to ${formatStyleValue(key, band.high)}`;
}

function heardText(d: DimensionResult, profile: SingerProfile, analysis: VoiceAnalysis, light: LightWord): string {
  const key = d.key;
  const v = d.value ?? NaN;
  const t = d.target;
  const target = profile.source === 'reference' ? 'The reference target' : `${whoseOf(profile)} target`;
  const ideal = formatStyleValue(key, t.ideal);
  const onStyle =
    noneTarget(key, t)
      ? `${capitalize(whoOf(profile))} has ${NONE_WORDS[key]}; up to ${formatStyleValue(key, t.high)} counts as on-style.`
      : `${target} is about ${ideal}, with ${rangeOf(key, t)} counting as on-style.`;
  const passaggio = midiToNoteName(analysis.passaggio.lowMidi);
  const above = passaggio ? `Above your passaggio (from ${passaggio})` : 'Above your passaggio';
  switch (key) {
    case 'breathiness':
    case 'brightness':
    case 'rasp':
      return `Your tone measured ${formatStyleValue(key, v)} on our 0–1 ${STYLE_LABELS[key].label.toLowerCase()} scale (${STYLE_LABELS[key].describe(v)}). ${onStyle}`;
    case 'vibratoPresence':
      return `${capitalize(percent(v))} of your held notes had vibrato. ${onStyle}`;
    case 'vibratoRateHz':
      return `Your vibrato cycled about ${fixed(v, 1)} times a second. ${onStyle}`;
    case 'vibratoExtentCents':
      return `Your vibrato swung about ±${Math.round(v)} cents around the note (100 cents is a semitone). ${onStyle}`;
    case 'chestInUpperRange':
    case 'mixInUpperRange':
    case 'headInUpperRange': {
      const reg = key === 'chestInUpperRange' ? 'chest' : key === 'mixInUpperRange' ? 'mix' : withLightWord('falsetto or head voice', light);
      return `${above}, ${percent(v)} of your singing read as ${reg}. ${onStyle} Register labels are acoustic estimates.`;
    }
    case 'loudnessClimbDbPerSemitone':
      return `${above}, your volume changed by about ${signedFixed(v, 1)} dB for every semitone you climbed. ${target} is about ${signedFixed(t.ideal, 1)} dB per semitone (${signedFixed(t.low, 1)} to ${signedFixed(t.high, 1)} is on-style).`;
    case 'agility':
      return v <= 0.05
        ? `We didn't detect any runs in this take. ${target} is short runs at about ${ideal}.`
        : `Your runs moved at about ${fixed(v, 1)} notes per second. ${onStyle}`;
    case 'dynamicRangeDb':
      return `Your loudest singing was about ${Math.round(v)} dB above your quietest. ${onStyle}`;
    case 'softOnsetRatio':
      return `${capitalize(percent(v))} of your phrases started with an airy (aspirated) onset. ${onStyle}`;
    case 'pitchAccuracyCents':
      return `Your held notes were on average about ${Math.round(v)} cents from the nearest note (100 cents is a semitone). Under ${Math.round(t.high)} cents sounds settled and in tune.`;
    case 'flipsPerMinute': {
      // compareToProfile widens the flips band on short takes, where one flip moves the rate a lot.
      const widened = t !== profile.targets.flipsPerMinute
        ? ' On a take this short, one flip more or fewer changes the rate a lot, so the on-style range is wider than usual.'
        : '';
      return withLightWord(
        `We heard about ${fixed(v, 1)} register flips (sudden switches into falsetto) per minute of singing. ${onStyle}${widened}`,
        light,
      );
    }
  }
}

function strengthText(d: DimensionResult, profile: SingerProfile): string {
  const who = whoOf(profile);
  const v = d.value ?? NaN;
  const desc = describeWithNumber(d.key, v);
  switch (d.key) {
    case 'breathiness':
      return `Your tone is ${desc}: about the amount of air ${who} uses.`;
    case 'brightness':
      return `Your tone colour is ${desc}, close to where ${whoseOf(profile)} sits.`;
    case 'rasp':
      // Named as grit, so it can't read as "clean" praise next to an item asking for more air.
      return `Your tone has ${v < 0.15 ? 'no grit' : v < 0.2 ? 'almost no grit' : 'only a little grit'} (rasp ${fixed(v, 2)}), in line with ${who}.`;
    case 'vibratoPresence':
      return `You use vibrato on held notes about as often as ${who} (${percent(v)}).`;
    case 'vibratoRateHz':
      return `Your vibrato speed (${formatStyleValue(d.key, v)}) matches ${whoseOf(profile)}.`;
    case 'vibratoExtentCents':
      return `Your vibrato width (${formatStyleValue(d.key, v)}) is in ${whoseOf(profile)} range.`;
    case 'chestInUpperRange':
      return `Above the passaggio you carry about as much chest as ${who} (${percent(v)}).`;
    case 'mixInUpperRange':
      return `Your mix above the passaggio (${percent(v)}) is in ${whoseOf(profile)} zone.`;
    case 'headInUpperRange':
      return `You use falsetto or head voice up top about as much as ${who} (${percent(v)}).`;
    case 'loudnessClimbDbPerSemitone':
      return `Your volume stays under control as you climb (${signedFixed(v, 1)} dB per semitone), like ${whoseOf(profile)}.`;
    case 'agility':
      return v <= 0.05 ? `You kept the line free of runs, which suits ${who}.` : `Your runs move at a ${who}-like speed (${formatStyleValue(d.key, v)}).`;
    case 'dynamicRangeDb':
      return `Your soft-to-loud contrast (${formatStyleValue(d.key, v)}) fits ${whoseOf(profile)} style.`;
    case 'softOnsetRatio':
      return `The way your phrases start (${percent(v)} airy) matches ${whoseOf(profile)} habit.`;
    case 'pitchAccuracyCents':
      return `Your held notes are well in tune (${desc}).`;
    case 'flipsPerMinute':
      return `Your register flips (${desc}) are in ${whoseOf(profile)} range.`;
  }
}

/**
 * A flip rate that "fits" only on paper: no flips at all (the band reaches zero for a singer who
 * flips about once a song), or a rate outside the profile's own band that counts as on-style only
 * because short takes get a wider one. Not worth praising, nor building a flip move on.
 */
function isHollowMatch(d: DimensionResult, profile: SingerProfile): boolean {
  if (d.key !== 'flipsPerMinute' || d.direction !== 'ok') return false;
  const v = d.value ?? 0;
  const own = profile.targets.flipsPerMinute;
  return v <= 0.05 || (own !== undefined && (v < Math.min(own.low, own.high) || v > Math.max(own.low, own.high)));
}

function pickStrengths(measured: DimensionResult[], profile: SingerProfile, light: LightWord): string[] {
  const good = measured
    .filter((d) => d.score >= STRENGTH_SCORE && !isHollowMatch(d, profile))
    .sort((a, b) => b.target.weight - a.target.weight || b.score - a.score)
    .slice(0, 4);
  if (good.length) return good.map((d) => withLightWord(strengthText(d, profile), light));
  // Nothing on-style yet: name the two closest areas honestly instead of dressing them up.
  return [...measured]
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(
      (d) =>
        `Closest to ${whoOf(profile)} so far: ${shortLabel(d.key, light)}, ${describeWithNumber(d.key, d.value ?? NaN)}, ` +
        `scoring ${d.score}/100. Not there yet, but the nearest starting point.`,
    );
}

// ---------------------------------------------------------------------------------------------
// Items

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function validExercises(ids: string[], limit: number): string[] {
  return unique(ids)
    .filter((id) => getExercise(id) !== undefined)
    .slice(0, limit);
}

/**
 * Exercises that push a dimension one set way. While the take needs that dimension to go the other
 * way, the plan leaves them out, so two items never prescribe drills that pull against each other
 * (an intentional-flip drill next to "smooth out register breaks", an airy drill for a take that is
 * already too airy).
 */
const EXERCISE_PUSHES: Record<string, Partial<Record<StyleKey, FixDirection>>> = {
  'falsetto-flip-leap': { flipsPerMinute: 'more' },
  'blended-leap': { flipsPerMinute: 'less' },
  'airy-falsetto-float': { breathiness: 'more' },
  'aspirate-onsets': { softOnsetRatio: 'more', breathiness: 'more' },
  'balanced-onsets': { softOnsetRatio: 'less' },
};

function pullsAgainst(exerciseId: string, needs: Map<StyleKey, Direction>): boolean {
  const pushes = EXERCISE_PUSHES[exerciseId];
  if (!pushes) return false;
  return (Object.entries(pushes) as [StyleKey, FixDirection][]).some(([key, dir]) => {
    const need = needs.get(key);
    return (need === 'more' || need === 'less') && need !== dir;
  });
}

function dimensionItem(
  d: DimensionResult,
  direction: FixDirection,
  priority: 1 | 2 | 3,
  profile: SingerProfile,
  analysis: VoiceAnalysis,
  flavour: Flavour,
  light: LightWord,
  needs: Map<StyleKey, Direction>,
): CoachingItem {
  // A reference clip is worded from the clip itself: the base singer's traits can contradict the
  // clip's targets (Shawn's "little air" next to a clip that asks for more), so the base singer's cues
  // and reasons stay out, and the reason points at the recording.
  const reference = profile.source === 'reference';
  const textFlavour: Flavour = reference ? 'generic' : flavour;
  const noRuns = d.key === 'agility' && direction === 'less' && noneTarget(d.key, d.target);
  const cell = noRuns ? noRunsCell(profile) : FIXES[d.key][direction];
  const conflicts = (cell.conflicts ?? []).filter((c) => needs.get(c.key) === c.dir);
  const keep = (cue: string) => !conflicts.some((c) => c.drop.test(cue));
  const singer = (cell.singerCues?.[textFlavour] ?? []).filter(keep).slice(0, 2);
  const general = cell.cues.filter(keep);
  const instead = conflicts.flatMap((c) => c.instead);
  const howToFix = unique([...singer, ...instead, ...general].map((c) => withLightWord(c, light))).slice(0, 5);
  const candidates = [...(cell.singerExercises?.[textFlavour] ?? []), ...cell.exercises];
  const conflictKeys = new Set(conflicts.map((c) => c.key));
  const touchesConflict = (id: string) => Object.keys(EXERCISE_PUSHES[id] ?? {}).some((k) => conflictKeys.has(k as StyleKey));
  const compatible = candidates.filter((id) => !pullsAgainst(id, needs) && !touchesConflict(id));
  const exerciseIds = validExercises(compatible.length ? compatible : candidates, 3);
  let why: string;
  if (noRuns) {
    why = `${capitalize(whoOf(profile))} has no runs, so any you add make the take sound like a different arrangement of the song rather than a closer match.`;
  } else {
    const base = whyFor(d.key, textFlavour, direction);
    why = textFlavour === 'generic' ? withLightWord(base, light) : base;
    if (reference) {
      why += ` The reference clip measured about ${formatStyleValue(d.key, d.target.ideal)}, so matching it is part of sounding like that recording.`;
    }
  }
  return {
    id: `${d.key}-${direction}`,
    priority,
    dimension: d.key,
    title: withLightWord(cell.title, light),
    whatWeHeard: heardText(d, profile, analysis, light),
    whyItMatters: why,
    howToFix,
    exerciseIds,
  };
}

/** "Slow your runs down" can't reach a target without runs; this cell asks for none instead. */
function noRunsCell(profile: SingerProfile): FixCell {
  return {
    title: 'Leave the runs out',
    cues: [
      `Sing the melody straight; ${whoOf(profile)} has no runs, so save ornaments for another song.`,
      'Hold each note for its full length instead of filling the gaps between notes with extra ones.',
      'If a run slips in, sing that phrase slowly on one vowel until the plain melody feels natural.',
    ],
    exercises: ['drone-tuning'],
  };
}

/** Recording cues per issue, most fundamental first. */
const ISSUE_CUES: [AnalysisIssue, string][] = [
  [
    'accompaniment',
    'Record your voice on its own: sing a cappella, or play the backing track through headphones. In a song mix the analysis can follow the bass or the band instead of you.',
  ],
  ['too-little-singing', 'Sing for at least 10 seconds, with a few held notes and at least one phrase above your passaggio.'],
  ['speech-like', 'Sing a melody with a few held notes of half a second or more; short, spoken syllables don\'t show your singing tone.'],
  [
    'clipping',
    'Lower the input level, or back off a little from the mic, so your loudest note does not clip (distort). Then keep that distance for every take.',
  ],
  ['noisy', 'Record in a quiet, soft-furnished room (curtains and a sofa help), away from fans, fridges and traffic.'],
  ['too-quiet', 'Keep the mic or phone 20 to 30 cm from your mouth and raise the input level if you can, then use the same distance for every take.'],
  ['trimmed', 'Keep takes under 5 minutes: only the first 5 minutes are analysed.'],
];

/**
 * Plain-language summary of each issue. The recording item uses these rather than the warnings,
 * which the Results page already shows in full above the plan.
 */
const ISSUE_SUMMARY: Record<AnalysisIssue, string> = {
  accompaniment: 'It sounds like singing over instruments.',
  'too-little-singing': 'There was very little singing in it.',
  'speech-like': 'It was mostly short, speech-like syllables with few held notes.',
  noisy: 'There was a lot of background noise.',
  clipping: 'The loudest notes clipped (distorted).',
  'too-quiet': 'The level was very low.',
  trimmed: 'Only the first 5 minutes were analysed.',
};

const RECORDING_FALLBACK_CUES = [
  'Make sure the take is mostly one voice singing: no speech, long silences, backing vocals or instruments.',
  'Keep the phone or mic in the same spot each time, about 20 to 30 cm away, so takes can be compared fairly.',
  'Turn off noise suppression, auto-gain or effects in your recording app if you can.',
  'Record a new take of the same section and compare the numbers.',
];

function issuesOf(analysis: VoiceAnalysis): AnalysisIssue[] {
  return analysis.issues ?? [];
}

function seconds(sec: number): string {
  const s = Math.max(0, sec);
  return `${s < 10 ? fixed(s, 1) : Math.round(s)} s`;
}

/** Below this much voiced sound, copy says "no singing" instead of "about 0.0 s of singing". */
const NO_SINGING_SEC = 0.5;

function issueSummary(issue: AnalysisIssue, analysis: VoiceAnalysis): string {
  if (issue === 'too-little-singing') {
    return analysis.voicedSec < NO_SINGING_SEC
      ? 'We couldn\'t hear any singing in it.'
      : `There was very little singing in it (about ${seconds(analysis.voicedSec)}).`;
  }
  return ISSUE_SUMMARY[issue];
}

function recordingItem(analysis: VoiceAnalysis, comparison: Comparison, scoreable: boolean): CoachingItem {
  const issues = issuesOf(analysis);
  // With instruments in the take, "background noise" is the band: the accompaniment cue covers it.
  const cues = ISSUE_CUES.filter(([issue]) => issues.includes(issue) && !(issue === 'noisy' && issues.includes('accompaniment'))).map(
    ([, cue]) => cue,
  );
  for (const cue of RECORDING_FALLBACK_CUES) {
    if (cues.length >= 3) break;
    // The accompaniment cue already says "your voice on its own".
    if (issues.includes('accompaniment') && cue === RECORDING_FALLBACK_CUES[0]) continue;
    cues.push(cue);
  }
  // A short summary: the full warnings (with their numbers) are already on the page above the plan.
  const flagged = issues.length
    ? `The recording itself was flagged: ${lowerFirst(issues.map((i) => issueSummary(i, analysis)).join(' '))}`
    : analysis.warnings.length
      ? `The recording itself was flagged: ${analysis.warnings.join(' ')}`
      : '';
  const measured = comparison.dimensions.filter((d) => d.value !== null).length;
  const counted =
    `Only ${measured} of the ${comparison.dimensions.length} style measures could be taken from this take` +
    (analysis.voicedSec < NO_SINGING_SEC ? '.' : ` (about ${seconds(analysis.voicedSec)} of singing).`);
  let title = 'Fix the recording first';
  let why =
    'Breathiness, brightness, rasp and the register estimates all come from fine detail in the sound, so noise, ' +
    'clipping or a very short take can skew them. Treat the numbers in this plan with some caution until the recording is cleaner.';
  if (issues.includes('accompaniment')) {
    if (!scoreable) title = 'Record your voice on its own';
    why =
      'The analysis assumes one voice. With instruments or backing vocals in the take, the pitch tracker can follow the bass ' +
      'or the band, so the range, register and tone numbers would describe the music rather than you.';
  } else if (!scoreable) {
    title = 'Record a take we can measure';
    why =
      'Most measures need several seconds of steady singing: held notes for vibrato and tuning, and time above your passaggio ' +
      'for the register estimates. With too little of that, a match score would be a guess, so this take is not scored.';
  } else if (issues.includes('speech-like')) {
    why =
      'Tone, vibrato and register measures come from sung, held notes. Short, speech-like syllables don\'t show them, so ' +
      'treat the numbers in this plan with caution.';
  }
  return {
    id: 'recording',
    priority: 1,
    dimension: 'recording',
    title,
    // The count only explains takes that were unscoreable for lack of measurements.
    whatWeHeard: scoreable || issues.includes('accompaniment') || issues.includes('too-little-singing') ? flagged || counted : [flagged, counted].filter(Boolean).join(' '),
    whyItMatters: why,
    howToFix: cues.slice(0, 5),
    exerciseIds: [],
  };
}

function rangeItem(comparison: Comparison, profile: SingerProfile, analysis: VoiceAnalysis, light: LightWord): CoachingItem {
  const t = comparison.suggestedTransposeSemitones;
  const n = Math.abs(t);
  const semis = `${n} semitone${n === 1 ? '' : 's'}`;
  const lo = midiToNoteName(analysis.passaggio.lowMidi);
  const hi = midiToNoteName(analysis.passaggio.highMidi);
  const zone = lo && hi ? ` (around ${lo}–${hi})` : '';
  // A reference clip is named as such, not after the builtin singer its profile borrowed from.
  const { songs, whose } = keyAdviceNames(profile);
  const settings =
    profile.source === 'reference'
      ? 'This advice follows your voice type in Settings and the artist\'s voice type set under "Analyse the reference as", not this one take. If it feels wrong, check those first.'
      : 'This advice follows the voice type in Settings, not this one take. If it feels wrong for your voice, check that setting first.';
  return {
    id: 'range',
    priority: 2,
    dimension: 'range',
    title: `Try ${songs} about ${semis} ${t < 0 ? 'lower' : 'higher'}`,
    whatWeHeard: comparison.rangeNote,
    whyItMatters: withLightWord(
      `Your voice type puts your passaggio about ${semis} ${t < 0 ? 'below' : 'above'} ${whose}. Moving the key by that much lets ` +
        `the phrases land in the same part of your voice as they do in ${whose}, so the mix and falsetto moments line up and ` +
        'the high notes need no extra push.',
      light,
    ),
    howToFix: [
      `Move the backing track ${t < 0 ? 'down' : 'up'} about ${semis} with a key or pitch-shift setting, or play the chords in the new key.`,
      `Check the new key by ear: the highest chorus notes should sit a little above your passaggio${zone}, not far above it. ` +
        'If they still feel effortful, go down one more semitone.',
      'Record the same section in the new key and compare the scores with this take.',
      settings,
    ],
    exerciseIds: validExercises(['lip-trill-siren'], 1),
  };
}

// ---------------------------------------------------------------------------------------------
// Signature focus, health notes, headline, next take

function gapOf(d: DimensionResult): number {
  return d.target.weight * (100 - d.score);
}

/**
 * 0: the move works on a real gap in the direction the take needs; 1: it builds on something that
 * already fits; 2: nothing it trains was measured; 3: it trains something the app can't measure
 * (timing); 4: it would push the take further past the target (or toward pushing), so it goes last.
 */
type MoveTier = 0 | 1 | 2 | 3 | 4;

function signatureFocus(profile: SingerProfile, byKey: Map<StyleKey, DimensionResult>, light: LightWord): CoachingPlan['signatureFocus'] {
  const candidates = profile.signatureMoves.map((move, index) => {
    const wants = MOVE_FOCUS[move.id] ?? {};
    const keys = Object.keys(wants) as StyleKey[];
    // A hollow match (no flips at all "fitting" a singer who flips once a song) is not something to
    // build a flip move on, so it counts as unmeasured here.
    const dims = keys.map((k) => byKey.get(k)).filter((d): d is DimensionResult => d !== undefined);
    const measured = dims.filter(
      (d) => d.value !== null && Number.isFinite(d.value) && d.direction !== 'unknown' && !isHollowMatch(d, profile),
    );
    // A move that adds something the target doesn't do at all (chest or flips for a reference clip
    // that has none) goes against the target whatever the take measured, unless it also fixes a gap.
    const absent = dims.filter((d) => lacksTrait(d, wants[d.key]));
    // A move suits a dimension that is on-style (it builds on it) or that needs to go the way the move pushes it.
    const aligned = measured.filter(
      (d) => !absent.includes(d) && (d.direction === 'ok' || (d.direction === wants[d.key] && !isUnsafeMore(d))),
    );
    const contrary = measured.filter((d) => !aligned.includes(d));
    const helpsGap = aligned.some((d) => d.score < ITEM_SCORE_THRESHOLD);
    const bigContrary = contrary.some((d) => d.score < ITEM_SCORE_THRESHOLD);
    const tier: MoveTier =
      keys.length === 0 ? 3 : helpsGap ? 0 : absent.length ? 4 : measured.length === 0 ? 2 : aligned.length > 0 && !bigContrary ? 1 : 4;
    return { move, index, tier, aligned, contrary: absent.length ? absent : contrary };
  });
  const used = new Set<StyleKey>();
  const out: CoachingPlan['signatureFocus'] = [];
  // Greedy: each pick is the move whose most-needed suitable dimension (ignoring dimensions an
  // earlier pick already covers) has the largest weighted gap, so two picks don't repeat one hint.
  while (out.length < 2 && candidates.length) {
    const scored = candidates.map((c) => {
      const fresh = c.aligned.filter((d) => !used.has(d.key));
      const focus = [...(fresh.length ? fresh : c.aligned)].sort((a, b) => gapOf(b) - gapOf(a))[0];
      const need = focus ? gapOf(focus) * (fresh.length ? 1 : 0.5) : 0;
      return { c, focus, need };
    });
    scored.sort((a, b) => a.c.tier - b.c.tier || b.need - a.need || a.c.index - b.c.index);
    const best = scored[0];
    candidates.splice(candidates.indexOf(best.c), 1);
    if (best.c.tier === 4) {
      out.push({ moveId: best.c.move.id, hint: holdBackHint(best.c.contrary, profile, light) });
      continue;
    }
    if (best.focus) used.add(best.focus.key);
    out.push({ moveId: best.c.move.id, hint: moveHint(best.c.move, best.c.tier !== 3, best.focus, profile, light) });
  }
  return out;
}

function takeValue(d: DimensionResult, light: LightWord): string {
  const v = d.value ?? NaN;
  return withLightWord(describeIncludesNumber(d.key) ? compactValue(d.key, v) : describeWithNumber(d.key, v), light);
}

function moveHint(
  move: SingerProfile['signatureMoves'][number],
  mapped: boolean,
  focus: DimensionResult | undefined,
  profile: SingerProfile,
  light: LightWord,
): string {
  const firstStep = move.howTo[0] ? ` Start here: ${lowerFirst(withLightWord(move.howTo[0], light))}` : '';
  if (!mapped) return `The app doesn't measure this, so judge it by ear against the original.${firstStep}`;
  if (!focus) return `This take didn't give us enough to measure what this move trains, so record a section built around it.${firstStep}`;
  if (focus.direction === 'more' || focus.direction === 'less') {
    const goal = lowerFirst(withLightWord(FIXES[focus.key][focus.direction].title, light));
    const now = `${versusTarget(focus, takeValue(focus, light))} for ${whoOf(profile)}`;
    return `${capitalize(shortLabel(focus.key, light))} in this take: ${now}. Use this move to ${goal}.${firstStep}`;
  }
  const verb = PLURAL_LABELS.has(focus.key) ? 'fit' : 'fits';
  const numbers = withLightWord(wordsAndNumber(focus.key, focus.value ?? NaN), light);
  return `Your ${shortLabel(focus.key, light)} already ${verb} ${whoseOf(profile)} style (${numbers}), so this is a good next layer of the sound.${firstStep}`;
}

/** Share- and count-like measures where a target of about zero means the singer doesn't do it at all. */
const ABSENT_KEYS = new Set<StyleKey>([
  'chestInUpperRange',
  'mixInUpperRange',
  'headInUpperRange',
  'vibratoPresence',
  'agility',
  'softOnsetRatio',
  'flipsPerMinute',
]);

/** True when a move pushes `d` up but the target has none of it (a reference clip without flips or chest). */
function lacksTrait(d: DimensionResult, push: FixDirection | undefined): boolean {
  return push === 'more' && ABSENT_KEYS.has(d.key) && d.target.ideal <= 0.05;
}

/** Hint for a move that would take the take further from the target (or toward pushing). */
function holdBackHint(contrary: DimensionResult[], profile: SingerProfile, light: LightWord): string {
  const d = [...contrary].sort((a, b) => gapOf(b) - gapOf(a))[0];
  if (!d) return 'Save this move for later: this take is already past what it trains.';
  if (d.target.ideal <= 0.05 && ABSENT_KEYS.has(d.key) && d.direction !== 'more') {
    const none = NONE_WORDS[d.key] ?? `almost no ${shortLabel(d.key, light)} (about ${formatStyleValue(d.key, d.target.ideal)})`;
    return `${capitalize(whoOf(profile))} has ${none}, and this move adds ${d.key in NONE_WORDS ? 'them' : 'it'}, so save it for another song.`;
  }
  const label = capitalize(shortLabel(d.key, light));
  const numbers = versusTarget(d, takeValue(d, light));
  if (isUnsafeMore(d)) {
    return `${label} in this take is below ${whoseOf(profile)} (${numbers}), but getting closer would mean pushing, so leave this move for now.`;
  }
  const side = d.direction === 'less' ? 'above' : 'below';
  return `${label} in this take is already ${side} ${whoseOf(profile)} usual range (${numbers}), and this move would take it further, so save it for later.`;
}

/** Health notes every plan carries, whatever the take. */
const GENERAL_HEALTH_NOTES = [
  'Warm up for a few minutes with lip trills, humming or a straw before working on high notes. Keep sessions short and ' +
    'focused, keep water nearby, and stop if you feel pain, tickling or tightness. Rest beats pushing through.',
  'If your voice suddenly cuts out, loses its top notes or turns hoarse during a loud or high note, stop singing and rest ' +
    'your voice, and get it checked by a laryngologist (an ENT voice specialist) within a few days rather than waiting for it to pass.',
];

function healthNotes(analysis: VoiceAnalysis, flavour: Flavour, speechLike: boolean): string[] {
  const s = analysis.style;
  const notes = [...GENERAL_HEALTH_NOTES];
  // The climb and register readings need sung notes above the passaggio; speech doesn't have them.
  if (!speechLike && s.loudnessClimbDbPerSemitone !== null && s.loudnessClimbDbPerSemitone > PUSHING_CLIMB_DB) {
    notes.push(
      `Your volume rose about ${fixed(s.loudnessClimbDbPerSemitone, 1)} dB per semitone above the passaggio, which usually means ` +
        'chest weight is being pushed up. Lighten the note and narrow the vowel rather than singing harder, and if the top ' +
        'notes only work loud, move the song down a few semitones.',
    );
  }
  if (!speechLike && s.chestInUpperRange !== null && s.chestInUpperRange > HEAVY_CHEST_SHARE) {
    notes.push(
      `About ${percent(s.chestInUpperRange)} of your singing above the passaggio read as chest. Carrying heavy chest up for long ` +
        'stretches is tiring, so alternate with lip-trill sirens and lighter takes, and stop before your voice feels tired.',
    );
  }
  if (s.rasp !== null && s.rasp > 0.4) {
    let note =
      `We heard noticeable rasp (${fixed(s.rasp, 2)} on a 0–1 scale). If it is deliberate, keep it light and occasional and never ` +
      'squeeze for it. If it is there even when you sing softly, or your voice feels hoarse, rest. See an ENT doctor or ' +
      'laryngologist, ideally one who works with singers, if hoarseness lasts two weeks or more or if singing hurts.';
    if (flavour === 'shawn') {
      note += ' Shawn Mendes himself cancelled a 2019 concert in São Paulo because of laryngitis: rest is part of the job.';
    }
    notes.push(note);
  }
  if (s.dynamicRangeDb !== null && s.dynamicRangeDb > 28) {
    notes.push(
      `Your loudest moments were about ${Math.round(s.dynamicRangeDb)} dB above the quietest. Big contrasts are musical, but make ` +
        'sure the loud notes felt easy rather than shouted.',
    );
  }
  if (s.breathiness !== null && s.breathiness > 0.85) {
    notes.push('Very airy singing uses a lot of breath and can dry the voice. Sip water and mix in some clearer tone.');
  }
  return notes;
}

function verdict(overall: number): string {
  if (overall >= 85) return 'very close to that sound';
  if (overall >= 70) return 'a good way there';
  if (overall >= 55) return 'on the way, with some clear differences';
  if (overall >= 40) return 'some big differences for now';
  return 'quite a different sound for now';
}

const PLURAL_LABELS = new Set<StyleKey>(['dynamicRangeDb', 'softOnsetRatio', 'flipsPerMinute']);

function joinLabels(ds: DimensionResult[], light: LightWord): string {
  const labels = ds.map((d) => shortLabel(d.key, light));
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function headline(
  comparison: Comparison,
  profile: SingerProfile,
  measured: DimensionResult[],
  gaps: DimensionResult[],
  held: DimensionResult[],
  analysis: VoiceAnalysis,
  light: LightWord,
): string {
  const target = profile.source === 'reference' ? 'the reference clip' : profile.name;
  const issues = issuesOf(analysis);
  const speechLike = issues.includes('speech-like');
  // On speech the score is a rough guide at best, so it gets the caveat instead of a verdict.
  const sentences = [
    speechLike
      ? `Overall match with ${target}: ${comparison.overall}/100, but this take sounded mostly like short, speech-like syllables, so treat these numbers with caution.`
      : `Overall match with ${target}: ${comparison.overall}/100, ${verdict(comparison.overall)}.`,
  ];
  const close = measured
    .filter((d) => d.score >= STRENGTH_SCORE && !isHollowMatch(d, profile))
    .sort((a, b) => b.target.weight - a.target.weight)
    .slice(0, 2);
  if (gaps.length) {
    const top = gaps[0];
    const numbers = versusTarget(top, compactValue(top.key, top.value ?? NaN));
    const rest = gaps.length > 1 ? `, followed by ${shortLabel(gaps[1].key, light)}` : '';
    const lead = close.length
      ? `Your ${joinLabels(close, light)} already ${close.length > 1 || PLURAL_LABELS.has(close[0].key) ? 'sit' : 'sits'} in ${whoseOf(profile)} zone; the biggest gap is`
      : 'The biggest gap is';
    sentences.push(`${lead} ${shortLabel(top.key, light)} (${numbers})${rest}.`);
  } else if (held.length) {
    sentences.push(
      `Everything else is close to ${whoseOf(profile)} targets; we won't coach you toward more ${joinLabels(held, light)}, ` +
        'because getting closer there would mean pushing.',
    );
  } else if (!speechLike) {
    sentences.push(`Every measured dimension is close to ${whoseOf(profile)} targets, so the signature moves below are your next step.`);
  }
  const t = comparison.suggestedTransposeSemitones;
  if (speechLike) {
    sentences.push('Start with the recording tips: sing a melody with a few held notes.');
  } else if (analysis.warnings.length || issues.length) {
    sentences.push('Some numbers may be skewed by the recording itself, so start with the recording tips.');
  } else if (singerPassaggioLow(profile) !== null && Math.abs(t) >= RANGE_ITEM_SEMITONES) {
    sentences.push(`Based on your voice type, also try ${keyAdviceNames(profile).songs} about ${Math.abs(t)} semitones ${t < 0 ? 'lower' : 'higher'}.`);
  }
  return sentences.join(' ');
}

/** What to record next when the recording itself is the first thing to fix. */
function recordingNextTake(analysis: VoiceAnalysis, scoreable: boolean): string {
  const issues = issuesOf(analysis);
  if (issues.includes('accompaniment')) {
    return 'Record the same section with your voice alone (a cappella, or with the backing track in headphones), so the next analysis measures you, not the band.';
  }
  if (!scoreable || issues.includes('too-little-singing')) {
    return 'Record a verse or chorus of one song, at least 10 seconds of singing with a few held notes and at least one phrase above your passaggio, so the next take can be scored.';
  }
  if (issues.includes('speech-like')) {
    return 'Record a sung phrase or two with a few held notes, so the next analysis can measure your singing tone.';
  }
  if (issues.includes('clipping')) {
    return 'Re-record the same section with the input level a little lower, so the loudest notes stay clean.';
  }
  if (issues.includes('too-quiet')) {
    return 'Re-record the same section with the mic 20 to 30 cm away and the input level a little higher.';
  }
  return 'Re-record the same section in a quieter spot with the level set a little lower, so the next analysis can be trusted.';
}

/**
 * A drill's name for running text. Names are fixed (they match the Practice page), so for a higher
 * voice a "falsetto" drill is quoted and the register named separately rather than renamed.
 */
function drillName(name: string, light: LightWord): string {
  if (light === 'head voice' && /falsetto/i.test(name)) return `the "${name}" drill (sung in head voice)`;
  return nameInSentence(name);
}

function nextTake(items: CoachingItem[], profile: SingerProfile, analysis: VoiceAnalysis, light: LightWord): string {
  const first = items[0];
  if (!first) {
    const move = profile.signatureMoves[0];
    return move
      ? `Record a new section built around ${whoseOf(profile)} ${move.name.toLowerCase()} and see whether the match holds.`
      : 'Record a new section of a different song and see whether the match holds.';
  }
  if (first.dimension === 'recording') return recordingNextTake(analysis, true);
  const ex = first.exerciseIds.map((id) => getExercise(id)).find((e) => e !== undefined);
  const focus = `the same section again with one focus: ${lowerFirst(first.title)}.`;
  return ex ? `After ${ex.durationMin} minutes of ${drillName(ex.name, light)}, record ${focus}` : `Record ${focus}`;
}

/**
 * The plan for a take that can't be scored (too little singing, singing over instruments, or too
 * few measured dimensions): why, and how to record one that can be. No style items, strengths or
 * signature hints, because the numbers behind them would not describe the singer.
 */
function unscoreablePlan(analysis: VoiceAnalysis, comparison: Comparison, profile: SingerProfile): CoachingPlan {
  if (profile.source === 'reference' && comparison.dimensions.length < MIN_REFERENCE_TARGETS) return unusableReferencePlan(profile);
  const issues = issuesOf(analysis);
  const target = profile.source === 'reference' ? 'the reference clip' : profile.name;
  const from = midiToNoteName(analysis.passaggio.lowMidi);
  const howTo =
    'Record at least 10 seconds of singing, with some held notes and a phrase above your passaggio' +
    `${from ? ` (from ${from})` : ''}.`;
  let head: string;
  if (issues.includes('accompaniment')) {
    head =
      `This take sounds like singing over instruments, so we can't score it against ${target}: the analysis may be following ` +
      'the band or the bass instead of your voice. Record your voice on its own, a cappella or with the backing track in headphones.';
  } else if (issues.includes('too-little-singing')) {
    head =
      analysis.voicedSec < NO_SINGING_SEC
        ? `We couldn't hear any singing in this take, so we can't compare it with ${target}. ${howTo}`
        : `We couldn't hear enough singing in this take to compare it with ${target} (about ${seconds(analysis.voicedSec)} of singing). ${howTo}`;
  } else {
    const measured = comparison.dimensions.filter((d) => d.value !== null).length;
    head =
      `We couldn't measure enough of this take to compare it with ${target} (${measured} of ${comparison.dimensions.length} ` +
      `style measures). ${howTo}`;
  }
  return {
    profileId: profile.id,
    headline: head,
    strengths: [],
    items: [recordingItem(analysis, comparison, false)],
    signatureFocus: [],
    healthNotes: [...GENERAL_HEALTH_NOTES],
    nextTake: recordingNextTake(analysis, false),
  };
}

/** A reference profile with fewer targets than this can't score a take, however good the take is. */
const MIN_REFERENCE_TARGETS = 4;

/** The plan when the reference clip, not the take, is the problem: it gave too few measurable targets. */
function unusableReferencePlan(profile: SingerProfile): CoachingPlan {
  const n = Object.keys(profile.targets).length;
  return {
    profileId: profile.id,
    headline:
      'The reference clip gave too little measurable singing to compare against, so this take is not scored. ' +
      'Load a clip with an isolated vocal or an a cappella section, or compare with one of the built-in singers.',
    strengths: [],
    items: [
      {
        id: 'recording',
        priority: 1,
        dimension: 'recording',
        title: 'Use a clearer reference clip',
        whatWeHeard: n === 0 ? 'No style measures could be taken from the reference clip.' : `Only ${n} style measure${n === 1 ? '' : 's'} could be taken from the reference clip.`,
        whyItMatters:
          'The reference targets come from measuring the clip. With backing music, effects or very little singing in it, ' +
          'there is almost nothing to measure, and a match score would say nothing about your voice.',
        howToFix: [
          'Use an isolated vocal (a vocal stem) or an a cappella section with at least 10 seconds of singing.',
          'Pick a section with a few held notes and a phrase or two that climbs.',
          'Until then, compare your take with the built-in singer profiles.',
        ],
        exerciseIds: [],
      },
    ],
    signatureFocus: [],
    healthNotes: [...GENERAL_HEALTH_NOTES],
    nextTake: 'Load a clearer reference clip, then compare this take with it again.',
  };
}

// ---------------------------------------------------------------------------------------------

export function buildCoachingPlan(analysis: VoiceAnalysis, comparison: Comparison, profile: SingerProfile): CoachingPlan {
  if (!isScoreable(analysis, comparison)) return unscoreablePlan(analysis, comparison, profile);
  const flavour = flavourOf(profile);
  const light = lightWordFor(analysis);
  // On a speech-like take only the tone measures mean anything; registers, flips, runs, vibrato and
  // the rest need held, sung notes. The others are left out of items, strengths and move hints.
  const speechLike = issuesOf(analysis).includes('speech-like');
  const dimensions = comparison.dimensions.filter((d) => !speechLike || SPEECH_RELIABLE.has(d.key));
  const measured = dimensions.filter((d) => d.value !== null && Number.isFinite(d.value) && d.direction !== 'unknown');
  const byKey = new Map(dimensions.map((d) => [d.key, d]));
  // What each dimension needs. Something the target doesn't do at all (flips or runs in a reference
  // clip that has none) must not be pushed up either, so drills and cues that add it are left out.
  const needs = new Map<StyleKey, Direction>(
    dimensions.map((d) => [d.key, d.direction !== 'more' && lacksTrait(d, 'more') ? 'less' : d.direction]),
  );

  const hasRecording = analysis.warnings.length > 0 || issuesOf(analysis).length > 0;
  const hasRange = singerPassaggioLow(profile) !== null && Math.abs(comparison.suggestedTransposeSemitones) >= RANGE_ITEM_SEMITONES;
  const dimSlots = Math.min(MAX_DIMENSION_ITEMS, MAX_ITEMS - Number(hasRecording) - Number(hasRange));

  // Biggest weighted gap first: a big miss on a defining trait beats a small miss on a minor one.
  const outside = measured
    .filter((d) => d.score < ITEM_SCORE_THRESHOLD && (d.direction === 'more' || d.direction === 'less'))
    .sort((a, b) => b.target.weight * (100 - b.score) - a.target.weight * (100 - a.score));
  // Never coach toward more rasp, or toward what the health notes call pushing.
  const held = outside.filter(isUnsafeMore);
  // Register shares add up to one, so "less mix" means more chest or more falsetto. When the take
  // needs more chest and not more falsetto, the mix item's "release into falsetto" cues would
  // contradict the chest item (or coach toward chest weight the plan holds back), so it is dropped.
  const dirOf = (key: StyleKey): Direction | undefined => byKey.get(key)?.direction;
  const mixWantsChest = dirOf('chestInUpperRange') === 'more' && dirOf('headInUpperRange') !== 'more';
  const gaps: DimensionResult[] = [];
  for (const d of outside) {
    if (isUnsafeMore(d) || (d.key === 'mixInUpperRange' && d.direction === 'less' && mixWantsChest)) continue;
    // Two items that move the registers the same way would repeat each other: the bigger gap stays.
    const group = REGISTER_GROUP[`${d.key}-${d.direction}`];
    if (group && gaps.some((g) => REGISTER_GROUP[`${g.key}-${g.direction}`] === group)) continue;
    gaps.push(d);
  }

  const items: CoachingItem[] = [];
  if (hasRecording) items.push(recordingItem(analysis, comparison, true));
  gaps.slice(0, dimSlots).forEach((d, rank) => {
    // On speech the recording is the only thing to work on first.
    const priority: 1 | 2 | 3 = speechLike && hasRecording ? (rank === 0 ? 2 : 3) : rank === 0 ? 1 : rank === 1 ? 2 : 3;
    items.push(dimensionItem(d, d.direction as FixDirection, priority, profile, analysis, flavour, light, needs));
  });
  if (hasRange) items.push(rangeItem(comparison, profile, analysis, light));
  // Stable sort keeps the recording item ahead of an equal-priority dimension item.
  items.sort((a, b) => a.priority - b.priority);

  // A plan that suggests a higher key must not also say "move the song down" without saying from
  // where: those cues become relative to the suggested key.
  const keyUp = comparison.suggestedTransposeSemitones > 0;
  const rel = (text: string) => (keyUp ? relativeToSuggestedKey(text) : text);
  for (const item of items) item.howToFix = item.howToFix.map(rel);

  return {
    profileId: profile.id,
    headline: headline(comparison, profile, measured, gaps, held, analysis, light),
    strengths: pickStrengths(measured, profile, light),
    items,
    signatureFocus: signatureFocus(profile, byKey, light),
    healthNotes: healthNotes(analysis, profile.source === 'reference' ? 'generic' : flavour, speechLike).map(rel),
    nextTake: nextTake(items, profile, analysis, light),
  };
}

/** Rewords "take the song lower" advice so it reads as lower than the suggested (higher) key. */
function relativeToSuggestedKey(text: string): string {
  return text
    .replace('try the song a little lower.', 'try it a semitone or two below the suggested key.')
    .replace('back off or move the song down.', 'back off or sing it a semitone or two below the suggested key.')
    .replace('move the song down a few semitones.', 'sing it a few semitones below the suggested key.');
}
