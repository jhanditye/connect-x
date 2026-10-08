// "Install on iPhone": shown on iOS when the app runs in a browser tab instead of from the Home Screen.
// The Home Screen version has its own storage (separate from Safari), no browser bars, and works offline.

import { useState } from 'react';
import { installHelp, type PlatformEnv } from '../../pwa/platform';
import { getStorage } from '../../storage/local';
import { Icon } from './Icon';

const DISMISS_KEY = 'mimic.installCard.dismissed';

function wasDismissed(): boolean {
  try {
    return getStorage()?.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** The share glyph Safari shows (a square with an arrow out of the top), drawn inline so the steps are easy to match. */
function ShareGlyph() {
  return (
    <svg className="inline-glyph" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </svg>
  );
}

export function InstallCard(props: { env?: PlatformEnv; /** Always show (Settings) even after the user dismissed the card on the Studio. */ persistent?: boolean }) {
  const help = installHelp(props.env);
  const [dismissed, setDismissed] = useState(() => !props.persistent && wasDismissed());
  if (!help.show || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      getStorage()?.setItem(DISMISS_KEY, '1');
    } catch {
      // Storage blocked: the card comes back next visit.
    }
  };

  return (
    <section className="install-card" aria-labelledby="install-title">
      <div className="install-card-head">
        <h2 id="install-title" className="install-card-title">
          Install Mimic on your iPhone
        </h2>
        {!props.persistent && (
          <button type="button" className="icon-button" onClick={dismiss} aria-label="Hide the install instructions">
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      <p className="install-card-lede">
        Added to the Home Screen, Mimic opens like an app, works offline, and keeps your clips and progress in its own storage that iOS does not clear
        after a week.
      </p>
      {help.needsSafari ? (
        <ol className="install-steps">
          <li>
            This page is open inside another app. Tap <b>Open in Safari</b> (or copy the link into Safari).
          </li>
          <li>Then follow the steps here again.</li>
        </ol>
      ) : (
        <ol className="install-steps">
          <li>
            Tap the <b>Share</b> button <ShareGlyph /> {help.browser === 'safari' ? 'in Safari’s toolbar (in newer iOS versions it may be under the ••• button).' : 'in the toolbar or its menu.'}
          </li>
          <li>
            Scroll down and tap <b>Add to Home Screen</b>.
          </li>
          <li>
            Leave <b>Open as Web App</b> switched on, then tap <b>Add</b>.
          </li>
          <li>
            Open <b>Mimic</b> from your Home Screen, then add your clips there.
          </li>
        </ol>
      )}
      <p className="install-note">
        The installed app has its own storage: clips you add in a Safari tab are not carried over, so do the setup after installing.
        {help.browser !== 'safari' && !help.needsSafari ? ' Chrome, Edge and Firefox on iPhone can also add to the Home Screen from their Share menu (iOS 16.4 or later).' : ''}
      </p>
    </section>
  );
}
