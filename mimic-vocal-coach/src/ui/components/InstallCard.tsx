// "Install on iPhone": shown on iOS when the app runs in a browser tab instead of from the Home Screen.
// The Home Screen version has its own storage (separate from Safari), no browser bars, and works offline.
// On a Mac or another computer the same place says where the data lives and, for Safari, Chrome and Edge, how to give Mimic a window
// of its own (DesktopInstallCard, Settings only: it is a convenience, not something the app needs).

import { useRef, useState } from 'react';
import { desktopBrowser, installHelp, isStandalone, platformKind, isDesktopKind, type PlatformEnv, type PlatformKind } from '../../pwa/platform';
import { currentAddress, dataStaysHereText, dockHelp } from '../../pwa/words';
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

/**
 * One sentence for places where clips are about to be saved (the import sheet): in a browser tab on an iPhone, what is saved here is
 * not in the Home Screen app. Renders nothing in the installed app, in the native app or off iOS.
 */
export function BrowserTabNote(props: { env?: PlatformEnv }) {
  if (!installHelp(props.env).show) return null;
  return (
    <p className="install-note" data-testid="browser-tab-note">
      You are in a browser tab. Clips saved here will not appear in the Home Screen app, which keeps its own storage. Install Mimic first (the steps are on the Trainer
      screen), then add your clips there.
    </p>
  );
}

export function InstallCard(props: { env?: PlatformEnv; /** Always show (Settings) even after the user dismissed the card on the Studio. */ persistent?: boolean }) {
  const help = installHelp(props.env);
  const [dismissed, setDismissed] = useState(() => !props.persistent && wasDismissed());
  const cardRef = useRef<HTMLElement>(null);
  if (!help.show || dismissed) return null;

  const dismiss = () => {
    // The button that was pressed leaves with the card: move focus to the next heading on the page (or the page itself), never <body>.
    const next = cardRef.current?.nextElementSibling ?? null;
    const heading = next?.matches('h1,h2,h3') ? next : (next?.querySelector('h1,h2,h3') ?? null);
    const target = (heading as HTMLElement | null) ?? document.querySelector<HTMLElement>('main.main');
    if (target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    setDismissed(true);
    requestAnimationFrame(() => target?.focus({ preventScroll: true }));
    try {
      getStorage()?.setItem(DISMISS_KEY, '1');
    } catch {
      // Storage blocked: the card comes back next visit.
    }
  };

  return (
    <section ref={cardRef} className="install-card" aria-labelledby="install-title">
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

/**
 * A Mac or another desktop: where the data lives (this browser, this address) and how to give Mimic a window of its own. Renders
 * nothing on a phone, or when Mimic is already running in a window of its own.
 */
export function DesktopInstallCard(props: { env?: PlatformEnv; address?: string; /** The device the words are for, when the caller already knows it (the Guide). */ platform?: PlatformKind }) {
  const kind = props.platform ?? platformKind(props.env);
  if (!isDesktopKind(kind)) return null;
  const standalone = isStandalone(props.env);
  const help = standalone ? null : dockHelp(kind, desktopBrowser(props.env));
  return (
    <section className="install-card install-card--desktop" aria-labelledby="dock-title" data-testid="desktop-install-card">
      <div className="install-card-head">
        <h2 id="dock-title" className="install-card-title">
          {standalone ? 'Mimic is running in its own window' : help ? help.title : 'Where your clips are kept'}
        </h2>
      </div>
      <p className="install-card-lede">{dataStaysHereText(props.address ?? currentAddress())}</p>
      {help && (
        <>
          <ol className="install-steps">
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="install-note">{help.note}</p>
        </>
      )}
    </section>
  );
}
