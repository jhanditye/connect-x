// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeError, ErrorBoundary } from './ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Bomb(props: { explode: boolean }) {
  if (props.explode) throw new Error('Invalid time value');
  return <p>fine</p>;
}

describe('ErrorBoundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // React logs caught render errors; the boundary logs once more. Keep the test output quiet.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.location.hash = '';
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders its children when nothing fails', () => {
    act(() => root.render(<ErrorBoundary><Bomb explode={false} /></ErrorBoundary>));
    expect(host.textContent).toBe('fine');
  });

  it('shows a plain-English message with Reload, a way to Settings > Clear data and the error text in a collapsed block', () => {
    act(() => root.render(<ErrorBoundary level="app"><Bomb explode /></ErrorBoundary>));
    expect(host.querySelector('[role="alert"] h1')?.textContent).toBe('Something went wrong');
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Reload Mimic')).toBe(true);
    const settings = host.querySelector<HTMLAnchorElement>('a[href="#settings"]');
    expect(settings).not.toBeNull();
    expect(host.textContent).toMatch(/Delete everything, including settings/);
    const details = host.querySelector<HTMLDetailsElement>('details.app-error-details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('pre')?.textContent).toBe('Error: Invalid time value');
    // Nothing goes to a server: the component makes no network calls at all.
    expect(host.innerHTML).not.toMatch(/https?:\/\//);
  });

  it('the Settings link leaves the broken screen', () => {
    act(() => root.render(<ErrorBoundary level="page"><Bomb explode /></ErrorBoundary>));
    const link = host.querySelector<HTMLAnchorElement>('a[href="#settings"]')!;
    act(() => link.click());
    expect(window.location.hash).toBe('#settings');
  });

  it('a page boundary clears itself when its resetKey changes, and "Try this screen again" retries', () => {
    function Harness() {
      const [key, setKey] = useState('a');
      const [explode, setExplode] = useState(true);
      return (
        <>
          <button id="next" onClick={() => (setExplode(false), setKey('b'))}>next</button>
          <ErrorBoundary level="page" resetKey={key}>
            <Bomb explode={explode} />
          </ErrorBoundary>
        </>
      );
    }
    act(() => root.render(<Harness />));
    expect(host.querySelector('.app-error--page')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('#next')!.click());
    expect(host.querySelector('.app-error')).toBeNull();
    expect(host.textContent).toContain('fine');
  });

  it('a row boundary replaces only its own row', () => {
    act(() =>
      root.render(
        <ul>
          <li><ErrorBoundary level="row" rowLabel="This try could not be shown."><Bomb explode /></ErrorBoundary></li>
          <li><Bomb explode={false} /></li>
        </ul>,
      ),
    );
    const items = host.querySelectorAll('li');
    expect(items[0].textContent).toBe('This try could not be shown.');
    expect(items[1].textContent).toBe('fine');
  });

  it('describes anything that was thrown', () => {
    expect(describeError(new TypeError('x'))).toBe('TypeError: x');
    expect(describeError('plain')).toBe('plain');
  });
});
