// navigator.audioSession (Safari 16.4+, iOS and macOS): tells WebKit which AVAudioSession category the page wants.
//
// Why it matters on iPhone:
//  - By default Web Audio is "ambient": it mixes with other apps but OBEYS THE RING/SILENT SWITCH, so the
//    practice tones are silent when the phone is on silent. 'playback' ignores the switch.
//  - While the microphone is open WebKit uses play-and-record by itself ('auto'). A 'playback' override left
//    behind by the practice tones would stop the microphone from capturing, so recording resets it to 'auto'.
// Feature-detected and wrapped in try/catch: browsers without the API (Chrome, Firefox) simply skip it.

export type AudioSessionType = 'auto' | 'playback' | 'ambient';

interface AudioSessionLike {
  type: string;
  readonly state?: string;
}

function session(): AudioSessionLike | null {
  try {
    const s = (globalThis.navigator as (Navigator & { audioSession?: AudioSessionLike }) | undefined)?.audioSession;
    return s ?? null;
  } catch {
    return null;
  }
}

/** Returns true when the browser accepted the type. */
export function setAudioSessionType(type: AudioSessionType): boolean {
  const s = session();
  if (!s) return false;
  try {
    if (s.type !== type) s.type = type;
    return true;
  } catch {
    return false;
  }
}

export function audioSessionState(): 'active' | 'inactive' | 'interrupted' | null {
  const state = session()?.state;
  return state === 'active' || state === 'inactive' || state === 'interrupted' ? state : null;
}
