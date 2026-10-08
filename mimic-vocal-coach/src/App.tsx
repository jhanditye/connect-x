import { useEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import { AppProvider } from './state/AppProvider';
import { useApp } from './state/context';
import { practiceFocusIds } from './state/reducer';
import { TrainerProvider, type TrainerProviderProps } from './state/TrainerProvider';
import { TrainerContext, type TrainerController } from './state/trainerContext';
import { ROUTE_LABELS, routeHash } from './state/routing';
import { shouldBlockLeave } from './ui/leaveGuard';
import { useMarkBusy } from './pwa/register';
import { openPractice } from './trainer/practiceEngine';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import { TabBar, TopBar } from './ui/components/Nav';
import { UpdateNotice } from './ui/components/UpdateNotice';
import { GuidePage } from './ui/pages/Guide';
import { MorePage } from './ui/pages/More';
import { PracticePage } from './ui/pages/Practice';
import { ProgressPage } from './ui/pages/Progress';
import { ResultsPage } from './ui/pages/Results';
import { SettingsPage } from './ui/pages/Settings';
import { StudioPage } from './ui/pages/Studio';
import { TrainerPage } from './ui/pages/Trainer';

function Page() {
  const app = useApp();
  switch (app.route) {
    case 'trainer':
      return <TrainerPage />;
    case 'more':
      return <MorePage />;
    case 'studio':
      return <StudioPage />;
    case 'results':
      return <ResultsPage />;
    case 'practice':
      return <PracticePage settings={app.state.settings} focusExerciseIds={practiceFocusIds(app.state)} onRecordDrill={app.recordDrill} />;
    case 'progress':
      return <ProgressPage sessions={app.state.sessions} onDelete={app.deleteSession} onClear={app.clearSessions} />;
    case 'guide':
      return <GuidePage />;
    case 'settings':
      return <SettingsPage />;
  }
}

function subscribeHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
const currentHash = (): string => window.location.hash;

function Shell() {
  const app = useApp();
  // A screen that failed to draw gets a fresh try whenever the address changes (another tab, another clip).
  const hash = useSyncExternalStore(subscribeHash, currentHash, () => '');
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  const hasResult = !!app.state.analysis && !!app.state.comparison;
  // A take being analysed must not be reloaded away by an update.
  useMarkBusy(app.state.status !== 'idle');

  useEffect(() => {
    document.title = `${ROUTE_LABELS[app.route]} · Mimic Vocal Coach`;
    // New page: start at the top and move focus there for keyboard and screen-reader users (not on first load).
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    if (typeof window.scrollTo === 'function') {
      try {
        window.scrollTo({ top: 0 });
      } catch {
        // jsdom and some embedded browsers do not implement scrolling.
      }
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [app.route]);

  // A screen holding something that would be lost (a recording) can hold a link back and ask first.
  useEffect(() => {
    const onClick = (e: globalThis.MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href^="#"]');
      const href = link?.getAttribute('href');
      if (href && shouldBlockLeave(href)) e.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // A plain "#main" link would be read as a route by the hash router, so the skip link focuses directly.
  const skip = (e: MouseEvent) => {
    e.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <div className="app">
      <a className="skip-link" href={routeHash(app.route)} onClick={skip}>
        Skip to content
      </a>
      <TopBar route={app.route} resultsEnabled={hasResult} />
      <UpdateNotice />
      <main ref={mainRef} className="main" tabIndex={-1}>
        <ErrorBoundary level="page" resetKey={hash}>
          <Page />
        </ErrorBoundary>
      </main>
      <footer className="footer">
        <p>
          Mimic analyses your singing on this device. Singer profiles are listening-based estimates until you measure them from recordings you own; the app is not affiliated with the
          artists.
        </p>
      </footer>
      <TabBar route={app.route} resultsEnabled={hasResult} />
    </div>
  );
}

export interface AppProps {
  /**
   * Seams for the Trainer's library. `openPractice` builds the PracticeEngine for one phrase; it defaults to the real engine
   * (trainer/practiceEngine.ts) and tests pass a fake. `store` and `importer` are for tests.
   */
  trainer?: Omit<TrainerProviderProps, 'children'>;
  /** A ready-made controller instead of the real library (tests and the layout harness use the fakes in testing/trainerFixtures.ts). */
  trainerController?: TrainerController;
}

export function App(props: AppProps = {}) {
  return (
    <ErrorBoundary level="app">
      <AppInner {...props} />
    </ErrorBoundary>
  );
}

function AppInner(props: AppProps) {
  return (
    <AppProvider>
      {props.trainerController ? (
        <TrainerContext.Provider value={props.trainerController}>
          <Shell />
        </TrainerContext.Provider>
      ) : (
        <TrainerProvider openPractice={openPractice} {...props.trainer}>
          <Shell />
        </TrainerProvider>
      )}
    </AppProvider>
  );
}
