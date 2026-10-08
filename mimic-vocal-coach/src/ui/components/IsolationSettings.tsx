// Settings: the optional on-device vocal-isolation model. Shown only where it can be used (this site carries it) or is already on
// the phone. It says what is stored, lets the person remove it, and keeps the Spleeter notice one tap away.

import { useCallback, useEffect, useState } from 'react';
import { checkSeparation, type SeparationAvailability } from '../../audio/separation/client';
import { SPLEETER_MIT_NOTICE, SPLEETER_SUMMARY, SPLEETER_URL } from '../../audio/separation/licence';
import { defaultModelDeps, keptModelInfo, removeIsolationFiles, type ModelCacheDeps } from '../../audio/separation/modelCache';
import { formatBytes } from '../../pwa/storage';

export function IsolationSettings(props: { check?: () => Promise<SeparationAvailability>; deps?: ModelCacheDeps }) {
  const [availability, setAvailability] = useState<SeparationAvailability | null>(null);
  const [kept, setKept] = useState<{ name: string; version: string; bytes: number } | null>(null);
  const [message, setMessage] = useState('');

  const look = useCallback(async () => {
    const deps = props.deps ?? defaultModelDeps();
    const [a, k] = await Promise.all([(props.check ?? (() => checkSeparation({ deps })))().catch(() => null), keptModelInfo(deps).catch(() => null)]);
    setAvailability(a);
    setKept(k);
  }, [props.check, props.deps]);

  useEffect(() => {
    let live = true;
    void look().then(() => live || undefined);
    return () => {
      live = false;
    };
  }, [look]);

  const remove = async () => {
    const ok = await removeIsolationFiles(props.deps ?? defaultModelDeps());
    setMessage(ok ? 'The model and the engine were removed from this phone.' : 'There was nothing to remove.');
    await look();
  };

  if (!kept && !availability?.available) return null;
  // In the native app the model is part of the app: nothing is downloaded, and nothing can be removed.
  const native = (props.deps ?? defaultModelDeps()).native === true;
  const size = kept?.bytes ?? availability?.manifest?.bytes ?? null;
  return (
    <section className="settings-section" aria-labelledby="isolation-heading">
      <h2 id="isolation-heading" className="section-title">
        Vocal isolation (optional)
      </h2>
      <dl className="status-list">
        <div className="status-row">
          <dt>Model on this phone</dt>
          <dd>
            {native ? (
              <>
                <span className="status-pill status-pill--good">Included in the app</span> <span className="muted">no download</span>
              </>
            ) : kept ? (
              <>
                <span className="status-pill status-pill--good">Downloaded</span> <span className="muted num">{kept.name}, {kept.version}, {formatBytes(kept.bytes)}</span>
              </>
            ) : (
              <>
                <span className="status-pill">Not downloaded</span> <span className="muted">about {formatBytes(size)}, fetched once when you first isolate a vocal</span>
              </>
            )}
          </dd>
        </div>
      </dl>
      <p className="field-hint">
        Pulls the voice out of a whole song on this phone, so tone can be compared. Everything runs on the device; nothing is uploaded. The model and the engine that runs it are stored in this
        browser and count toward the space used above.
      </p>
      {kept && !native && (
        <div className="button-row">
          <button type="button" className="button button--ghost button--small" onClick={() => void remove()}>
            Remove the model and engine
          </button>
        </div>
      )}
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
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
  );
}
