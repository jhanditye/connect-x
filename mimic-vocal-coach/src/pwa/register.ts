// Service worker registration and the update flow, as a tiny external store (read it with usePwa()).
//
// Lifecycle the user sees:
//   first visit       -> worker installs and precaches everything -> state.offlineReady = true
//   later deploy      -> new worker installs in the background and waits -> state.updateReady = true
//   user taps Update  -> applyUpdate() posts SKIP_WAITING; on controllerchange the page reloads once
// iOS keeps a Home Screen web app alive in the app switcher for days without navigating, and browsers
// only check for a new worker on navigation, so we also ask for an update whenever the app comes back
// to the foreground (at most every 30 minutes) and when the network returns.

import { useSyncExternalStore } from 'react';
import { detectNative } from './platform';

export interface PwaState {
  /** Service workers are available (secure context, supported browser, production build). */
  supported: boolean;
  /** Everything needed to run offline has been cached by the current worker. */
  offlineReady: boolean;
  /** A newer version is installed and waiting for the user to apply it. */
  updateReady: boolean;
  /** Build id of the running worker once known (the cache name suffix). */
  version: string | null;
}

let state: PwaState = { supported: false, offlineReady: false, updateReady: false, version: null };
const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | null = null;
let started = false;
let reloading = false;
let lastCheck = 0;

const CHECK_EVERY_MS = 30 * 60 * 1000;

function set(patch: Partial<PwaState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribePwa(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getPwaState(): PwaState {
  return state;
}
export function usePwa(): PwaState {
  return useSyncExternalStore(subscribePwa, getPwaState, getPwaState);
}

function watch(worker: ServiceWorker | null): void {
  if (!worker) return;
  const onState = () => {
    if (worker.state !== 'installed') return;
    // With a controller, this is an update waiting behind the running version; without one, the first install.
    if (navigator.serviceWorker.controller) set({ updateReady: true });
    else set({ offlineReady: true });
  };
  worker.addEventListener('statechange', onState);
  onState();
}

function askVersion(): void {
  // The worker answers on event.source, which arrives as a 'message' event on navigator.serviceWorker.
  navigator.serviceWorker.controller?.postMessage({ type: 'GET_VERSION' });
}

/** Ask the browser to look for a newer sw.js now. Cheap; safe to call often (throttled by callers). */
export async function checkForUpdate(): Promise<void> {
  lastCheck = Date.now();
  try {
    await registration?.update();
  } catch {
    // Offline or the host is down: the installed version keeps working.
  }
}

/** Activate the waiting worker and reload once it takes over. */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) {
    location.reload();
    return;
  }
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

/** Resolve the worker URL next to the page, so it works under https://user.github.io/repo/ and at a root. */
export function workerUrl(base: string = import.meta.env.BASE_URL, page: string = location.href): URL {
  return new URL(`${base.replace(/\/?$/, '/')}sw.js`, page);
}

export function startPwa(): void {
  if (started || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Inside the Capacitor app the web build is bundled with the app and updated with it: a service worker would only pin an old copy
  // (and WKWebView allows them for app-bound domains only). Offline needs no worker there.
  if (detectNative()) return;
  // Production builds only; the single-file build (--mode single) ships no sw.js.
  if (!import.meta.env.PROD || import.meta.env.MODE === 'single' || (typeof isSecureContext !== 'undefined' && !isSecureContext)) return;
  started = true;
  set({ supported: true });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    // The very first install also fires controllerchange (clients.claim): only reload when replacing a worker.
    if (!state.updateReady) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; version?: string }>) => {
    if (e.data?.type === 'VERSION' && e.data.version) set({ version: e.data.version });
  });

  const url = workerUrl();
  navigator.serviceWorker
    .register(url, { scope: new URL('./', url).href, updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) set({ updateReady: true });
      else if (reg.active && !reg.installing && navigator.serviceWorker.controller) set({ offlineReady: true });
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      askVersion();
      navigator.serviceWorker.ready.then(askVersion, () => undefined);
    })
    .catch(() => {
      set({ supported: false });
    });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > CHECK_EVERY_MS) void checkForUpdate();
  });
  window.addEventListener('online', () => void checkForUpdate());
}
