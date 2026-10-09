// The Trainer's empty state: what the Trainer is for, the three steps, and every way to get a vocal onto the device (Files app or
// Finder, Voice Memos, DRM-free purchases, vocal stems, audio from a video). The words come from trainer/importCopy.ts so this
// screen, the import sheet and the Guide say the same thing. Never a dead end: two ways forward are always on screen.

import { platformKind, type PlatformKind } from '../../pwa/platform';
import { IMPORT_EMPTY_STATE, importWords, PRIVACY_NOTE } from '../../trainer/importCopy';
import { Icon } from './Icon';

export interface TrainerEmptyProps {
  onAdd(): void;
  /** Shown instead of the buttons while the library is not usable (still loading, or storage failed). */
  disabledReason?: string | null;
  /** Which device the words are for; the real device by default (tests inject one). */
  platform?: PlatformKind;
}

export function TrainerEmpty(props: TrainerEmptyProps) {
  const words = importWords(props.platform ?? platformKind());
  return (
    <section className="te" aria-labelledby="te-title">
      <h2 id="te-title" className="te-title">
        No clips yet
      </h2>
      <p className="te-body">{IMPORT_EMPTY_STATE.body}</p>

      <ol className="te-steps">
        {words.steps.map((s, i) => (
          <li key={s.title} className="te-step">
            <span className="te-step-n num" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <h3 className="te-step-title">{s.title}</h3>
              <p className="te-step-body">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="te-actions">
        <button type="button" className="button button--accent te-add" onClick={props.onAdd} disabled={!!props.disabledReason}>
          <Icon name="add" size={20} /> {IMPORT_EMPTY_STATE.addLabel}
        </button>
        <a className="button button--ghost" href="#guide/guide-vocal">
          <Icon name="help" size={18} /> {IMPORT_EMPTY_STATE.helpLabel}
        </a>
      </div>
      {props.disabledReason && <p className="field-hint te-disabled">{props.disabledReason}</p>}

      <details className="te-ways">
        <summary>{words.waysSummary}</summary>
        <ul className="te-ways-list">
          {words.ways.map((w) => (
            <li key={w.title}>
              <strong>{w.title}.</strong> {w.body}
            </li>
          ))}
        </ul>
        <p className="caveat">Works with {words.formats}</p>
      </details>

      <p className="te-alt">
        Just want to sing and see how you sound? <a href="#studio">Record a free take in the Studio</a>.
      </p>
      <p className="caveat">{PRIVACY_NOTE}</p>
    </section>
  );
}
