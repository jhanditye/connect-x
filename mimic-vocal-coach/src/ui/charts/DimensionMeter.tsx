// One style dimension against its target: a track spanning the band +/- tolerance with the band
// shaded, the ideal ticked and the user's marker, plus a score chip and the plain-English summary.

import type { JSX } from 'react';
import type { DimensionResult, StyleKey, TargetBand } from '../../types';
import { DIM_DISPLAY, clamp, dimUnitSuffix, formatDimNumber, formatDimValue, scoreTone } from './chartKit';

/** Track domain: the band widened by the tolerance on both sides, kept within the measure's physical bounds. */
export function meterDomain(key: StyleKey, band: TargetBand): [number, number] {
  const tol = band.tolerance > 0 ? band.tolerance : Math.max(band.high - band.low, 1e-3);
  let lo = Math.min(band.low, band.ideal) - tol;
  let hi = Math.max(band.high, band.ideal) + tol;
  const meta = DIM_DISPLAY[key];
  if (meta?.min !== undefined) lo = Math.max(lo, meta.min);
  if (meta?.max !== undefined) hi = Math.min(hi, meta.max);
  if (hi <= lo) hi = lo + 1;
  return [lo, hi];
}

function pctPos(v: number, lo: number, hi: number): number {
  return clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
}

export function DimensionMeter(props: { result: DimensionResult }): JSX.Element {
  const { result } = props;
  const { key, target } = result;
  const [lo, hi] = meterDomain(key, target);
  const measured = result.value !== null && Number.isFinite(result.value);
  const value = measured ? (result.value as number) : null;
  const score = Math.round(clamp(Number.isFinite(result.score) ? result.score : 0, 0, 100));
  const tone = measured ? scoreTone(score) : null;
  const bandL = pctPos(target.low, lo, hi);
  const bandR = pctPos(target.high, lo, hi);
  const idealX = pctPos(target.ideal, lo, hi);
  const userX = value !== null ? pctPos(value, lo, hi) : 0;
  const offLow = value !== null && value < lo;
  const offHigh = value !== null && value > hi;
  const unit = dimUnitSuffix(key);
  const targetText = `target ${formatDimNumber(key, target.low)}–${formatDimNumber(key, target.high)}${unit}`;
  const targetFull = `${targetText}, ideal ${formatDimValue(key, target.ideal)}`;
  const aria =
    value !== null
      ? `${result.label}: ${formatDimValue(key, value)}; ${targetFull}; score ${score} of 100.`
      : `${result.label}: not measured in this take; ${targetFull}.`;

  return (
    <div className="viz meter">
      <div className="meter-head">
        <span className="meter-label">{result.label}</span>
        <span className="meter-value num">{value !== null ? formatDimValue(key, value) : '–'}</span>
        <span className={`meter-chip num${tone ? ` meter-chip--${tone}` : ''}`}>{measured ? score : '–'}</span>
      </div>
      <div className="meter-track" role="img" aria-label={aria}>
        <span className="meter-band" style={{ left: `${bandL}%`, width: `${Math.max(0.5, bandR - bandL)}%` }} />
        <span className="meter-ideal" style={{ left: `${idealX}%` }} />
        {value !== null ? (
          <span className={`meter-marker${offLow ? ' meter-marker--off-low' : offHigh ? ' meter-marker--off-high' : ''}`} style={{ left: `${userX}%` }} />
        ) : (
          <span className="meter-missing">not measured</span>
        )}
      </div>
      <div className="meter-scale num" aria-hidden="true">
        <span>{formatDimNumber(key, lo)}</span>
        <span className="meter-target">{targetText}</span>
        <span>{formatDimNumber(key, hi)}</span>
      </div>
      {result.summary && <p className="meter-summary">{result.summary}</p>}
    </div>
  );
}
