// Error boundaries. Without one, any exception while rendering unmounts the whole app: a blank screen with no tab bar, no Settings
// and (in a Home Screen app) no reload button. Two flavours share one class:
//   - the app boundary (App.tsx) wraps everything and shows a full-screen message with Reload and a way to Settings > Delete everything;
//   - the page boundary wraps the routed page inside the shell, so the tab bar stays and another tab can be opened;
//   - a row boundary wraps one list row or chart, so a single unreadable record hides itself instead of taking the screen down.
// Nothing is logged remotely: the error text is shown in a collapsible block and goes to the local console only.

import { Component, type ErrorInfo, type MouseEvent, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 'app' (default): full-screen. 'page': inline in the shell. 'row': a quiet one-line note. */
  level?: 'app' | 'page' | 'row';
  /** The boundary clears itself when this changes (the route, or a record id). */
  resetKey?: string | number | null;
  /** What the row was (row level only): "This try could not be shown." */
  rowLabel?: string;
}

interface State {
  error: Error | null;
}

/** The text shown in the collapsible block. Never contains audio or a stack that names user data. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(describeError(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Local console only: nothing leaves the device.
    console.error('Mimic: a screen failed to draw.', error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  private openSettings = (e: MouseEvent<HTMLAnchorElement>): void => {
    // The hash router reads the hash. The page boundary clears itself when the route changes (resetKey); the app boundary has
    // no key, so it tries drawing again.
    e.preventDefault();
    if (typeof location !== 'undefined') location.hash = '#settings';
    if ((this.props.level ?? 'app') === 'app') this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const level = this.props.level ?? 'app';

    if (level === 'row') {
      return (
        <p className="row-error" role="status">
          {this.props.rowLabel ?? 'This item could not be shown.'}
        </p>
      );
    }

    return (
      <div className={`app-error app-error--${level}`} role="alert">
        <h1 className="app-error-title">Something went wrong</h1>
        <p>
          {level === 'page' ? 'This screen could not be drawn. ' : 'Mimic could not draw this screen. '}
          Your clips and scores are still on this device; nothing was sent anywhere. Reloading usually fixes it.
        </p>
        <div className="button-row">
          <button type="button" className="button button--accent" onClick={() => location.reload()}>
            Reload Mimic
          </button>
          {level === 'page' && (
            <button type="button" className="button button--ghost" onClick={this.reset}>
              Try this screen again
            </button>
          )}
        </div>
        <p>
          If it keeps happening, the saved data may be damaged. Open{' '}
          <a href="#settings" onClick={this.openSettings}>
            Settings
          </a>{' '}
          and use <b>Delete everything, including settings</b> (back up your library first if you can; a backup never holds audio).
        </p>
        <details className="app-error-details">
          <summary>Error details</summary>
          <pre>{describeError(error)}</pre>
        </details>
      </div>
    );
  }
}
