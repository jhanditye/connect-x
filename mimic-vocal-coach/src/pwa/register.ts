// Service worker registration and the update flow, as a tiny external store (read it with usePwa()).
//
// Lifecycle the user sees:
//   first visit       -> worker installs and precaches everything -> state.offlineReady = true
//   later deploy      -> new worker installs in the background and waits -> state.updateReady = true
//   user taps Update  -> applyUpdate() posts SKIP_WAITING; on controllerchange the page reloads once
//   other tabs        -> never reloaded behind the user's back: they keep running their old code and say "updated in another tab"
//   busy tab          -> a tab that is recording or analysing (markBusy) defers its own update and its reload until the take is done
// iOS keeps a Home Screen web app alive in the app switcher for days without navigating, and browsers
// only check for a new worker on navigation, so we also ask for an update whenever the app comes back
// to the foreground (at most every 30 minutes) and when the network returns.

import { useEffect, useSyncExternalStore } from 'react';
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
  /** The person hid the "new version" bar; it comes back at the next foreground check or in Settings. */
  updateDismissed: boolean;
  /** This tab is recording or analysing, so applying the update waits until the take is done. */
  busy: boolean;
  /** The person pressed Update while busy: it will be applied as soon as the take is done. */
  updateQueued: boolean;
  /** Another tab applied an update. This tab still runs the old code and should be reloaded when convenient. */
  updatedElsewhere: boolean;
}

let state: PwaState = {
  supported: false,
  offlineReady: false,
  updateReady: false,
  version: null,
  updateDismissed: false,
  busy: false,
  updateQueued: false,
  updatedElsewhere: false,
};
const listeners = new Set<() => void>();
let registration: ServiceWorkerRegistration | null = null;
let started = false;
let reloading = false;
let lastCheck = 0;
/** True only in the tab where the person pressed Update: controllerchange reloads that tab and no other. */
let applying = false;
/** The new worker took over while this tab was busy: reload once the take is done. */
let reloadWhenIdle = false;
let hadController = false;
const busyTokens = new Set<symbol>();

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

/**
 * Tell the update flow that this tab must not be reloaded: a recording, a take being analysed, a practice attempt. Returns the function
 * that says it is over. While anything is busy, "Update now" is queued and a reload for an update waits.
 */
export function markBusy(): () => void {
  const token = Symbol('busy');
  busyTokens.add(token);
  if (!state.busy) set({ busy: true });
  return () => {
    if (!busyTokens.delete(token)) return;
    if (busyTokens.size > 0) return;
    set({ busy: false });
    if (reloadWhenIdle) reloadNow();
    else if (state.updateQueued) applyUpdate();
  };
}
export function isBusy(): boolean {
  return busyTokens.size > 0;
}
/** React: this component's screen is busy while `active` is true. */
export function useMarkBusy(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return markBusy();
  }, [active]);
}

function reloadNow(): void {
  if (reloading) return;
  reloading = true;
  location.reload();
}

/** Hide the "new version" bar for now. It returns on the next foreground check (see checkForUpdate) and stays in Settings. */
export function dismissUpdate(): void {
  set({ updateDismissed: true });
}

/** Reload this tab so it runs the version another tab installed. Waits while a take is running. */
export function reloadForUpdate(): void {
  if (isBusy()) {
    reloadWhenIdle = true;
    set({ updateQueued: true });
    return;
  }
  reloadNow();
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
  // A bar the person hid comes back with each check while the update is still waiting.
  if (state.updateDismissed) set({ updateDismissed: false });
  try {
    await registration?.update();
  } catch {
    // Offline or the host is down: the installed version keeps working.
  }
}

/**
 * Activate the waiting worker and reload this tab once it takes over. Only the tab that asks is reloaded. If a take is being recorded
 * or analysed here, nothing happens yet: the request is queued and runs when the take is done (state.updateQueued tells the screen).
 */
export function applyUpdate(): void {
  if (isBusy()) {
    if (!state.updateQueued) set({ updateQueued: true });
    return;
  }
  if (state.updateQueued) set({ updateQueued: false });
  const waiting = registration?.waiting;
  if (!waiting) {
    reloadNow();
    return;
  }
  applying = true;
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
  hadController = !!navigator.serviceWorker.controller;
  set({ supported: true });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    const replaced = hadController;
    hadController = true;
    if (!applying) {
      // The very first install also fires controllerchange (clients.claim): that is not an update. Otherwise another tab applied one;
      // this tab keeps running its current code (it may be mid-take) and offers a reload instead of doing one.
      if (replaced || state.updateReady) set({ updatedElsewhere: true, updateReady: false, updateQueued: false });
      return;
    }
    if (isBusy()) {
      reloadWhenIdle = true;
      return;
    }
    reloadNow();
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
