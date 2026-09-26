// Wording for the reference comparison's style differences (user minus reference).

import { STYLE_LABELS } from '../../coach/profiles';
import type { StyleKey } from '../../types';
import { signed } from './format';

/**
 * "−54 percentage points, toward straight", "+0.12, toward airy", "−1.2 Hz, toward slow".
 * Share dimensions are stored as 0..1, so their difference is shown ×100 in percentage points
 * (a 0.54 gap is 54 points, not 0.54 %).
 */
export function styleDiffText(key: StyleKey, diff: number): string {
  if (!Number.isFinite(diff)) return '–';
  const meta = STYLE_LABELS[key];
  const share = meta?.unit === '%';
  const shown = share ? diff * 100 : diff;
  const digits = share ? 0 : Math.abs(diff) >= 10 ? 0 : Math.abs(diff) >= 1 ? 1 : 2;
  const rounded = Number(Math.abs(shown).toFixed(digits));
  const unit = share ? ` percentage point${rounded === 1 ? '' : 's'}` : meta?.unit ? ` ${meta.unit}` : '';
  const toward = diff > 0 ? meta?.highWord : meta?.lowWord;
  return `${signed(shown, digits)}${unit}${toward && rounded > 0 ? `, toward ${toward}` : ''}`;
}
