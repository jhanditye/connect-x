// The Studio's singer panel entry for measured targets. With the Trainer present it reads "Add clips to the Trainer": clips of
// the singer live in the Trainer (where they can be practised phrase by phrase), and each one can be switched on to shape the
// singer's measured targets with one tap (coach/measured.ts builds the targets from the numbers; no audio is kept by the targets).
// "Measure numbers only" keeps the older way: files are measured and only the numbers stay, no audio, no phrases.

import { useId, useRef, useState } from 'react';
import { contributionBlocker } from '../../storage/library';
import type { MeasureProgress, MeasureResult } from '../../state/context';
import { trainerHash } from '../../state/routing';
import type { TrainerController } from '../../state/trainerContext';
import type { MeasuredClip } from '../../types';
import { FileDrop } from './FileDrop';
import { Icon } from './Icon';
import { phraseCount, visiblePhrases } from './phraseStatus';

function firstName(name: string): string {
  return name.split(' ')[0] || name;
}

function progressText(p: MeasureProgress): string {
  const which = p.count > 1 ? `${p.index + 1} of ${p.count}: ` : '';
  const step = p.phase === 'decoding' ? 'reading' : `analysing ${Math.round(p.fraction * 100)}%`;
  return `Measuring ${which}${p.name} (${step})`;
}

interface NumbersOnlyProps {
  singerName: string;
  clips: MeasuredClip[];
  onMeasure: (files: File[], onProgress: (p: MeasureProgress) => void) => Promise<MeasureResult>;
  onRemove: (clipId: string) => void;
  onClear: () => void;
  /** The heading's id (the Studio and its tests look for #measure-heading when this is the whole panel). */
  headingId?: string;
}

/** Measures files and keeps only the numbers (no audio, no phrases). The older way, kept for people who do not want a clip stored. */
function NumbersOnlyPanel(props: NumbersOnlyProps) {
  const { singerName, clips } = props;
  const headingId = props.headingId ?? 'measure-heading';
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
  const isolatedCount = clips.filter((c) => c.isolated).length;

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
    <div className="measure" aria-labelledby={headingId}>
      <h3 id={headingId} className="subhead" ref={headingRef} tabIndex={-1}>
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
          {isolatedCount > 0 && (
            <p className="measure-intro">
              {isolatedCount === 1 ? '1 of them is a vocal' : `${isolatedCount} of them are vocals`} pulled out of a song by AI, so {isolatedCount === 1 ? 'its' : 'their'} tone
              numbers are approximate. A real isolated vocal gives steadier targets.
            </p>
          )}
          <ul className="measure-clips">
            {clips.map((c) => (
              <li key={c.id}>
                <span className="measure-clip-name">{c.name}</span>
                {c.isolated && <span className="muted">AI-isolated</span>}
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

export interface MeasurePanelProps extends Omit<NumbersOnlyProps, 'headingId'> {
  /** The builtin singer these clips belong to; needed with `trainer` to list their clips. */
  singerId?: string;
  /** The Trainer's library. Without it (no Trainer in this build or test) the older numbers-only panel is the whole panel. */
  trainer?: Pick<TrainerController, 'clips' | 'status' | 'setContributes'> | null;
}

function TrainerEntry(props: MeasurePanelProps & { singerId: string; trainer: NonNullable<MeasurePanelProps['trainer']> }) {
  const { trainer, singerId, singerName } = props;
  const who = firstName(singerName);
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mine = trainer.clips.filter((c) => c.singerId === singerId);
  const waiting = mine.filter((c) => !c.contributesToSinger && contributionBlocker(c) === null);
  const counted = mine.filter((c) => c.contributesToSinger).length;
  const ready = trainer.status === 'ready' || trainer.status === 'memory-only';

  const toggle = async (id: string, title: string, on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await trainer.setContributes(id, on);
      setNote(on ? `${title} now counts toward ${who}'s targets.` : `${title} no longer counts toward ${who}'s targets.`);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That could not be changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const useAll = async () => {
    setBusy(true);
    setError(null);
    let done = 0;
    try {
      for (const c of waiting) {
        await trainer.setContributes(c.id, true);
        done++;
      }
      setNote(`${done} ${done === 1 ? 'clip now counts' : 'clips now count'} toward ${who}'s targets.`);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That could not be changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="measure" aria-labelledby="measure-heading">
      <h3 id="measure-heading" className="subhead" tabIndex={-1}>
        Add clips to the Trainer
      </h3>
      <p className="measure-intro">
        Add clips of {singerName} from music you own and practise their phrases one by one in the Trainer. Each clip can also shape {who}&apos;s targets here: switch it on and the
        Studio scores your takes against the measured numbers instead of the estimates. Only the numbers are used, never the audio.
      </p>
      <a className="button button--accent" href="#trainer/add" aria-describedby={`${ids}-add`}>
        <Icon name="add" size={18} /> Add clips in the Trainer
      </a>
      <p id={`${ids}-add`} className="visually-hidden">
        Opens the Trainer&apos;s Add clips sheet.
      </p>

      {mine.length > 0 ? (
        <>
          <h4 className="subhead">Your clips of {who}</h4>
          <ul className="mt-clips">
            {mine.map((c) => {
              const why = contributionBlocker(c);
              return (
                <li key={c.id} className="mt-clip">
                  <a className="mt-clip-name" href={trainerHash({ view: 'clip', clipId: c.id })}>
                    {c.title}
                  </a>
                  <span className="mt-clip-meta">
                    {phraseCount(visiblePhrases(c).length)} · {c.kind === 'mix' ? 'full song' : 'solo vocal'}
                  </span>
                  <label className="tr-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={c.contributesToSinger}
                      disabled={busy || (why !== null && !c.contributesToSinger)}
                      onChange={(e) => void toggle(c.id, c.title, e.currentTarget.checked)}
                      aria-describedby={why ? `${ids}-${c.id}` : undefined}
                    />
                    <span className="tr-switch-label">Counts toward {who}&apos;s targets</span>
                  </label>
                  {why && !c.contributesToSinger && (
                    <span id={`${ids}-${c.id}`} className="field-hint">
                      {why}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {waiting.length > 0 && (
            <div className="button-row">
              <button type="button" className="button" onClick={() => void useAll()} disabled={busy}>
                Use {waiting.length === 1 ? 'this clip' : `all ${waiting.length} usable clips`} for {who}&apos;s targets
              </button>
            </div>
          )}
          {counted > 0 && (
            <p className="field-hint">
              <span className="num">{counted}</span> {counted === 1 ? 'clip counts' : 'clips count'} toward {who}&apos;s targets.
            </p>
          )}
        </>
      ) : ready ? (
        <p className="field-hint">No clips of {who} in the Trainer yet. Add one and it will be listed here.</p>
      ) : null}

      <p className="visually-hidden" role="status">
        {note}
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <details className="mt-legacy">
        <summary>Measure numbers only, without keeping the clip</summary>
        <NumbersOnlyPanel {...props} headingId="measure-numbers-heading" />
      </details>
    </div>
  );
}

/**
 * "Add clips to the Trainer" when the Trainer is there, with the numbers-only measuring tucked under it; the numbers-only panel
 * on its own otherwise.
 */
export function MeasurePanel(props: MeasurePanelProps) {
  const { trainer, singerId, ...rest } = props;
  if (!trainer || !singerId) return <NumbersOnlyPanel {...rest} />;
  return <TrainerEntry {...props} singerId={singerId} trainer={trainer} />;
}
