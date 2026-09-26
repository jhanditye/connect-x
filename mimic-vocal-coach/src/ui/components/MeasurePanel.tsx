// "Measure from real recordings": the user adds clips of a builtin singer from music they own and the
// singer's targets are rebuilt from those measurements (coach/measured.ts). Lives in the Studio's
// singer panel.

import { useRef, useState } from 'react';
import type { MeasureProgress, MeasureResult } from '../../state/context';
import type { MeasuredClip } from '../../types';
import { FileDrop } from './FileDrop';

function firstName(name: string): string {
  return name.split(' ')[0] || name;
}

function progressText(p: MeasureProgress): string {
  const which = p.count > 1 ? `${p.index + 1} of ${p.count}: ` : '';
  const step = p.phase === 'decoding' ? 'reading' : `analysing ${Math.round(p.fraction * 100)}%`;
  return `Measuring ${which}${p.name} (${step})`;
}

export function MeasurePanel(props: {
  singerName: string;
  clips: MeasuredClip[];
  onMeasure: (files: File[], onProgress: (p: MeasureProgress) => void) => Promise<MeasureResult>;
  onRemove: (clipId: string) => void;
  onClear: () => void;
}) {
  const { singerName, clips } = props;
  const who = firstName(singerName);
  const [progress, setProgress] = useState<MeasureProgress | null>(null);
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // What screen readers hear: the start and the end of a batch, not every percent.
  const [announce, setAnnounce] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busy = progress !== null;
  const singingSec = Math.round(clips.reduce((s, c) => s + c.voicedSec, 0));

  const measure = async (files: File[]) => {
    setResult(null);
    setRejectMsg(null);
    setConfirmClear(false);
    setAnnounce(`Measuring ${files.length} clip${files.length === 1 ? '' : 's'} of ${singerName}.`);
    let res: MeasureResult;
    try {
      res = await props.onMeasure(files, setProgress);
    } catch (err) {
      setRejectMsg(err instanceof Error && err.message ? err.message : 'Measuring the clips failed. Try again with fewer or shorter files.');
      setAnnounce('Measuring failed.');
      return;
    } finally {
      setProgress(null);
    }
    setResult(res);
    setAnnounce(
      `${res.added ? `Added ${res.added} clip${res.added === 1 ? '' : 's'}.` : 'No clips were added.'}` +
        (res.rejected.length ? ` ${res.rejected.length} could not be used.` : ''),
    );
  };

  return (
    <div className="measure" aria-labelledby="measure-heading">
      <h3 id="measure-heading" className="subhead" ref={headingRef} tabIndex={-1}>
        Measure {who} from real recordings
      </h3>
      {clips.length === 0 ? (
        <p className="measure-intro">
          These targets are estimates from listening. For targets measured from {who}'s actual voice, add clips of {singerName} from
          music you own. Isolated vocals (vocal stems) or a cappella sections work; full song mixes are refused, because the analysis
          would follow the band instead of the voice. A stem-splitter app can pull the vocal out of a song. Several clips from
          different songs give the steadiest targets. Only the measurements are kept, on this device.
        </p>
      ) : (
        <>
          <p className="measure-intro">
            <span className="measure-badge">Measured</span> The targets for {who} now come from {clips.length} clip
            {clips.length === 1 ? '' : 's'} you added (<span className="num">{singingSec} s</span> of singing). Add clips from other
            songs to steady them.
          </p>
          <ul className="measure-clips">
            {clips.map((c) => (
              <li key={c.id}>
                <span className="measure-clip-name">{c.name}</span>
                <span className="num muted">{Math.round(c.voicedSec)} s sung</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    props.onRemove(c.id);
                    headingRef.current?.focus();
                  }}
                  disabled={busy}
                  aria-label={`Remove ${c.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <FileDrop
        compact
        multiple
        label={clips.length ? `Add more clips of ${who}` : `Add clips of ${who}`}
        hint="Isolated vocals or a cappella sections, up to 5 minutes each. You can pick several files."
        disabled={busy}
        onFile={(f) => void measure([f])}
        onFiles={(fs) => void measure(fs)}
        onReject={setRejectMsg}
      />

      <p className="visually-hidden" role="status">
        {announce}
      </p>
      {progress && (
        <div className="measure-progress">
          <p className="muted">{progressText(progress)}</p>
          <div className="progress-track" aria-hidden="true">
            <div
              className="progress-fill"
              style={{ width: `${Math.round(((progress.index + (progress.phase === 'analyzing' ? progress.fraction : 0)) / progress.count) * 100)}%` }}
            />
          </div>
        </div>
      )}
      {rejectMsg && (
        <p className="field-error" role="alert">
          {rejectMsg}
        </p>
      )}
      {result && (result.added > 0 || result.rejected.length > 0) && (
        <div className="measure-result">
          {result.added > 0 && (
            <p>
              Added {result.added} clip{result.added === 1 ? '' : 's'}. Scores against {who} now use the measured targets.
            </p>
          )}
          {result.rejected.length > 0 && (
            <ul className="measure-rejected">
              {result.rejected.map((r) => (
                <li key={r.name}>
                  <strong>{r.name}</strong>: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {clips.length > 0 &&
        (confirmClear ? (
          <div className="measure-confirm" role="group" aria-label="Confirm going back to estimated targets">
            <span>Remove all {clips.length} measured clips and use the estimates again?</span>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => {
                props.onClear();
                setConfirmClear(false);
                setResult(null);
                headingRef.current?.focus();
              }}
            >
              Yes, remove them
            </button>
            <button type="button" className="button button--ghost button--small" onClick={() => setConfirmClear(false)}>
              Keep
            </button>
          </div>
        ) : (
          <button type="button" className="link-button" onClick={() => setConfirmClear(true)} disabled={busy}>
            Use the estimated targets again
          </button>
        ))}
    </div>
  );
}
