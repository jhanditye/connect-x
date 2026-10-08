// More: the pages that do not fit the five phone tabs (Practice, Guide, Settings), each with a line saying what is in it.
// Reached from the last tab on a phone; the desktop bar links to these pages directly.

import { MORE_ROUTES, ROUTE_LABELS, routeHash, type Route } from '../../state/routing';
import { Icon } from '../components/Icon';

const ABOUT: Partial<Record<Route, string>> = {
  practice: 'Vocal exercises with a pattern that plays in your key: sirens, straw and lip-trill warm-ups, mix work, onsets and vibrato.',
  guide: 'How Mimic listens, what it can and cannot hear, how to get a vocal onto your phone, and how to look after your voice.',
  settings: 'Your voice type and tuning, the microphone, storage and backups of your clips, and the optional AI coach.',
};

export function MorePage() {
  return (
    <div className="page page--more">
      <header className="page-head">
        <p className="eyebrow">More</p>
        <h1 className="page-title">More from Mimic</h1>
        <p className="lede">Exercises to warm up with, the guide, and your settings.</p>
      </header>

      <ul className="mo-list">
        {MORE_ROUTES.map((r) => (
          <li key={r}>
            <a className="mo-link" href={routeHash(r)}>
              <span className="mo-icon" aria-hidden="true">
                <Icon name={r} size={24} />
              </span>
              <span className="mo-text">
                <span className="mo-name">{ROUTE_LABELS[r]}</span>
                <span className="mo-about">{ABOUT[r]}</span>
              </span>
              <Icon name="forward" size={18} className="mo-go" />
            </a>
          </li>
        ))}
      </ul>

      <p className="mo-diag">
        Something not working on your phone? <a href="#settings/diagnostics">Run the device checks</a> and share the report with whoever is helping you.
      </p>
      <p className="caveat">
        Your clips, phrases and scores stay on this device. Mimic is an independent practice tool and is not affiliated with the artists.
      </p>
    </div>
  );
}
