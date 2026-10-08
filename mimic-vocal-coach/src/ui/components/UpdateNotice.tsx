// Shown when a newer version of the app has been downloaded in the background and is waiting. One slim row under the top bar (it
// scrolls away with the page, so it never covers the bar): "New version ready", Update and a way to hide it. Applying it reloads
// only this tab, and never in the middle of a recording or analysis: it waits for the take to finish. A tab that another tab updated
// is not reloaded behind the person's back either; it offers a reload instead.

import { applyUpdate, dismissUpdate, reloadForUpdate, usePwa } from '../../pwa/register';
import { Icon } from './Icon';

export function UpdateNotice() {
  const pwa = usePwa();

  if (pwa.updatedElsewhere) {
    return (
      <div className="update-banner" role="status">
        <p className="update-banner-text">
          <strong>Mimic was updated in another tab.</strong> {pwa.updateQueued ? 'This tab reloads when your take is done.' : 'Reload this tab when you are done with your take.'}
        </p>
        <button type="button" className="button button--accent button--small" onClick={reloadForUpdate} aria-disabled={pwa.updateQueued || undefined}>
          Reload
        </button>
      </div>
    );
  }
  if (!pwa.updateReady || pwa.updateDismissed) return null;

  const hide = () => {
    // The bar unmounts with the button that was pressed: put focus on the page instead of letting it fall to <body>.
    dismissUpdate();
    const main = document.querySelector<HTMLElement>('main.main');
    main?.focus({ preventScroll: true });
  };

  return (
    <div className="update-banner" role="status">
      <p className="update-banner-text">
        <strong>New version ready.</strong>{' '}
        {pwa.updateQueued ? 'It installs when your take is done.' : pwa.busy ? 'Finish your take first.' : ''}
      </p>
      <button type="button" className="button button--accent button--small" onClick={applyUpdate} aria-disabled={pwa.updateQueued || undefined}>
        {pwa.updateQueued ? 'Waiting…' : 'Update'}
      </button>
      <button type="button" className="icon-button" onClick={hide} aria-label="Hide until later">
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
