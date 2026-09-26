import { useEffect, useRef, type MouseEvent } from 'react';
import { AppProvider } from './state/AppProvider';
import { useApp } from './state/context';
import { practiceFocusIds } from './state/reducer';
import { ROUTE_LABELS } from './state/routing';
import { TabBar, TopBar } from './ui/components/Nav';
import { GuidePage } from './ui/pages/Guide';
import { PracticePage } from './ui/pages/Practice';
import { ProgressPage } from './ui/pages/Progress';
import { ResultsPage } from './ui/pages/Results';
import { SettingsPage } from './ui/pages/Settings';
import { StudioPage } from './ui/pages/Studio';

function Page() {
  const app = useApp();
  switch (app.route) {
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

function Shell() {
  const app = useApp();
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  const hasResult = !!app.state.analysis && !!app.state.comparison;

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

  // A plain "#main" link would be read as a route by the hash router, so the skip link focuses directly.
  const skip = (e: MouseEvent) => {
    e.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <div className="app">
      <a className="skip-link" href="#studio" onClick={skip}>
        Skip to content
      </a>
      <TopBar route={app.route} resultsEnabled={hasResult} />
      <main ref={mainRef} className="main" tabIndex={-1}>
        <Page />
      </main>
      <footer className="footer">
        <p>
          Mimic analyses your singing on this device. Singer profiles are listening-based estimates; the app is not affiliated with the
          artists.
        </p>
      </footer>
      <TabBar route={app.route} resultsEnabled={hasResult} />
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
