import type { Status } from '../../state/reducer';

/** Progress for decoding/analysis. The live region announces the job; the bar carries the value. */
export function AnalysisProgress(props: { status: Status; progress: number; label: string }) {
  const busy = props.status !== 'idle';
  const pct = Math.round(props.progress * 100);
  const decoding = props.status === 'decoding';
  return (
    <div className="analysis-progress" role="status" aria-live="polite">
      {busy && (
        <>
          <div className="analysis-progress-row">
            <span className="analysis-progress-label">{props.label || 'Working'}</span>
            <span className="num">{decoding ? 'reading file' : `${pct}%`}</span>
          </div>
          <div
            className={`progress-track${decoding ? ' progress-track--indeterminate' : ''}`}
            role="progressbar"
            aria-label={props.label || 'Analysis progress'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={decoding ? undefined : pct}
          >
            <div className="progress-fill" style={{ width: decoding ? undefined : `${pct}%` }} />
          </div>
        </>
      )}
    </div>
  );
}
