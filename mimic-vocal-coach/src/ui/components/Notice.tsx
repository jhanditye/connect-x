import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type NoticeTone = 'info' | 'warn' | 'error';

/** An inline message on the paper. Errors are announced (role="alert"); others are polite. */
export function Notice(props: { tone?: NoticeTone; title?: string; children?: ReactNode; onDismiss?: () => void; className?: string }) {
  const tone = props.tone ?? 'info';
  return (
    <div className={`notice notice--${tone} ${props.className ?? ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="notice-body">
        {props.title && <p className="notice-title">{props.title}</p>}
        {props.children}
      </div>
      {props.onDismiss && (
        <button type="button" className="icon-button" onClick={props.onDismiss} aria-label="Dismiss message">
          <Icon name="close" size={18} />
        </button>
      )}
    </div>
  );
}
