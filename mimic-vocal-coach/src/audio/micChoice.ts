// Which microphone to record with. On iPhone the system switches the input to Bluetooth earbuds
// (AirPods) the moment a page opens the microphone, and Bluetooth voice profiles run at 8-24 kHz mono
// (phone-call quality), which spoils the tone measures. Choosing the iPhone's own microphone avoids that:
// WebKit honours the chosen deviceId by setting it as the AVAudioSession's preferred input.
// The choice is kept under its own storage key (AppSettings keeps its shape).

import { getStorage } from '../storage/local';

const KEY = 'mimic.micDeviceId';

export function loadMicChoice(): string | null {
  try {
    return getStorage()?.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function saveMicChoice(deviceId: string | null): void {
  try {
    const s = getStorage();
    if (!s) return;
    if (deviceId) s.setItem(KEY, deviceId);
    else s.removeItem(KEY);
  } catch {
    // Storage blocked: the choice lasts until the page closes only if the caller keeps it.
  }
}

export interface MicOption {
  deviceId: string;
  /** Empty until the user has granted microphone access once (browsers hide labels before that). */
  label: string;
  bluetooth: boolean;
}

/** Names that identify Bluetooth earbuds and headsets, whose microphone runs in a low-bandwidth voice profile. */
export function looksBluetooth(label: string): boolean {
  return /airpods|bluetooth|beats|buds|headset|hands-?free|jabra|bose|sony wh|sony wf|pixel buds|galaxy buds/i.test(label);
}

/** Microphones the browser lists, or null when device listing is unsupported. */
export async function listMicrophones(): Promise<MicOption[] | null> {
  try {
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.enumerateDevices) return null;
    const devices = await md.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== '')
      .map((d) => ({ deviceId: d.deviceId, label: d.label, bluetooth: looksBluetooth(d.label) }));
  } catch {
    return null;
  }
}
