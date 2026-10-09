// What the audio route looks like and what to tell the singer about it. iOS gives a page very little: no output device
// list, no setSinkId, and input labels only after the microphone permission was granted once. So the route is a best guess
// from the INPUT device label (headphones are "likely" when a wired or Bluetooth input exists) and the user can always
// overrule it with the Sing along / Listen then sing switch. The wake lock for the practice screen lives here too.
//
// Pure functions over plain device lists, so they run in Node; the two browser calls (listInputDevices, requestWakeLock)
// are feature-detected and never throw.

import type { PlayMode } from '../types';
import type { RouteInfo } from './duplex';
import { keepScreenAwake, wakeLockKnownBroken } from './wakeLock';
import { isDesktopKind, type PlatformKind } from '../pwa/platform';
import { ownMicrophoneName } from '../pwa/words';

export type RouteKind = RouteInfo['kind'];

/** Labels that mean "this is on your head", bluetooth first: "Bluetooth Headset" is a Bluetooth route. */
const WIRED = /headset|headphone|earphone|earpods|lightning|wired/i;
const BUILTIN = /iphone|ipad|built-?in|internal|macbook|imac|front|back|bottom|top|microphone array/i;
/** Names that mean a Bluetooth headset. A bare "Headset Microphone" is the wired one on iPhone, so "headset" alone is not here. */
const BLUETOOTH = /airpods|bluetooth|beats|buds|hands-?free|jabra|bose|sony wh|sony wf|\bw[hf]-\d|a2dp|\bhfp\b/i;

export function classifyRoute(label: string): RouteKind {
  const text = (label ?? '').trim();
  if (!text) return 'unknown';
  if (BLUETOOTH.test(text)) return 'bluetooth';
  if (WIRED.test(text)) return 'wired';
  if (BUILTIN.test(text)) return 'builtin';
  return 'unknown';
}

export interface InputDevice {
  id: string;
  label: string;
}

type DeviceLike = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'> & { groupId?: string };

/**
 * The microphones, without Chrome's duplicate "default" and "communications" aliases of a device that is listed under its own
 * id as well. Entries without a deviceId (some browsers before permission) are kept so the count stays honest.
 */
export function inputDevices(devices: readonly DeviceLike[]): InputDevice[] {
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const real = new Set(inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => d.groupId ?? d.deviceId));
  return inputs
    .filter((d) => !((d.deviceId === 'default' || d.deviceId === 'communications') && d.groupId && real.has(d.groupId)))
    .map((d) => ({ id: d.deviceId, label: d.label }));
}

/**
 * `active` is the deviceId (or label) of the microphone in use. Headphones are "likely" when the active input is wired or
 * Bluetooth, or when any listed input is: on iPhone the picker can show the AirPods microphone while the singer has chosen the
 * iPhone's own, and the sound still goes to the AirPods.
 */
export function describeRoute(devices: readonly DeviceLike[], active: string, sampleRate = 0, inputSampleRate: number | null = null): RouteInfo {
  const inputs = inputDevices(devices);
  const current = inputs.find((i) => i.id === active || (active !== '' && i.label === active)) ?? inputs.find((i) => i.label !== '') ?? inputs[0];
  const label = current?.label ?? '';
  const kind = classifyRoute(label);
  const anyHeadphones = inputs.some((i) => {
    const k = classifyRoute(i.label);
    return k === 'wired' || k === 'bluetooth';
  });
  return {
    inputLabel: label,
    inputs,
    kind,
    headphonesLikely: kind === 'wired' || kind === 'bluetooth' || anyHeadphones,
    sampleRate,
    inputSampleRate,
    labelsHidden: inputs.length > 0 && inputs.every((i) => i.label === ''),
  };
}

/** enumerateDevices(), or null when the browser cannot list devices. Labels are empty until the microphone was allowed once. */
export async function listInputDevices(): Promise<InputDevice[] | null> {
  try {
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.enumerateDevices) return null;
    return inputDevices(await md.enumerateDevices());
  } catch {
    return null;
  }
}

export interface MicChoice {
  id: string;
  /** What to show: the browser's label, or "Microphone 2" while the labels are hidden. */
  label: string;
  kind: RouteKind;
  /** The one in use now. */
  current: boolean;
  /** Worth offering first: the phone's own microphone while a Bluetooth one is active (it keeps the full sound quality). */
  recommended: boolean;
}

/** Data for the microphone picker, in the browser's order. */
export function micChoices(route: Pick<RouteInfo, 'inputs' | 'inputLabel'>): MicChoice[] {
  const bluetoothActive = classifyRoute(route.inputLabel) === 'bluetooth';
  return route.inputs.map((d, i) => {
    const kind = classifyRoute(d.label);
    return {
      id: d.id,
      label: d.label || `Microphone ${i + 1}`,
      kind,
      current: d.label !== '' ? d.label === route.inputLabel : i === 0,
      recommended: bluetoothActive && kind === 'builtin',
    };
  });
}

/** Below this the microphone is not recording wideband audio: phone-call quality, and the tone measures lose their top end. */
export const LOW_SAMPLE_RATE_HZ = 32000;

export interface RouteNote {
  id: 'bluetooth-mic' | 'low-sample-rate' | 'no-headphones' | 'labels-hidden' | 'speaker-sing-along';
  level: 'info' | 'warn';
  /** Plain words that name the next step. */
  message: string;
  /** What the button next to it does, when there is one. */
  action?: 'use-builtin-mic' | 'listen-then-sing' | 'allow-microphone';
}

/**
 * Things worth telling the singer about the route before a take. `mode` is the play mode they picked; sing-along without
 * headphones is the one combination that can give a confident wrong score (the speaker leaks into the microphone).
 */
export function routeNotes(route: RouteInfo, mode: PlayMode = 'turn-taking', kind: PlatformKind = 'other'): RouteNote[] {
  const desk = isDesktopKind(kind);
  const notes: RouteNote[] = [];
  const bluetooth = route.kind === 'bluetooth';
  const hasBuiltin = route.inputs.some((i) => classifyRoute(i.label) === 'builtin');
  if (bluetooth) {
    notes.push({
      id: 'bluetooth-mic',
      level: 'warn',
      message: `This looks like a Bluetooth microphone${route.inputLabel ? ` (${route.inputLabel})` : ''}. Bluetooth drops to phone-call quality when its microphone is on, and adds delay.${hasBuiltin ? ` Use ${ownMicrophoneName(kind)} instead; the headphones still play the guide.` : ''}`,
      action: hasBuiltin ? 'use-builtin-mic' : undefined,
    });
  }
  const inRate = route.inputSampleRate ?? null;
  if (inRate !== null && inRate > 0 && inRate < LOW_SAMPLE_RATE_HZ) {
    notes.push({
      id: 'low-sample-rate',
      level: 'warn',
      message: `The microphone records at ${Math.round(inRate / 1000)} kHz, which is phone-call quality. Pitch is fine; the tone scores (airy, bright) are less reliable.`,
      action: hasBuiltin && bluetooth ? 'use-builtin-mic' : undefined,
    });
  } else if (route.sampleRate > 0 && route.sampleRate < LOW_SAMPLE_RATE_HZ && !bluetooth) {
    notes.push({
      id: 'low-sample-rate',
      level: 'info',
      message: `The audio engine runs at ${Math.round(route.sampleRate / 1000)} kHz here. Pitch is fine; the tone scores are less reliable.`,
    });
  }
  if (route.labelsHidden) {
    notes.push({
      id: 'labels-hidden',
      level: 'info',
      message: `The browser hides the names of the microphones until you allow one. ${desk ? 'Click' : 'Tap'} Sing once and allow it; then this can tell headphones from the speaker.`,
      action: 'allow-microphone',
    });
  } else if (!route.headphonesLikely && mode === 'sing-along') {
    notes.push({
      id: 'speaker-sing-along',
      level: 'warn',
      message: desk
        ? 'No headphones detected. A laptop or desktop speaker sits right next to its microphone, so the microphone hears the guide too and the score can be wrong. Put headphones on (wired, USB or Bluetooth), or listen first and then sing.'
        : 'No headphones detected. With the guide playing through the speaker, the microphone hears it too and the score can be wrong. Plug in headphones, or listen first and then sing.',
      action: 'listen-then-sing',
    });
  } else if (!route.headphonesLikely) {
    notes.push({
      id: 'no-headphones',
      level: 'info',
      message: desk
        ? 'No headphones detected, so you will listen first and then sing. Connect headphones to sing along with the guide. (Headphones without a microphone cannot be seen by a browser: if you have them on, choose Sing along and say so when asked.)'
        : 'No headphones detected, so you will listen first and then sing. Plug in headphones to sing along with the guide.',
    });
  }
  return notes;
}

/** The browser has a screen wake lock that is known to work here (an installed Home Screen app before iOS 18.4 has the call but it does nothing). */
export function wakeLockSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!(navigator as Navigator & { wakeLock?: unknown }).wakeLock && !wakeLockKnownBroken();
  } catch {
    return false;
  }
}

/**
 * Keeps the screen on while a practice screen is open (iOS 18.4+, including Home Screen apps; elsewhere it quietly does
 * nothing). It is taken again when the page comes back from the background. Call the returned function to release. Never throws.
 */
export function requestWakeLock(): Promise<() => void> {
  try {
    const lock = keepScreenAwake();
    return Promise.resolve(() => lock.release());
  } catch {
    return Promise.resolve(() => undefined);
  }
}
