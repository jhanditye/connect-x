// How your tone differs from the original, in plain words. Only normalised differences are shown (airiness, brightness, grit,
// vibrato, relative loudness), never raw measurements, and never as better or worse: they are estimates that move with your
// microphone and your key. Grit is only ever described, never asked for; softer is never "fixed" by pushing.

import type { JSX } from 'react';
import { toneWords, type ToneWords } from '../../trainer/feedback';
import { ISOLATED_TONE_NOTE } from '../../trainer/importCopy';
import type { PhraseComparison, ToneFinding } from '../../types';
import { Notice } from './Notice';
import { signed } from './format';
import './phraseCompare.css';

export interface TonePanelProps {
  comparison: PhraseComparison;
  /** 'mix' when the original is a full song: its tone belongs to the band, so tone is not compared. */
  referenceKind?: 'solo' | 'mix';
  /** The original is a vocal pulled out of a song by the isolation model: its tone is approximate, and the panel says so. */
  isolatedReference?: boolean;
}

interface MeterSpec {
  low: string;
  high: string;
}

const METERS: Partial<Record<ToneFinding['key'], MeterSpec>> = {
  breathiness: { low: 'clearer', high: 'airier' },
  brightness: { low: 'darker', high: 'brighter' },
  rasp: { low: 'cleaner', high: 'grittier' },
};

/** A bar from the centre (the same as the original) towards the side the difference lies on; the ends are a big difference. */
function Meter(props: { finding: ToneFinding; spec: MeterSpec }): JSX.Element {
  const { finding: f, spec } = props;
  const share = Math.min(1, Math.abs(f.diff) / 0.5);
  const side = f.diff >= 0 ? 'high' : 'low';
  return (
    <div className="tp-meter" role="img" aria-label={`${f.diff >= 0 ? spec.high : spec.low} than the original by ${Math.abs(f.diff).toFixed(2)} on a scale where 0.5 is a big difference`}>
      <span className="tp-meter-end" aria-hidden="true">
        {spec.low}
      </span>
      <span className="tp-meter-track" aria-hidden="true">
        <span className="tp-meter-mid" />
        <span className={`tp-meter-fill tp-meter-fill--${side}`} style={{ width: `${(share * 50).toFixed(1)}%` }} />
      </span>
      <span className="tp-meter-end tp-meter-end--high" aria-hidden="true">
        {spec.high}
      </span>
    </div>
  );
}

function Row(props: { finding: ToneFinding; words: ToneWords }): JSX.Element {
  const { finding: f, words: w } = props;
  const spec = METERS[f.key];
  return (
    <li className="tp-item">
      <div className="tp-head">
        <span className="tp-label">{w.label}</span>
        {w.size && <span className="tp-size">{w.size}</span>}
        {spec && <span className="tp-value num">{signed(f.diff, 2)}</span>}
      </div>
      <p className="tp-text">{w.text}</p>
      {spec && <Meter finding={f} spec={spec} />}
    </li>
  );
}

export function TonePanel(props: TonePanelProps): JSX.Element {
  const { comparison: c } = props;
  const mix = props.referenceKind === 'mix' || c.score.trust.reasons.some((r) => /full mix/i.test(r));
  const findings = c.tone.map((f) => ({ finding: f, words: toneWords(f) }));
  const main = findings.filter((x) => !x.words.detailOnly);
  const detail = findings.filter((x) => x.words.detailOnly);

  let body: JSX.Element;
  if (c.score.status !== 'ok') {
    body = <p className="tp-quiet">Tone is compared once a take lines up with the phrase. Listen to the original, then try again.</p>;
  } else if (mix) {
    body = (
      <Notice tone="info" title="Tone is not compared here">
        The original is a full song, so part of its sound belongs to the band. Only pitch, timing and vibrato are compared. For a tone comparison, use an isolated vocal or an a cappella clip.
      </Notice>
    );
  } else if (c.score.skills.tone === null) {
    body = <p className="tp-quiet">There was not enough clear voice to compare tone. A longer, steadier take (a few seconds of held notes) gives a reading.</p>;
  } else if (findings.length === 0) {
    body = <p className="tp-quiet">Your tone is close to the original, within what the app can measure.</p>;
  } else {
    body = (
      <>
        {main.length > 0 ? (
          <ul className="tp-list">
            {main.map((x) => (
              <Row key={x.finding.key} finding={x.finding} words={x.words} />
            ))}
          </ul>
        ) : (
          <p className="tp-quiet">Nothing here needs changing.</p>
        )}
        {detail.length > 0 && (
          <>
            <p className="tp-sub">Details (low confidence)</p>
            <ul className="tp-list tp-list--detail">
              {detail.map((x) => (
                <Row key={x.finding.key} finding={x.finding} words={x.words} />
              ))}
            </ul>
          </>
        )}
      </>
    );
  }

  return (
    <section className="tp" aria-label="Tone compared with the original">
      <h3 className="tp-title">Tone, compared with the original</h3>
      {body}
      {props.isolatedReference && !mix && (
        <p className="tp-foot" data-testid="isolated-tone-note">
          {ISOLATED_TONE_NOTE}
        </p>
      )}
      <p className="tp-foot">
        These are estimates. They move with your microphone, your room and the key you sing in, and they never mean better or worse: a different voice will always sound a little different.
      </p>
    </section>
  );
}
