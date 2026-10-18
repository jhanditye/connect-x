// Small presentational pieces shared by the Skills shell screens: a segmented radio group in the app's style, a list of
// findings, the breath safety notes, and a back link to the hub.

import { useId, type ReactNode } from 'react';
import { BREATH_SAFETY_NOTES } from '../../../skills/theory/breath';
import type { Finding } from '../../../skills/types';
import { Icon } from '../../components/Icon';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/** A row of radio buttons drawn as a segmented control (the same markup as the Settings theme picker). */
export function Segmented<T extends string>(props: { legend: string; value: T; options: readonly SegmentedOption<T>[]; onChange(v: T): void; hint?: ReactNode; name?: string }) {
  const auto = useId();
  const name = props.name ?? `seg-${auto.replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <fieldset className="segmented">
      <legend className="field-label">{props.legend}</legend>
      <div className="segmented-options">
        {props.options.map((o) => (
          <label key={o.value} className="segmented-option">
            <input type="radio" name={name} value={o.value} checked={props.value === o.value} onChange={() => props.onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {props.hint ? <p className="field-hint">{props.hint}</p> : null}
    </fieldset>
  );
}

const TONE_ICON: Record<Finding['tone'], 'check' | 'info' | 'spark'> = { good: 'check', info: 'info', work: 'spark' };
const TONE_LABEL: Record<Finding['tone'], string> = { good: 'Going well', info: 'Note', work: 'Work on next' };

/** Plain-English findings, each marked as praise, a neutral note or something to work on. */
export function FindingList(props: { findings: readonly Finding[]; className?: string }) {
  if (props.findings.length === 0) return null;
  return (
    <ul className={`sk-findings ${props.className ?? ''}`.trim()}>
      {props.findings.map((f, i) => (
        <li key={i} className={`sk-finding sk-finding--${f.tone}`}>
          <Icon name={TONE_ICON[f.tone]} size={18} className="sk-finding-icon" />
          <span>
            <span className="visually-hidden">{TONE_LABEL[f.tone]}: </span>
            {f.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The breath safety notes (always shown wherever breathing is practised). */
export function BreathSafety(props: { compact?: boolean }) {
  return (
    <aside className="sk-safety" aria-label="Breathing safely">
      <p className="sk-safety-title">Breathing safely</p>
      <ul className="plain-list">
        {(props.compact ? BREATH_SAFETY_NOTES.slice(0, 3) : BREATH_SAFETY_NOTES).map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </aside>
  );
}

/** "Back to Skills" link at the top of a Skills screen. */
export function BackToHub(props: { onExit(): void; label?: string }) {
  return (
    <a
      className="sk-back"
      href="#skills"
      onClick={(e) => {
        e.preventDefault();
        props.onExit();
      }}
    >
      <Icon name="back" size={16} />
      {props.label ?? 'Skills'}
    </a>
  );
}
