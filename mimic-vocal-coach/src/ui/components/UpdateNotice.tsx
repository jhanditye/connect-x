// Shown when a newer version of the app has been downloaded in the background and is waiting.
// Applying it reloads the app, so it is always the user's tap (never in the middle of a take).

import { applyUpdate, usePwa } from '../../pwa/register';
import { Notice } from './Notice';

export function UpdateNotice() {
  const pwa = usePwa();
  if (!pwa.updateReady) return null;
  return (
    <div className="update-banner">
      <Notice tone="info" title="A new version of Mimic is ready">
        <p>Reloading takes a second. Finish or save your current take first: an unsaved take is lost on reload.</p>
        <div className="button-row">
          <button type="button" className="button button--accent button--small" onClick={applyUpdate}>
            Update now
          </button>
        </div>
      </Notice>
    </div>
  );
}
