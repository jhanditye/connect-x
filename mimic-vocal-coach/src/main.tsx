import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './styles/viz.css';
import { App } from './App';
import { isStandalone } from './pwa/platform';
import { startPwa } from './pwa/register';
import { requestPersistence } from './pwa/storage';
import { applyTheme, loadTheme } from './state/theme';

// Apply the saved theme before the first render so there is no flash of the wrong palette.
applyTheme(loadTheme());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline support: registers the service worker in production builds only (no-op in dev and tests).
startPwa();

// In the installed app, ask the browser to keep this origin's data (Safari decides silently, with no prompt).
if (isStandalone()) void requestPersistence();
