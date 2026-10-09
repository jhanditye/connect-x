// Settings: is the app installed, will it work offline, and is its data protected from iOS clearing it?

import { useCallback, useContext, useEffect, useState } from 'react';
import { listMicrophones, loadMicChoice, saveMicChoice, type MicOption } from '../../audio/micChoice';
import { installHelp, isDesktopKind, isIos, isNativeApp, isStandalone, platformKind } from '../../pwa/platform';
import { ownMicrophoneName } from '../../pwa/words';
import { checkForUpdate, usePwa } from '../../pwa/register';
import { formatBytes, readStorageStatus, requestPersistence, type StorageStatus } from '../../pwa/storage';
import { useTrainerExtras } from '../../state/TrainerProvider';
import { TrainerContext } from '../../state/trainerContext';
import { DesktopInstallCard, InstallCard } from './InstallCard';
import { phraseCount } from './phraseStatus';

function Pill(props: { tone?: 'good' | 'warn'; children: string }) {
  return <span className={`status-pill${props.tone ? ` status-pill--${props.tone}` : ''}`}>{props.children}</span>;
}

export function StoragePanel() {
  const pwa = usePwa();
  // The one place for storage: the Trainer's library shares this site's space, so its size and its "keep my data" request live here too.
  const trainer = useContext(TrainerContext);
  const extras = useTrainerExtras();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [asked, setAsked] = useState<boolean | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const native = isNativeApp();
  const installed = isStandalone();
  const ios = isIos();
  const kind = platformKind();
  const desktop = isDesktopKind(kind);

  const refresh = useCallback(() => {
    void readStorageStatus().then(setStatus);
  }, []);
  useEffect(refresh, [refresh]);

  const persist = async () => {
    setAsked(await requestPersistence());
    refresh();
    void extras.refreshStorage();
  };

  const check = async () => {
    if (checking) return;
    setChecking(true);
    await checkForUpdate();
    setChecking(false);
  };

  const persisted = status?.persisted;
  return (
    <section className="settings-section" aria-labelledby="storage-heading">
      <h2 id="storage-heading" className="section-title">
        Offline and storage
      </h2>
      <dl className="status-list">
        <div className="status-row">
          <dt>Installed app</dt>
          <dd>
            {native ? <Pill tone="good">Yes, this is the Mimic app</Pill> : installed ? <Pill tone="good">{desktop ? 'Yes, running in a window of its own' : 'Yes, running from the Home Screen'}</Pill> : <Pill tone={ios ? 'warn' : undefined}>{ios ? 'No, running in a browser tab' : desktop ? 'Running in a browser window' : 'Running in a browser tab'}</Pill>}
          </dd>
        </div>
        <div className="status-row">
          <dt>Works offline</dt>
          <dd>
            {native ? <Pill tone="good">Built into the app</Pill> : !pwa.supported ? <Pill>Not available here</Pill> : pwa.offlineReady || pwa.version ? <Pill tone="good">Ready</Pill> : <Pill tone="warn">Preparing…</Pill>}
            {pwa.version && <span className="muted num"> build {pwa.version.slice(0, 7)}</span>}
          </dd>
        </div>
        {trainer && (
          <div className="status-row">
            <dt>Trainer library</dt>
            <dd>
              <span className="num">{trainer.clips.length}</span> {trainer.clips.length === 1 ? 'clip' : 'clips'},{' '}
              {phraseCount(trainer.clips.reduce((n, c) => n + c.phrases.filter((p) => !p.hidden).length, 0))}
              {trainer.status === 'memory-only' && (
                <>
                  {' '}
                  <Pill tone="warn">Lost when you close the app</Pill>
                </>
              )}
            </dd>
          </div>
        )}
        <div className="status-row">
          <dt>Data kept safe</dt>
          <dd>
            {persisted === true ? (
              <Pill tone="good">Persistent</Pill>
            ) : persisted === false ? (
              <Pill tone="warn">Best effort: the browser may clear it if storage runs low</Pill>
            ) : (
              <Pill>Unknown</Pill>
            )}
          </dd>
        </div>
        <div className="status-row">
          <dt>Space used</dt>
          <dd className="num">
            {formatBytes(status?.usageBytes ?? null)}
            {status?.quotaBytes ? <span className="muted"> of about {formatBytes(status.quotaBytes)}</span> : null}
          </dd>
        </div>
      </dl>
      {trainer && extras.storageNote && <p className="field-hint">{extras.storageNote}</p>}
      {ios && !installed && installHelp().show && (
        <>
          <p className="field-hint">
            Safari clears the saved data of a website you have not used for about a week of browsing. A Home Screen web app keeps its own count of days
            used, so installing Mimic protects what you add to it.
          </p>
          <InstallCard persistent />
        </>
      )}
      {desktop && <DesktopInstallCard />}
      <div className="button-row">
        {persisted === false && (
          <button type="button" className="button button--ghost button--small" onClick={() => void persist()}>
            Ask the browser to keep my data
          </button>
        )}
        {pwa.supported && (
          <button type="button" className="button button--ghost button--small" onClick={() => void check()} aria-disabled={checking || undefined}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>
      {asked === false && (
        <p className="field-hint" role="status">
          {desktop
            ? 'The browser declined. It decides without asking you; keep a backup (Settings, then Trainer, then Export my library) and it is more likely to agree once you use Mimic regularly.'
            : 'The browser declined. Safari decides without asking you; it is more likely to agree once Mimic is installed on the Home Screen and used regularly.'}
        </p>
      )}
      {asked === true && (
        <p className="field-hint" role="status">
          Done: this app’s data is now marked persistent.
        </p>
      )}
    </section>
  );
}

/** Settings: pick the microphone. iPhone earbuds drop to phone-call quality while recording; the built-in mic does not. */
export function MicrophoneSetting() {
  const [options, setOptions] = useState<MicOption[] | null>(null);
  const [choice, setChoice] = useState<string>(() => loadMicChoice() ?? '');
  const kind = platformKind();
  const desk = isDesktopKind(kind);
  const tap = kind === 'ios' || !desk ? 'Tap' : 'Click';

  useEffect(() => {
    let live = true;
    void listMicrophones().then((list) => live && setOptions(list));
    return () => {
      live = false;
    };
  }, []);

  if (options === null) return null;
  // An empty list is normal before the microphone has been allowed once (Safari lists nothing until then): keep the control and say
  // what to do, because other screens point here ("the microphone you record with is chosen under Your voice").
  const empty = options.length === 0;
  const unlabelled = options.every((o) => !o.label);
  const anyBluetooth = options.some((o) => o.bluetooth);
  return (
    <div className="field">
      <label htmlFor="mic-choice" className="field-label">
        Microphone
      </label>
      <select
        id="mic-choice"
        className="select"
        value={choice}
        disabled={empty}
        onChange={(e) => {
          setChoice(e.currentTarget.value);
          saveMicChoice(e.currentTarget.value || null);
        }}
      >
        <option value="">{`Automatic (whatever the ${desk ? 'computer' : 'phone'} is using)`}</option>
        {options.map((o, i) => (
          <option key={o.deviceId} value={o.deviceId}>
            {o.label || `Microphone ${i + 1}`}
            {o.bluetooth ? ' (Bluetooth)' : ''}
          </option>
        ))}
      </select>
      <p className="field-hint">
        {empty ? `No microphones are listed yet. ${tap} Record in the Studio, or Sing in the Trainer, and allow the microphone once; they are listed here after that. Until then Mimic uses whatever the ${desk ? 'computer' : 'phone'} is using. ` : ''}
        {!empty && unlabelled ? 'Record once and the microphones will be listed by name here. ' : ''}
        {empty
          ? ''
          : anyBluetooth
          ? `While recording, Bluetooth earbuds switch to a phone-call voice mode (8-24 kHz) that makes your tone measurements less reliable. Choose ${ownMicrophoneName(kind)} for takes you want to compare.`
          : 'Pick the microphone you want to compare takes with and keep using the same one.'}
      </p>
    </div>
  );
}
