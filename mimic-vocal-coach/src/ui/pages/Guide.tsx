// Guide: plain-language background on mixed voice, what the app measures and its limits, how to
// record, how the singer profiles were made, vocal health and privacy.

import { useEffect, type ReactNode } from 'react';
import { passaggioFor, VOICE_TYPE_NAMES } from '../../analysis/passaggio';
import { midiToNoteName } from '../../dsp/music';
import { useApp } from '../../state/context';
import { parseSection } from '../../state/routing';
import { SPLEETER_MIT_NOTICE, SPLEETER_SUMMARY, SPLEETER_URL } from '../../audio/separation/licence';
import { IMPORT_FORMATS, ISOLATE_LIMIT_TEXT, ISOLATED_TONE_NOTE, PROTECTED_HELP, STEM_HELP, VIDEO_HELP } from '../../trainer/importCopy';
import type { VoiceType } from '../../types';

const SECTIONS = [
  { id: 'guide-mix', title: 'What mixed voice is' },
  { id: 'guide-passaggio', title: 'The passaggio' },
  { id: 'guide-measures', title: 'What Mimic measures' },
  { id: 'guide-recording', title: 'Recording a good take' },
  { id: 'guide-vocal', title: 'Getting a vocal onto your phone' },
  { id: 'guide-stems', title: 'Full songs and vocal stems' },
  { id: 'guide-isolate', title: 'Pulling the vocal out of a song (AI)' },
  { id: 'guide-modes', title: 'Sing along, or listen then sing' },
  { id: 'guide-headphones', title: 'Headphones and AirPods' },
  { id: 'guide-trainer-scores', title: 'What the Trainer scores, and what it cannot hear' },
  { id: 'guide-profiles', title: 'How the singer profiles were made' },
  { id: 'guide-health', title: 'Look after your voice' },
  { id: 'guide-privacy', title: 'Privacy' },
] as const;

const VOICE_TYPES = Object.keys(VOICE_TYPE_NAMES) as VoiceType[];

interface Measure {
  name: string;
  what: ReactNode;
  limits: ReactNode;
}

const MEASURES: Measure[] = [
  {
    name: 'Pitch and accuracy',
    what: 'Your pitch is tracked every 10 ms. Accuracy is the average distance of your held notes from the nearest semitone, in cents (100 cents = one semitone), after allowing for a take that is consistently a little sharp or flat overall.',
    limits: 'Deliberate slides, scoops and blue notes count as "off". Very breathy or very quiet notes can drop out of the trace.',
  },
  {
    name: 'Breathiness',
    what: 'How much air is in the tone. It combines cues such as how much stronger the first harmonic is than the second (H1–H2), how clearly periodic the voice is (cepstral peak prominence, CPP) and the harmonics-to-noise ratio.',
    limits:
      'Vowels change H1–H2 on their own ("oo" and "ee" read airier than "ah"), and so do distance from the mic and a noisy room. It also depends on how much bass the microphone picks up: phone and laptop mics that cut the low end read cleaner than a studio mic. Compare your progress on the same device.',
  },
  {
    name: 'Brightness',
    what: 'How forward or ringing the tone is versus dark and warm, from the balance of high to low frequencies (alpha ratio, spectral centroid and slope).',
    limits: 'The vowel and the microphone colour this strongly. Compare takes made with the same phone, distance and lyric.',
  },
  {
    name: 'Rasp',
    what: 'Grit or roughness: irregular cycles and energy between the harmonics, mostly on louder notes.',
    limits: 'Clipping, a noisy room or a rattling phone case can look like rasp.',
  },
  {
    name: 'Vibrato',
    what: 'How many held notes carry vibrato, how fast it is (cycles per second) and how wide it swings (± cents).',
    limits: 'Needs held notes of about half a second or longer; a take of short notes has no vibrato to measure.',
  },
  {
    name: 'Chest, mix and head above the passaggio',
    what: 'For each moment of singing at or above the bottom of your passaggio, Mimic estimates whether the sound is chest-dominant, mixed or head/falsetto from the harmonic balance, spectral slope, clarity and how loudness changes with pitch, then reports the shares.',
    limits:
      'These are estimates from the sound, not a view of your vocal folds. They are most reliable on open vowels such as "ah" and "eh"; closed vowels ("oo", "ee") shift the cues. A pressed head voice or a breathy chest voice can be misread, and the estimate cannot tell a breathy falsetto from a clear head voice, so both count as head/falsetto.',
  },
  {
    name: 'Loudness climb',
    what: 'How many decibels you gain per semitone as you go up through your upper range. A steep climb usually means carrying chest weight up (pushing), which is what mix is meant to avoid.',
    limits: 'A deliberate crescendo on a climbing line also raises it.',
  },
  {
    name: 'Flips, onsets, runs and dynamics',
    what: 'Flips are sudden switches into head voice with a jump in pitch. Soft onsets are phrase starts that begin with air. Agility is notes per second in fast runs. Dynamic range is the spread between your loud and soft singing.',
    limits: 'Counted from one take, so a short take gives rough numbers. A take without runs simply has no agility score.',
  },
  {
    name: 'Recording checks',
    what: 'Clipping (distortion from recording too loud), the background noise level and how far your voice sits above it.',
    limits: 'When a take is flagged, fix the recording first: every other number depends on it.',
  },
];

/** Scroll to a section and move keyboard focus to its heading, so the next Tab continues from there. */
function jump(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  let reduce = false;
  try {
    reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // No matchMedia: plain scroll.
  }
  section.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

export function GuidePage() {
  const app = useApp();
  const voiceType = app.state.settings.voiceType;

  // A link such as #guide/guide-vocal opens the guide at that section.
  useEffect(() => {
    const open = () => {
      const id = parseSection(window.location.hash);
      if (id && document.getElementById(id)) jump(id);
    };
    const raf = requestAnimationFrame(open);
    window.addEventListener('hashchange', open);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('hashchange', open);
    };
  }, []);

  return (
    <div className="page page--guide">
      <header className="page-head">
        <p className="eyebrow">Guide</p>
        <h1 className="page-title">How Mimic listens, and how to use it well</h1>
        <p className="lede">
          Mimic helps you study the sound of singers you admire, especially how they blend chest and head voice. It is a practice tool: it
          estimates from audio, it does not diagnose, and it cannot replace a good teacher’s ears.
        </p>
      </header>

      <nav className="guide-toc" aria-label="On this page">
        <ol>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <button type="button" className="link-button" onClick={() => jump(s.id)}>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <article className="prose">
        <section id="guide-mix" aria-labelledby="guide-mix-h">
          <h2 id="guide-mix-h" tabIndex={-1}>What mixed voice is</h2>
          <p>
            Your vocal folds can vibrate in a heavier, <strong>chest-dominant</strong> way, where they are thicker and stay in contact for
            longer in each cycle, or a lighter, <strong>head-dominant</strong> way, where they are stretched thinner. Two sets of muscles
            balance this: the thyroarytenoid muscles inside the folds (more active in chest) and the cricothyroid muscles that stretch
            them (more active as you go up and get lighter).
          </p>
          <p>
            <strong>Mixed voice</strong> is what many teachers call a coordination in between: keeping some of chest voice’s clarity and
            strength while letting the folds thin out as the pitch rises, so the voice stays connected instead of cracking, shouting or
            flipping. The terminology is genuinely debated. Some teachers describe mix as its own register, some as a way of shaping
            resonance on top of chest or head voice, and voice scientists usually describe a continuum of muscle balance rather than a
            separate mechanism. Whatever the label, the goal is the same: easy, connected singing through the middle of your range.
          </p>
          <p>
            That middle is where a lot of pop, R&amp;B and soul melodies sit, which is why how a singer balances weight and lightness there
            is a big part of what makes them recognisable.
          </p>
          <p>
            <strong>Falsetto and head voice</strong> both use the lighter, stretched-fold coordination. Falsetto usually means the light,
            often breathy upper register of male voices, where the folds barely close; head voice is the same mechanism with firmer
            closure and a clearer tone. For women, what teachers usually call head voice is this register, so where the coaching says
            falsetto, read it as your light head voice. Mimic cannot tell the two apart from the sound and reports them together as
            head/falsetto.
          </p>
        </section>

        <section id="guide-passaggio" aria-labelledby="guide-passaggio-h">
          <h2 id="guide-passaggio-h" tabIndex={-1}>The passaggio</h2>
          <p>
            The passaggio (Italian for “passage”) is the stretch of pitches where the chest-dominant way of singing gets hard to sustain
            comfortably. Left alone, the voice tends either to get louder and heavier, or to break into falsetto. Mix lives here. Mimic uses
            your voice type to place the zone and treats everything at or above its lower edge as your <em>upper range</em>. These are
            typical zones; your own may sit a note or two either way.
          </p>
          <p>
            The zones below are estimates of where the <em>mix zone</em> sits in contemporary pop and R&amp;B singing. They are set a little
            higher than the classical passaggio points in voice-teaching texts (for a baritone those start around B3), because
            contemporary singers carry a speech-like sound further up before they blend.
          </p>
          <table className="guide-table">
            <caption className="visually-hidden">Typical passaggio zone by voice type</caption>
            <thead>
              <tr>
                <th scope="col">Voice type</th>
                <th scope="col">Typical passaggio</th>
              </tr>
            </thead>
            <tbody>
              {VOICE_TYPES.map((v) => {
                const z = passaggioFor(v);
                return (
                  <tr key={v} aria-current={v === voiceType ? 'true' : undefined}>
                    <th scope="row">
                      {VOICE_TYPE_NAMES[v]}
                      {v === voiceType && <span className="muted"> (yours)</span>}
                    </th>
                    <td className="num">
                      {midiToNoteName(z.lowMidi)}–{midiToNoteName(z.highMidi)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section id="guide-measures" aria-labelledby="guide-measures-h">
          <h2 id="guide-measures-h" tabIndex={-1}>What Mimic measures</h2>
          <p>
            Every number comes from the sound alone, using acoustic measures that voice research links to how the voice is being produced.
            They are <em>proxies</em>: useful for tracking change and for comparing with a target, but influenced by the vowel you sing, your
            microphone and the room. Mimic estimates; it does not diagnose.
          </p>
          <dl className="measure-list">
            {MEASURES.map((m) => (
              <div key={m.name} className="measure">
                <dt>{m.name}</dt>
                <dd>
                  <p>{m.what}</p>
                  <p className="measure-limits">
                    <span className="subhead-inline">Limits</span> {m.limits}
                  </p>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            Each measure is scored for closeness to the selected singer’s target band. A low score means “different from the target”, not
            “bad singing”.
          </p>
        </section>

        <section id="guide-recording" aria-labelledby="guide-recording-h">
          <h2 id="guide-recording-h" tabIndex={-1}>Recording a good take</h2>
          <ul>
            <li>Use a quiet room. Soft furnishings help; fans, fridges and traffic hurt.</li>
            <li>Hold the phone or microphone 20–30 cm from your mouth and keep the distance steady.</li>
            <li>Sing without backing music. Headphones for a guide track are fine.</li>
            <li>Record 15–60 seconds: a phrase or a verse that climbs through your passaggio, so there is mix to measure.</li>
            <li>Watch the level meter: aim for “Good level”. If it says too loud, move back rather than singing softer than you mean to.</li>
            <li>To compare takes fairly, keep the same song, key, vowels, phone and distance.</li>
            <li>If the microphone is not available in your browser, record a voice memo on your phone and upload it.</li>
          </ul>
        </section>

        <section id="guide-vocal" aria-labelledby="guide-vocal-h">
          <h2 id="guide-vocal-h" tabIndex={-1}>Getting a vocal onto your phone</h2>
          <p>
            The Trainer works on audio files you already have. Mimic never downloads music, never searches for it and never uploads it:
            you choose a file from your own phone, it is read here, and it is stored only on this device. Use music you own or have the
            right to practise with.
          </p>
          <ul>
            <li>
              <strong>The Files app.</strong> Anything in On My iPhone or iCloud Drive can be picked, and so can files from Dropbox or
              Google Drive that appear in Files. AirDrop a file from a Mac and save it to Files. In Mimic, open the Trainer, tap{' '}
              <em>Add clips</em> and choose one or several files.
            </li>
            <li>
              <strong>Voice Memos.</strong> Open the memo, tap Share, then Save to Files. Then add it from Files.
            </li>
            <li>
              <strong>Purchased music without copy protection.</strong> Downloads from stores that sell DRM-free files, CD rips and files
              from your computer all work. {PROTECTED_HELP}
            </li>
            <li>
              <strong>Vocal stems.</strong> {STEM_HELP}
            </li>
            <li>
              <strong>Sound from a phone video.</strong> {VIDEO_HELP}
            </li>
          </ul>
          <p>
            Mimic cannot appear in the iPhone Share sheet (a web app cannot), which is why the route is always Files, then <em>Add clips</em>.
            It reads {IMPORT_FORMATS} Shorter is better: pick the part you want to learn, a verse and a chorus rather than the whole
            track, and trim the clip when you add it.
          </p>
        </section>

        <section id="guide-stems" aria-labelledby="guide-stems-h">
          <h2 id="guide-stems-h" tabIndex={-1}>Full songs and vocal stems</h2>
          <p>
            An <strong>isolated vocal</strong> (a stem) or an a cappella section is the best material. Mimic can follow the voice
            exactly, so it can judge pitch, timing, tone (airy, bright, rough) and vibrato, and the clip can also help set a singer’s measured
            targets in the Studio.
          </p>
          <p>
            A <strong>whole song</strong> works too, with limits. Mimic follows the lead vocal through the band by listening for the
            steadiest melody line, and then judges pitch, timing, vibrato and loudness shape. It does <em>not</em> compare tone for a full
            song: the instruments change the sound, so an airy or bright reading would mostly describe the band. The melody it finds can be
            wrong where backing vocals, a doubled guitar line or a loud bass take over, so in the review screen play the detected melody and
            check that it follows the singing before you save. A full song cannot count toward a singer’s measured targets.
          </p>
          <p>
            Mimic first reads the clip as a single voice. If that sounds like a band, it reads it again as a song and shows a{' '}
            <strong>Lead vocal</strong> rating: how well it believes it followed the singing, from its own checks. It is a ranking, not a
            measured accuracy, and it was tuned on synthetic songs, so a real recording can do worse than it says. Below
            “followed well” you get a warning, and “very hard to follow” means the melody is a rough guide at best. Songs where the voice sits
            well in front of a steady band, and some electronic tracks, may not be spotted as songs: if the melody you hear is the bass or a
            guitar, answer “No” to <em>Does the melody follow the singing?</em> or switch on <em>This is a full song</em> yourself.
          </p>
          <p>
            If you have the song and also its vocal-only file, add the song and then the vocal file as its stem: you practise along with the
            whole song while Mimic reads the voice from the stem.
          </p>
        </section>

        <section id="guide-isolate" aria-labelledby="guide-isolate-h">
          <h2 id="guide-isolate-h" tabIndex={-1}>Pulling the vocal out of a song (AI)</h2>
          <p>
            No isolated vocal? Where this copy of Mimic includes the model, <em>Add clips</em> offers <strong>Isolate the vocal first (AI)</strong>, and the review of a
            song offers <strong>Pull the vocal out of the song</strong>. Mimic then separates the voice from the band on your phone and reads that voice on its own, so tone
            can be compared and the clip can count toward a singer’s targets, with the caveats below: it is an approximation of an isolated vocal, not the real thing.
            It is off unless you choose it.
          </p>
          <ul>
            <li>
              <strong>What it costs.</strong> The first time, Mimic downloads about 31 MB from this site (the model, about 19 MB, and the engine that runs it, about 11 MB) and keeps
              them on the phone (Settings shows them and can remove them). Splitting takes minutes, not seconds, and longer on an older phone. It uses a lot of battery and
              warms the phone, so plug it in and keep the screen open; locking the phone can pause it. Mimic starts with 1 minute of the song; you can choose up to 5 minutes at
              a time, and for a longer song, choose where to start.
            </li>
            <li>
              <strong>What you get.</strong> {ISOLATE_LIMIT_TEXT} {ISOLATED_TONE_NOTE} Listen to the isolated vocal in the review before you trust the phrases, and use a
              real isolated vocal file when you have one.
            </li>
            <li>
              <strong>What it keeps.</strong> The isolated vocal becomes the clip’s sound (you do not hear the band while practising it). The clip is marked{' '}
              <em>Isolated vocal (AI)</em>, with the model’s name and version. To go back to the whole song, add the file again without this option.
            </li>
            <li>
              <strong>Privacy.</strong> The model and the engine come from this site only, and the song never leaves the phone.
            </li>
          </ul>
          <details className="imp-more">
            <summary>About the model and its licence</summary>
            <p>{SPLEETER_SUMMARY}</p>
            <p>
              Source: <span className="num">{SPLEETER_URL}</span>
            </p>
            <pre className="licence-text" tabIndex={0} aria-label="Spleeter licence text">
              {SPLEETER_MIT_NOTICE}
            </pre>
          </details>
        </section>

        <section id="guide-modes" aria-labelledby="guide-modes-h">
          <h2 id="guide-modes-h" tabIndex={-1}>Sing along, or listen then sing</h2>
          <p>
            <strong>Sing along</strong> plays the phrase after a short count-in while you sing with it. Your timing is judged against the
            track&apos;s clock, which is the closest thing to singing with the record. It needs headphones: through the speaker the microphone
            hears the guide as well, and the score can end up describing the playback instead of you. Mimic starts in the other mode when no
            headphones look connected, and asks before it lets you sing along without them.
          </p>
          <p>
            <strong>Listen, then sing</strong> plays the phrase and then waits for your turn. There is no shared clock, so timing is judged
            against your own pace: do the notes come at an even speed, and in the right order and lengths relative to each other? It works
            with the speaker, and it is a good way to learn a new phrase before you sing it in time.
          </p>
          <p>
            You can slow the phrase to 90, 75 or 60 percent (50 percent sounds rough, because stretching sound that much leaves artefacts)
            and loop one note or a stretch by tapping it. <em>My key</em> plays the guide in the key you sang last time; the formants move
            with it, so it sounds like a different singer, which is fine for a guide. Slow and half-sung takes build skill but do not count
            toward mastering a phrase: that takes three good tries at full speed.
          </p>
        </section>

        <section id="guide-headphones" aria-labelledby="guide-headphones-h">
          <h2 id="guide-headphones-h" tabIndex={-1}>Headphones and AirPods</h2>
          <ul>
            <li>
              Wired headphones or earbuds are the most dependable: no delay to speak of, and the iPhone&apos;s own microphone stays in use.
            </li>
            <li>
              <strong>AirPods and other Bluetooth headphones</strong> change mode the moment an app opens their microphone: they drop to
              phone-call quality (mono, 8 to 24 kHz) and add delay. Choose the iPhone&apos;s own microphone (Settings, under Your voice, or the
              button the practice screen offers) so the headphones only play the guide.
            </li>
            <li>
              iPhone does not say where sound is going, so Mimic guesses from the name of the microphone it is given. When it cannot tell,
              it says so and asks before you sing along.
            </li>
            <li>
              Every device adds some delay between the guide and what the microphone hears. Mimic measures it from your singing and shows it
              as the <em>sync offset</em>; it is not counted against you. If it is very large (several hundred milliseconds), switch to wired
              headphones or to Listen, then sing. These figures have been checked on a computer, not yet on a range of iPhones, so treat
              them as a guide.
            </li>
            <li>
              If you hear nothing, check the volume and the ring/silent switch: the phone can silence a web page&apos;s sound. A phone call, an
              alarm or another app using the microphone interrupts a take; an interrupted take is not scored, and you tap Try again.
            </li>
            <li>The device checks in Settings (under Trainer) run these tests on your phone and make a report you can copy or save and share with whoever is helping you. It holds no audio.</li>
          </ul>
        </section>

        <section id="guide-trainer-scores" aria-labelledby="guide-trainer-scores-h">
          <h2 id="guide-trainer-scores-h" tabIndex={-1}>What the Trainer scores, and what it cannot hear</h2>
          <p>
            Each take gets one number from 0 to 100: how close you came to the original. It is made of four skills:{' '}
            <strong>pitch</strong> (40 percent: in Listen then sing any key is fine; while singing along only octaves count, so singing an octave lower is not a mistake),{' '}
            <strong>timing</strong> (25: when each note starts and how long it lasts, after the delay of your headphones is taken out),{' '}
            <strong>tone</strong> (20: airier, brighter or rougher than the original, from the same measures as the Studio), and{' '}
            <strong>expression</strong> (15: vibrato, loudness shape and how notes are joined). Under the number it names up to three things
            to fix, ranked by how many points each would win back.
          </p>
          <p>
            It is <em>closeness</em>, not quality. A different voice will always differ in tone, and tone is the weakest of the four. The
            thresholds were set on synthetic voices and a handful of short real recordings, not on ratings by people, so use the numbers to
            see yourself moving, not as a verdict. Short phrases are scored about twice as roughly and are rounded to the nearest 5.
          </p>
          <p>
            <strong>What it cannot hear:</strong> words and diction, the shape of your vowels, feeling, and whether a choice is
            stylish; whether a sound is healthy; and notes below about C2 or above about F6, which its pitch tracker cannot follow
            (it says so instead of marking them wrong). In a full song it cannot hear tone at all. A recording that is already pitch-corrected
            will look more accurate than a live singer ever could. If your first try scores a perfect 100, check that the microphone did not
            pick up the playback.
          </p>
          <p>
            Fixes never ask for more volume or for rasp. If something feels tight, stop and rest.
          </p>
        </section>

        <section id="guide-profiles" aria-labelledby="guide-profiles-h">
          <h2 id="guide-profiles-h" tabIndex={-1}>How the singer profiles were made</h2>
          <p>
            The built-in profiles for Shawn Mendes, Daniel Caesar and Jalen Ngonda are <strong>hand-set estimates</strong>. They describe
            each singer’s sound in terms of the measures above, based on widely shared listening impressions of their released recordings
            (how airy or bright the tone is, how much vibrato, how they handle high notes). They were not measured from the artists’ audio,
            and the artists have nothing to do with this app. The target bands are deliberately wide, and each profile carries its own note
            about this.
          </p>
          <p>
            To replace the estimates with <strong>measurements of the singer’s real voice</strong>, open the singer in the Studio and use{' '}
            <em>Measure from real recordings</em>: add clips of that singer from music you own. Mimic analyses each clip the same way it
            analyses you, refuses clips it can’t measure (full song mixes, speech, too little singing) and says why, then rebuilds the
            singer’s targets from the clips it kept, weighted by how much singing each one has. When the clips disagree, the target bands
            widen to cover that range. The singer’s coaching cues, songs and signature moves stay; only the numbers change. Only the
            measurements are kept, in this browser; the audio is not stored. Use isolated vocals (vocal stems) or a cappella sections: a
            stem-splitter app can pull the vocal out of a song. Released vocals are often pitch-corrected, so tuning keeps a fixed
            “clean” target, and rasp, chest weight and loudness climb stay capped at healthy levels whatever the recordings do.
          </p>
          <p>
            A <strong>reference clip</strong> is the other measured option: one recording of a song you are learning. Mimic centres the
            targets on it and lines your take up against it phrase by phrase (in any key), which shows where you drift from that
            particular performance.
          </p>
          <p>
            Imitation is a way to learn technique, not to replace your voice. Your instrument is different from theirs, so borrow the
            coordination and the choices, and let your own tone come through.
          </p>
        </section>

        <section id="guide-health" aria-labelledby="guide-health-h">
          <h2 id="guide-health-h" tabIndex={-1}>Look after your voice</h2>
          <ul>
            <li>Warm up for 5–10 minutes before working on high notes: humming, lip trills, singing through a straw, gentle sirens.</li>
            <li>Stay hydrated through the day, not just during practice.</li>
            <li>Mix should feel easy. If you need to push to reach a note, go lighter, narrow the vowel, or lower the key.</li>
            <li>Practise in short sessions with breaks, and rest your voice after long or loud days.</li>
            <li>
              Rasp and grit: never manufacture it by squeezing your throat. If imitating a rough sound hurts or leaves you hoarse, stop.
            </li>
            <li>Stop and rest if you feel pain, tightness, scratchiness or hoarseness.</li>
            <li>
              If your voice suddenly cuts out, loses its top notes or turns hoarse during a loud or high note, stop singing straight away,
              rest your voice and get it checked by a laryngologist within a few days. It can be a small bleed on a vocal fold, so don’t wait
              to see whether it passes.
            </li>
            <li>
              If hoarseness or a change in your voice lasts more than two weeks, or singing is painful, see an ENT doctor or laryngologist
              (ideally one who works with singers). A voice-specialist speech therapist can help with recovery.
            </li>
          </ul>
        </section>

        <section id="guide-privacy" aria-labelledby="guide-privacy-h">
          <h2 id="guide-privacy-h" tabIndex={-1}>Privacy</h2>
          <ul>
            <li>
              All analysis runs in your browser. Your takes, reference clips and singer clips are never uploaded. Takes you sing are not
              kept, unless you switch on <em>Keep my recordings</em> in Settings.
            </li>
            <li>
              <strong>Clips and attempts stay on this device.</strong> Clips you add to the Trainer are stored in this browser&apos;s storage on
              this device only, with their phrases and your practice scores. A backup file holds phrases and scores, never audio: when you
              restore one, the clips come back without sound, and the Trainer asks you to choose the original files again (it recognises each
              one by its contents, so your scores stay). Safari can
              clear a website&apos;s stored data after about a week of not using it, so add Mimic to your Home Screen to keep your clips, and
              save a backup now and then.
            </li>
            <li>Saving to Progress keeps only scores and measurements, in this browser’s local storage.</li>
            <li>
              The optional AI coach sends the numeric summary of a take (never audio) to Anthropic, using the API key you enter in Settings.
            </li>
            <li>
              The API key is kept in this site’s local storage in your browser. On a <span className="num">github.io</span> address that
              storage is shared with the site owner’s other GitHub Pages sites, so use a key with a spending limit.
            </li>
            <li>The fonts are bundled with the app, so loading Mimic makes no requests to other sites.</li>
            <li>
              Pulling a vocal out of a song (if you use it) downloads a model file and the engine that runs it from this site, once, and runs on your phone. The song is not sent anywhere.
            </li>
            <li>“Delete everything, including settings” in Settings removes everything Mimic has stored, including the Trainer’s clips and scores and the downloaded vocal-isolation model and engine. “Delete clips and scores” in the Trainer section removes only those.</li>
          </ul>
        </section>
      </article>
    </div>
  );
}
