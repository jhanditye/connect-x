// Guide: plain-language background on mixed voice, what the app measures and its limits, how to
// record, how the singer profiles were made, vocal health and privacy.

import type { ReactNode } from 'react';
import { passaggioFor, VOICE_TYPE_NAMES } from '../../analysis/passaggio';
import { midiToNoteName } from '../../dsp/music';
import { useApp } from '../../state/context';
import type { VoiceType } from '../../types';

const SECTIONS = [
  { id: 'guide-mix', title: 'What mixed voice is' },
  { id: 'guide-passaggio', title: 'The passaggio' },
  { id: 'guide-measures', title: 'What Mimic measures' },
  { id: 'guide-recording', title: 'Recording a good take' },
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
            For a measured target, use a <strong>reference clip</strong>: upload a recording of the artist from music you own. Mimic runs
            the same analysis on it, centres the targets on what it measures, and lines your take up against it phrase by phrase (in any
            key). An isolated vocal or an a cappella section works best. Released vocals are often pitch-corrected, compressed, doubled and
            drenched in reverb, and all of that shifts the numbers.
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
            <li>All analysis runs in your browser. Your recordings and reference clips are never uploaded and are not stored.</li>
            <li>Saving to Progress keeps only scores and measurements, in this browser’s local storage.</li>
            <li>
              The optional AI coach sends the numeric summary of a take (never audio) to Anthropic, using the API key you enter in Settings.
            </li>
            <li>
              The API key is kept in this site’s local storage in your browser. On a <span className="num">github.io</span> address that
              storage is shared with the site owner’s other GitHub Pages sites, so use a key with a spending limit.
            </li>
            <li>The fonts are bundled with the app, so loading Mimic makes no requests to other sites.</li>
            <li>“Clear all data” in Settings removes everything Mimic has stored.</li>
          </ul>
        </section>
      </article>
    </div>
  );
}
