// Turns a comparison into a prioritised, singer-specific coaching plan.
//
// The technique cues come from a content matrix indexed by dimension x direction, with extra cues
// for each builtin singer. Everything is phrased to be vocally safe: no cue asks for more volume or
// effort. When a dimension wants "more" (more chest, a steeper climb, more rasp) the cues work
// through vowel shape, fold closure and brightness, never pushing, and rasp is always optional.

import { midiToNoteName } from '../dsp/music';
import type {
  CoachingItem,
  CoachingPlan,
  Comparison,
  DimensionResult,
  SingerProfile,
  StyleKey,
  TargetBand,
  VoiceAnalysis,
} from '../types';
import { describeWithNumber } from './compare';
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

type Flavour = 'shawn' | 'daniel' | 'jalen' | 'generic';
type FixDirection = 'more' | 'less';

/** Dimensions scoring below this become coaching items (inside the band always scores >= 80). */
const ITEM_SCORE_THRESHOLD = 78;
const STRENGTH_SCORE = 80;
const MAX_DIMENSION_ITEMS = 4;
const MAX_ITEMS = 5;
/** Transposition (semitones) at which key advice becomes its own item. */
const RANGE_ITEM_SEMITONES = 3;

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

/** Words plus number without nested brackets: "quite airy, 0.68" / "62% chest". */
function wordsAndNumber(key: StyleKey, v: number): string {
  const words = STYLE_LABELS[key].describe(v);
  return describeIncludesNumber(key) ? words : `${words}, ${formatStyleValue(key, v)}`;
}

/** Lower-cases a title-style name for mid-sentence use, leaving acronyms ("R&B") and quotes alone. */
function nameInSentence(name: string): string {
  return /^[A-Z][a-z]/.test(name) ? lowerFirst(name) : name;
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
}

export const FIXES: Record<StyleKey, Record<FixDirection, FixCell>> = {
  breathiness: {
    more: {
      title: 'Let more air into the tone',
      cues: [
        'Start each phrase on a quiet "h" and let a little of that air stay in the tone for the first word.',
        'Bring the volume down a notch: an airy tone lives between speaking and soft singing, not at full voice.',
        'Sigh the phrase on "hah" first, then sing it with the same easy airflow.',
        'Sing a little closer to the mic, about a hand\'s width away, so the soft detail still comes through.',
      ],
      singerCues: {
        daniel: [
          'Sing as if to one person in a quiet room: close mic, low volume, air in the tone. Daniel\'s verses sit near speaking level.',
          'Let the ends of phrases fade out on air instead of cutting them off.',
        ],
        shawn: ['Use the airier, speech-like tone for quiet verses and save the clearer tone for the chorus, as Shawn does.'],
        jalen: ['In falsetto, allow a soft edge of air as the note starts, then let it clear as the note settles.'],
      },
      exercises: ['aspirate-onsets', 'airy-falsetto-float', 'straw-phonation-slides'],
    },
    less: {
      title: 'Clear up the tone',
      cues: [
        'Firm up fold closure gently: sing the phrase on "nay" or "nee" first, then go back to the words with the same buzz.',
        'Use less air rather than more push. Picture the tone as a thin, focused line instead of a sigh.',
        'Start notes with a balanced onset (air and sound together), not an "h".',
        'Brighten the vowel slightly (toward "eh" or "ih") so the tone has more of a core.',
      ],
      singerCues: {
        jalen: [
          'Jalen\'s falsetto is sweet and ringing, not breathy. Hum the line on "ng" to find a clear falsetto, then open to the vowel.',
        ],
        shawn: ['For choruses, find the clearer, forward chest-mix of "nay". Shawn\'s choruses have little air in them.'],
        daniel: ['Even Daniel\'s airy sound has a core under it: keep some air, but make sure the pitch centre is clearly audible.'],
      },
      exercises: ['balanced-onsets', 'nay-bright-mix', 'straw-phonation-slides'],
      singerExercises: { jalen: ['soul-falsetto-forward'] },
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
        shawn: ['Shawn\'s choruses ride a bright, forward sound. Aim it at the front of your face and keep the jaw loose.'],
        jalen: ['Jalen\'s falsetto is sweet and ringing. Keep a bright "ee"-like placement even on open vowels.'],
      },
      exercises: ['nay-bright-mix', 'ng-siren', 'vowel-narrowing'],
      singerExercises: { jalen: ['soul-falsetto-forward'] },
    },
    less: {
      title: 'Warm up and round the tone',
      cues: [
        'Round the mouth shape a little, as if there were an "oh" inside the "ah".',
        'Release the smile and the tongue, and let the soft palate lift as at the start of a yawn, without pressing the larynx down.',
        'Take the volume down slightly; brightness often climbs with effort.',
        'Hum the phrase first, then open into the words, keeping the warm quality of the hum.',
      ],
      singerCues: {
        daniel: [
          'Daniel\'s tone is warm and a little dark in the middle. Sing close to the mic at low volume with rounded vowels, as if singing to someone beside you.',
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
        shawn: ['Shawn\'s grit shows up only on the top of a few chorus notes; his verses are clean. Match that: clean first, texture as a brief colour.'],
        jalen: ['Jalen keeps his growl for a climactic word or two. Everything around it is clean and sweet.'],
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
        daniel: ['Daniel\'s sound is almost entirely clean; his rawness is a soft crack or a thin edge, not grit.'],
        jalen: ['Jalen\'s tone is clean and sweet most of the time; he saves any growl for a few climactic words.'],
        shawn: ['Shawn\'s verses are clean; any grit is a brief colour on the loudest chorus notes, not the whole line.'],
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
        jalen: ['Jalen\'s held falsetto notes carry a slight, quick tremble. Practise sustained falsetto "hoo" notes and let the vibrato arrive by itself.'],
        shawn: ['Shawn tends to let vibrato in at the ends of long chorus notes: hold straight for the first beat, then let it go.'],
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
        daniel: ['Daniel\'s falsetto lines are close to straight; any vibrato comes late and small.'],
        shawn: ['Shawn starts most notes straight; vibrato is a release at the end, not a constant.'],
      },
      exercises: ['straight-then-vibrato', 'drone-tuning'],
    },
  },
  vibratoRateHz: {
    more: {
      title: 'Free up a quicker vibrato',
      cues: [
        'A slow, wide wobble often comes from too much weight: lighten the note and bring the volume down a little.',
        'Do the pulse drill: begin with slow half-step pulses and speed them up gradually to about five or six a second.',
        'Keep the jaw and tongue still. The vibrato should come from a free, balanced voice, not from movement.',
      ],
      singerCues: {
        jalen: ['Jalen\'s falsetto vibrato is quick and shimmering. Lightening the note is usually what lets it speed up.'],
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
        daniel: ['Daniel\'s occasional vibrato is gentle and unhurried; let it be slow and small.'],
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
        jalen: ['Jalen\'s held-note tremble is quick and fairly narrow; a wide wobble sounds operatic rather than Motown.'],
        daniel: ['Daniel\'s vibrato is small and gentle; keep it barely there.'],
        shawn: ['Shawn\'s vibrato is fairly narrow; a wide wobble sounds more like musical theatre than pop.'],
      },
      exercises: ['straight-then-vibrato', 'drone-tuning', 'messa-di-voce'],
    },
  },
  chestInUpperRange: {
    more: {
      title: 'Carry more speech-like strength up top',
      cues: [
        'Speak the high line at a lively speaking pitch first, then sing it with the same connection.',
        'Use "nay" or "gug" to keep the folds closing as you climb, instead of flipping to a light, airy falsetto.',
        'Keep the volume moderate: chest colour comes from firmer closure and a brighter vowel, not from shouting.',
        'Only go as high as stays comfortable. If it pinches, back off or move the song down.',
      ],
      singerCues: {
        shawn: [
          'Shawn\'s choruses sit on a strong, chest-coloured mix (around A4–B♭4 in his keys). Aim for that speech-like strength just above your passaggio, but keep it easy.',
        ],
        jalen: ['Jalen\'s climaxes switch to a fuller, reedy chest-mix. Practise it on one line, bright and moderate in volume, never shouted.'],
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
        shawn: ['Even Shawn\'s strongest choruses are a mix, not shouted chest: keep the core, lose some weight.'],
        daniel: ['Above the passaggio Daniel lightens into a soft mix or falsetto rather than carrying chest up.'],
        jalen: ['Jalen sings most high lines in falsetto and saves chest for the climax; let the rest go light.'],
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
        shawn: ['This is the core of Shawn\'s chorus sound: bright, speech-like and connected. Build it on "nay" before singing the words.'],
        daniel: ['Daniel\'s mix is soft and light, a bridge he can float up from into falsetto. Keep it quiet.'],
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
        jalen: ['Jalen commits to falsetto for whole lines. Find it on "ng", then sing the line there without drifting back into a mix.'],
        daniel: ['Daniel lifts hooks into a light falsetto; let those notes float rather than holding them in a mix.'],
      },
      exercises: ['falsetto-flip-leap', 'octave-slide-wee-oo', 'airy-falsetto-float'],
      singerExercises: { jalen: ['soul-falsetto-forward'] },
    },
  },
  headInUpperRange: {
    more: {
      title: 'Let high notes float into falsetto',
      cues: [
        'Let the high notes go into falsetto or head voice: lighten up and let the voice flip up rather than carrying weight.',
        'Start the top notes of a phrase softly on "hoo" or "oo", then add the words.',
        'Keep the falsetto supported with steady airflow so it doesn\'t collapse into breath.',
      ],
      singerCues: {
        jalen: ['Jalen often sings whole lines in falsetto. Practise holding an entire phrase there, with a sweet, forward placement.'],
        daniel: ['Daniel lifts hooks and emotional peaks into a light, airy falsetto. Let those notes float instead of belting them.'],
        shawn: ['Shawn saves falsetto for contrast on tags and final choruses. Try the last line of a chorus in falsetto.'],
      },
      exercises: ['octave-slide-wee-oo', 'falsetto-flip-leap', 'ng-siren'],
      singerExercises: { jalen: ['soul-falsetto-forward'], daniel: ['airy-falsetto-float'] },
    },
    less: {
      title: 'Connect falsetto back into your mix',
      cues: [
        'Bridge down from falsetto into mix on "hoo" so the two registers meet.',
        'Use "gug" or "nay" to add a little fold closure without pushing.',
        'Keep the vowel narrow and the volume moderate so high notes stay connected instead of flipping.',
      ],
      singerCues: {
        shawn: ['Shawn keeps most chorus notes in a chest-coloured mix and uses falsetto as contrast.'],
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
        shawn: ['Shawn\'s choruses grow in intensity. Get that lift from a brighter, more forward vowel ("nay"), and keep the throat as free as in the verse.'],
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
        daniel: ['Daniel stays level or gets softer as he goes up into falsetto. Let the top of the phrase get lighter, not louder.'],
        jalen: ['Jalen\'s falsetto lines stay even as they rise. Keep the volume flat and let the placement do the work.'],
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
        daniel: ['Daniel\'s runs are short gospel-rooted turns at phrase ends, intentional rather than showy.'],
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
        shawn: ['Shawn starts verses soft and speech-like and builds into the chorus. Give your take the same arc.'],
        jalen: ['Jalen contrasts restrained falsetto with a few full-voiced moments. Keep most of it gentle so the climax stands out.'],
        daniel: ['Daniel stays quiet for most of a song and swells at the climax; save your fullest sound for one moment.'],
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
        daniel: ['Daniel keeps most of a song in a narrow, quiet range and swells only at the climax.'],
        jalen: ['Jalen\'s delivery is restrained; the big moments are rare.'],
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
        daniel: ['Daniel\'s phrases often begin on a breathy, hushed onset, as if the words start mid-breath.'],
      },
      exercises: ['aspirate-onsets', 'airy-falsetto-float'],
    },
    less: {
      title: 'Start phrases cleanly',
      cues: [
        'Start phrases with a balanced onset: breath and sound begin together.',
        'Begin words as you would in speech, cleanly and without a sigh.',
        'Avoid hard glottal clicks; aim for balanced, not pressed.',
      ],
      singerCues: {
        shawn: ['Shawn\'s verse onsets are speech-like: the air is in the tone, not in front of it.'],
        jalen: ['Jalen starts falsetto notes cleanly and sweetly; too many airy starts make falsetto sound unsupported.'],
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
        jalen: ['Reviewers single out how controlled Jalen\'s falsetto is. Tune the falsetto notes against a reference until they sit still.'],
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
        daniel: ['Daniel flips into falsetto on hooks and emotional peaks, as in "Get You". Try it on the top word of your hook.'],
        shawn: ['Shawn drops suddenly from full voice to light falsetto for contrast. Try it on the last line of a chorus.'],
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
        jalen: ['Jalen stays in falsetto for long stretches and switches on purpose. Choose one register per line.'],
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

function rangeOf(key: StyleKey, band: TargetBand): string {
  return `${formatStyleValue(key, band.low)} to ${formatStyleValue(key, band.high)}`;
}

function heardText(d: DimensionResult, profile: SingerProfile, analysis: VoiceAnalysis): string {
  const key = d.key;
  const v = d.value ?? NaN;
  const t = d.target;
  const target = profile.source === 'reference' ? 'The reference target' : `${whoseOf(profile)} target`;
  const ideal = formatStyleValue(key, t.ideal);
  const onStyle = `${target} is about ${ideal}, with ${rangeOf(key, t)} counting as on-style.`;
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
      const reg = key === 'chestInUpperRange' ? 'chest' : key === 'mixInUpperRange' ? 'mix' : 'falsetto or head voice';
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
    case 'flipsPerMinute':
      return `We heard about ${fixed(v, 1)} register flips (sudden switches into falsetto) per minute of singing. ${onStyle}`;
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
      return `Your tone is ${desc}, in line with ${who}.`;
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

function pickStrengths(measured: DimensionResult[], profile: SingerProfile): string[] {
  const good = measured
    .filter((d) => d.score >= STRENGTH_SCORE)
    .sort((a, b) => b.target.weight - a.target.weight || b.score - a.score)
    .slice(0, 4);
  if (good.length) return good.map((d) => strengthText(d, profile));
  // Nothing on-style yet: name the two closest areas honestly instead of dressing them up.
  return [...measured]
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(
      (d) =>
        `Closest to ${whoOf(profile)} so far: ${SHORT_LABELS[d.key]}, ${describeWithNumber(d.key, d.value ?? NaN)}, ` +
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

function dimensionItem(
  d: DimensionResult,
  direction: FixDirection,
  priority: 1 | 2 | 3,
  profile: SingerProfile,
  analysis: VoiceAnalysis,
  flavour: Flavour,
): CoachingItem {
  const cell = FIXES[d.key][direction];
  const singer = (cell.singerCues?.[flavour] ?? []).slice(0, 2);
  const howToFix = unique([...singer, ...cell.cues]).slice(0, 5);
  const exerciseIds = validExercises([...(cell.singerExercises?.[flavour] ?? []), ...cell.exercises], 3);
  return {
    id: `${d.key}-${direction}`,
    priority,
    dimension: d.key,
    title: cell.title,
    whatWeHeard: heardText(d, profile, analysis),
    whyItMatters: WHY[d.key][flavour],
    howToFix,
    exerciseIds,
  };
}

function recordingItem(warnings: string[]): CoachingItem {
  const text = warnings.join(' ');
  const cues: string[] = [];
  if (/clip|distort|overload|too loud/i.test(text)) {
    cues.push('Lower the input level or step back from the mic so your loudest note does not clip (distort).');
  }
  if (/nois|hum|hiss|background|snr/i.test(text)) {
    cues.push('Record in a quiet, soft-furnished room (curtains and a sofa help), away from fans, fridges and traffic.');
  }
  if (/short|brief|second/i.test(text)) {
    cues.push('Sing for at least 20 to 30 seconds, with a few held notes and at least one phrase above your passaggio.');
  }
  if (/quiet|faint|low level|level is low|too soft/i.test(text)) {
    cues.push('Move a little closer to the mic (about 15 to 30 cm) so your voice stands well clear of the background.');
  }
  if (/voic|pitch|singing|silen/i.test(text)) {
    cues.push('Make sure the take is mostly one voice singing: no speech, long silences, backing vocals or instruments.');
  }
  const fallbacks = [
    'Keep the phone or mic at the same spot each time so takes can be compared fairly.',
    'Turn off noise suppression, auto-gain or effects in your recording app if you can.',
    'Record a new take of the same section and compare the numbers.',
  ];
  for (const f of fallbacks) if (cues.length < 3) cues.push(f);
  return {
    id: 'recording',
    priority: 1,
    dimension: 'recording',
    title: 'Fix the recording first',
    whatWeHeard: `The recording itself was flagged: ${text}`,
    whyItMatters:
      'Breathiness, brightness, rasp and the register estimates all come from fine detail in the sound, so noise, ' +
      'clipping or a very short take can skew them. Treat the numbers in this plan with some caution until the recording is cleaner.',
    howToFix: cues.slice(0, 5),
    exerciseIds: [],
  };
}

function rangeItem(comparison: Comparison, profile: SingerProfile, analysis: VoiceAnalysis): CoachingItem {
  const t = comparison.suggestedTransposeSemitones;
  const n = Math.abs(t);
  const dir = t < 0 ? 'lower' : 'higher';
  const lo = midiToNoteName(analysis.passaggio.lowMidi);
  const hi = midiToNoteName(analysis.passaggio.highMidi);
  const zone = lo && hi ? ` (around ${lo}–${hi})` : '';
  const fitsWhose = profile.source === 'reference' ? 'the original fits the reference singer' : `the original fits ${whoseOf(profile)} voice`;
  const howToFix = [
    `Move the backing track ${t < 0 ? 'down' : 'up'} about ${n} semitones with a key or pitch-shift setting, or play the chords in the new key.`,
    `Choose a key where the highest chorus notes sit a little above your passaggio${zone}, not far above it.`,
    'Record the same section in the new key and compare the scores with this take.',
  ];
  if (n >= 10) {
    // Near an octave, singing the melody an octave away (plus a small key change) is the more natural fix.
    const residual = t - Math.sign(t) * 12;
    const extra =
      residual === 0 ? '' : ` and move the key about ${Math.abs(residual)} semitone${Math.abs(residual) === 1 ? '' : 's'} ${residual < 0 ? 'lower' : 'higher'}`;
    howToFix.push(
      `Or sing the melody an octave ${t < 0 ? 'lower' : 'higher'}${extra}. That suits your range, but the notes land in a different ` +
        'part of your voice than in the original, so compare tone and phrasing more than the register numbers.',
    );
  }
  return {
    id: 'range',
    priority: 2,
    dimension: 'range',
    title: `Try the songs about ${n} semitones ${dir}`,
    whatWeHeard: comparison.rangeNote,
    whyItMatters:
      `The mix and falsetto measurements depend on where the melody sits relative to your passaggio. In a key that fits your ` +
      `voice the way ${fitsWhose}, the same phrases land in the same part of your voice, and high notes need no extra push.`,
    howToFix,
    exerciseIds: validExercises(['lip-trill-siren'], 1),
  };
}

// ---------------------------------------------------------------------------------------------
// Signature focus, health notes, headline, next take

function gapOf(d: DimensionResult): number {
  return d.target.weight * (100 - d.score);
}

function signatureFocus(profile: SingerProfile, byKey: Map<StyleKey, DimensionResult>): CoachingPlan['signatureFocus'] {
  const candidates = profile.signatureMoves.map((move, index) => ({
    move,
    index,
    mapped: (MOVE_FOCUS[move.id] ?? []).length > 0,
    related: (MOVE_FOCUS[move.id] ?? [])
      .map((k) => byKey.get(k))
      .filter((d): d is DimensionResult => d !== undefined && d.value !== null && Number.isFinite(d.value)),
  }));
  const used = new Set<StyleKey>();
  const out: CoachingPlan['signatureFocus'] = [];
  // Greedy: each pick is the move whose most-needed measured dimension (ignoring dimensions an
  // earlier pick already covers) has the largest weighted gap, so two picks don't repeat one hint.
  // Moves about unmeasured things (timing) come last.
  while (out.length < 2 && candidates.length) {
    const scored = candidates.map((c) => {
      const fresh = c.related.filter((d) => !used.has(d.key));
      const focus = [...(fresh.length ? fresh : c.related)].sort((a, b) => gapOf(b) - gapOf(a))[0];
      const need = focus ? gapOf(focus) * (fresh.length ? 1 : 0.5) : 0;
      return { c, focus, need };
    });
    scored.sort((a, b) => Number(b.c.mapped) - Number(a.c.mapped) || b.need - a.need || a.c.index - b.c.index);
    const best = scored[0];
    candidates.splice(candidates.indexOf(best.c), 1);
    if (best.focus) used.add(best.focus.key);
    out.push({ moveId: best.c.move.id, hint: moveHint(best.c.move, best.c.mapped, best.focus, profile) });
  }
  return out;
}

function moveHint(
  move: SingerProfile['signatureMoves'][number],
  mapped: boolean,
  focus: DimensionResult | undefined,
  profile: SingerProfile,
): string {
  const firstStep = move.howTo[0] ? ` Start here: ${lowerFirst(move.howTo[0])}` : '';
  if (!mapped) return `The app doesn't measure this, so judge it by ear against the original.${firstStep}`;
  if (!focus) return `This take didn't give us enough to measure what this move trains, so record a section built around it.${firstStep}`;
  if (focus.score < ITEM_SCORE_THRESHOLD && (focus.direction === 'more' || focus.direction === 'less')) {
    const goal = lowerFirst(FIXES[focus.key][focus.direction].title);
    const v = focus.value ?? NaN;
    const heard = describeIncludesNumber(focus.key) ? compactValue(focus.key, v) : describeWithNumber(focus.key, v);
    const now = `${heard} vs about ${formatStyleValue(focus.key, focus.target.ideal)} for ${whoOf(profile)}`;
    return `${capitalize(SHORT_LABELS[focus.key])} in this take: ${now}. Use this move to ${goal}.${firstStep}`;
  }
  const verb = PLURAL_LABELS.has(focus.key) ? 'fit' : 'fits';
  return `Your ${SHORT_LABELS[focus.key]} already ${verb} ${whoseOf(profile)} style (${wordsAndNumber(focus.key, focus.value ?? NaN)}), so this is a good next layer of the sound.${firstStep}`;
}

function healthNotes(analysis: VoiceAnalysis, flavour: Flavour): string[] {
  const s = analysis.style;
  const notes = [
    'Warm up for a few minutes with lip trills, humming or a straw before working on high notes. Keep sessions short and ' +
      'focused, keep water nearby, and stop if you feel pain, tickling or tightness. Rest beats pushing through.',
  ];
  if (s.loudnessClimbDbPerSemitone !== null && s.loudnessClimbDbPerSemitone > 1) {
    notes.push(
      `Your volume rose about ${fixed(s.loudnessClimbDbPerSemitone, 1)} dB per semitone above the passaggio, which usually means ` +
        'chest weight is being pushed up. Lighten the note and narrow the vowel rather than singing harder, and if the top ' +
        'notes only work loud, move the song down a few semitones.',
    );
  }
  if (s.chestInUpperRange !== null && s.chestInUpperRange > 0.6) {
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

function joinLabels(ds: DimensionResult[]): string {
  const labels = ds.map((d) => SHORT_LABELS[d.key]);
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function headline(
  comparison: Comparison,
  profile: SingerProfile,
  measured: DimensionResult[],
  gaps: DimensionResult[],
  analysis: VoiceAnalysis,
): string {
  const target = profile.source === 'reference' ? 'the reference clip' : profile.name;
  const who = whoOf(profile);
  if (measured.length === 0) {
    const from = midiToNoteName(analysis.passaggio.lowMidi);
    return (
      `We couldn't measure enough of this take to compare it with ${target}. Record at least 20 to 30 seconds of singing, ` +
      `with some held notes and a phrase above your passaggio${from ? ` (from ${from})` : ''}.`
    );
  }
  const sentences = [`Overall match with ${target}: ${comparison.overall}/100, ${verdict(comparison.overall)}.`];
  const close = measured
    .filter((d) => d.score >= STRENGTH_SCORE)
    .sort((a, b) => b.target.weight - a.target.weight)
    .slice(0, 2);
  if (gaps.length) {
    const top = gaps[0];
    const numbers = `${compactValue(top.key, top.value ?? NaN)} vs about ${formatStyleValue(top.key, top.target.ideal)}`;
    const rest = gaps.length > 1 ? `, followed by ${SHORT_LABELS[gaps[1].key]}` : '';
    const lead = close.length
      ? `Your ${joinLabels(close)} already ${close.length > 1 || PLURAL_LABELS.has(close[0].key) ? 'sit' : 'sits'} in ${whoseOf(profile)} zone; the biggest gap is`
      : 'The biggest gap is';
    sentences.push(`${lead} ${SHORT_LABELS[top.key]} (${numbers})${rest}.`);
  } else {
    sentences.push(`Every measured dimension is close to ${whoseOf(profile)} targets, so the signature moves below are your next step.`);
  }
  if (analysis.warnings.length) {
    sentences.push('Some numbers may be skewed by the recording itself, so start with the recording tips.');
  } else if (Math.abs(comparison.suggestedTransposeSemitones) >= RANGE_ITEM_SEMITONES) {
    const t = comparison.suggestedTransposeSemitones;
    sentences.push(`The take also sat about ${Math.abs(t)} semitones ${t < 0 ? 'lower' : 'higher'} than ${who} usually sings, so try a new key too.`);
  }
  return sentences.join(' ');
}

function nextTake(items: CoachingItem[], profile: SingerProfile): string {
  const first = items[0];
  if (!first) {
    const move = profile.signatureMoves[0];
    return move
      ? `Record a new section built around ${whoseOf(profile)} ${move.name.toLowerCase()} and see whether the match holds.`
      : 'Record a new section of a different song and see whether the match holds.';
  }
  if (first.dimension === 'recording') {
    return 'Re-record the same section in a quieter spot with the level set a little lower, so the next analysis can be trusted.';
  }
  const ex = first.exerciseIds.map((id) => getExercise(id)).find((e) => e !== undefined);
  const focus = `the same section again with one focus: ${lowerFirst(first.title)}.`;
  return ex ? `After ${ex.durationMin} minutes of ${nameInSentence(ex.name)}, record ${focus}` : `Record ${focus}`;
}

// ---------------------------------------------------------------------------------------------

export function buildCoachingPlan(analysis: VoiceAnalysis, comparison: Comparison, profile: SingerProfile): CoachingPlan {
  const flavour = flavourOf(profile);
  const measured = comparison.dimensions.filter((d) => d.value !== null && Number.isFinite(d.value) && d.direction !== 'unknown');
  const byKey = new Map(comparison.dimensions.map((d) => [d.key, d]));

  const hasRecording = analysis.warnings.length > 0;
  const hasRange = Math.abs(comparison.suggestedTransposeSemitones) >= RANGE_ITEM_SEMITONES;
  const dimSlots = Math.min(MAX_DIMENSION_ITEMS, MAX_ITEMS - Number(hasRecording) - Number(hasRange));

  // Biggest weighted gap first: a big miss on a defining trait beats a small miss on a minor one.
  const gaps = measured
    .filter((d) => d.score < ITEM_SCORE_THRESHOLD && (d.direction === 'more' || d.direction === 'less'))
    .sort((a, b) => b.target.weight * (100 - b.score) - a.target.weight * (100 - a.score));

  const items: CoachingItem[] = [];
  if (hasRecording) items.push(recordingItem(analysis.warnings));
  gaps.slice(0, dimSlots).forEach((d, rank) => {
    const priority: 1 | 2 | 3 = rank === 0 ? 1 : rank === 1 ? 2 : 3;
    items.push(dimensionItem(d, d.direction as FixDirection, priority, profile, analysis, flavour));
  });
  if (hasRange) items.push(rangeItem(comparison, profile, analysis));
  // Stable sort keeps the recording item ahead of an equal-priority dimension item.
  items.sort((a, b) => a.priority - b.priority);

  return {
    profileId: profile.id,
    headline: headline(comparison, profile, measured, gaps, analysis),
    strengths: pickStrengths(measured, profile),
    items,
    signatureFocus: signatureFocus(profile, byKey),
    healthNotes: healthNotes(analysis, flavour),
    nextTake: nextTake(items, profile),
  };
}
