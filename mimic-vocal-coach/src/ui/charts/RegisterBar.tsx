// 100% stacked bar of estimated register shares (chest / mix / head), optionally with a second bar
// for the target singer's shares. Plain HTML so it reflows at any width.

import type { JSX } from 'react';
import type { RegisterLabel } from '../../types';
import { REGISTER_VARS } from './chartKit';

type Shares = { chest: number; mix: number; head: number };

const ORDER: RegisterLabel[] = ['chest', 'mix', 'head'];
const NAMES: Record<RegisterLabel, string> = { chest: 'Chest', mix: 'Mix', head: 'Head' };
/** Segments narrower than this share get no inline label (the legend and aria-label still carry it). */
const MIN_LABEL_SHARE = 0.08;

/** Clamps negatives and non-finite values to 0 and rescales to sum to 1; all zero stays all zero. */
export function normaliseShares(s: Shares): Shares {
  const c = Number.isFinite(s.chest) ? Math.max(0, s.chest) : 0;
  const m = Number.isFinite(s.mix) ? Math.max(0, s.mix) : 0;
  const h = Number.isFinite(s.head) ? Math.max(0, s.head) : 0;
  const sum = c + m + h;
  return sum > 0 ? { chest: c / sum, mix: m / sum, head: h / sum } : { chest: 0, mix: 0, head: 0 };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function describe(name: string, s: Shares): string {
  return `${name}: ${pct(s.chest)} chest, ${pct(s.mix)} mix, ${pct(s.head)} head`;
}

function Bar(props: { name: string; shares: Shares; muted?: boolean }): JSX.Element {
  const empty = props.shares.chest + props.shares.mix + props.shares.head === 0;
  const present = ORDER.filter((k) => props.shares[k] > 0);
  return (
    <div className="regbar-row">
      <span className="regbar-name">{props.name}</span>
      <div className="regbar-stack">
        <div className={`regbar-track${props.muted ? ' regbar-track--target' : ''}`}>
          {empty ? (
            <span className="regbar-empty">No data</span>
          ) : (
            present.map((k) => <span key={k} className="regbar-seg" style={{ flexGrow: props.shares[k], background: REGISTER_VARS[k] }} title={`${NAMES[k]} ${pct(props.shares[k])}`} />)
          )}
        </div>
        {/* Labels sit under their segments (same flex weights) in ink, so they stay legible on any fill. */}
        {!empty && (
          <div className="regbar-labels">
            {present.map((k) => (
              <span key={k} className="regbar-label" style={{ flexGrow: props.shares[k] }}>
                {props.shares[k] >= MIN_LABEL_SHARE ? <span className="regbar-pct num">{pct(props.shares[k])}</span> : null}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function RegisterBar(props: { chest: number; mix: number; head: number; label?: string; target?: { chest: number; mix: number; head: number } }): JSX.Element {
  const name = props.label ?? 'You';
  const user = normaliseShares(props);
  const target = props.target ? normaliseShares(props.target) : null;
  const aria = `Estimated register shares. ${describe(name, user)}${target ? `. ${describe('Target', target)}` : ''}.`;
  return (
    <div className="viz regbar">
      <div role="img" aria-label={aria} className="regbar-bars">
        <Bar name={name} shares={user} />
        {target && <Bar name="Target" shares={target} muted />}
      </div>
      <ul className="viz-legend" aria-label="Register key">
        {ORDER.map((k) => (
          <li key={k}>
            <span className="viz-key viz-key--block" style={{ background: REGISTER_VARS[k] }} aria-hidden="true" /> {NAMES[k]}
          </li>
        ))}
      </ul>
    </div>
  );
}
