import type { Status } from '../../state/reducer';

/**
 * Progress for decoding/analysis. Only the job label sits in the live region, so a screen reader
 * hears "Analysing <take>" once rather than every percentage step; the progressbar carries the value.
 * Keep it mounted (status 'idle' renders an empty live region) so the first announcement is not lost.
 */
export function AnalysisProgress(props: { status: Status; progress: number; label: string }) {
  const busy = props.status !== 'idle';
  const pct = Math.round(props.progress * 100);
  const decoding = props.status === 'decoding';
  const label = props.label || 'Working';
  return (
    <div className={`analysis-progress${busy ? '' : ' analysis-progress--idle'}`}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {busy ? label : ''}
      </p>
      {busy && (
        <>
          <div className="analysis-progress-row" aria-hidden="true">
            <span className="analysis-progress-label">{label}</span>
            <span className="num">{decoding ? 'reading file' : `${pct}%`}</span>
          </div>
          <div
            className={`progress-track${decoding ? ' progress-track--indeterminate' : ''}`}
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={decoding ? undefined : pct}
            aria-valuetext={decoding ? 'Reading the file' : undefined}
          >
            <div className="progress-fill" style={{ width: decoding ? undefined : `${pct}%` }} />
          </div>
        </>
      )}
    </div>
  );
}
