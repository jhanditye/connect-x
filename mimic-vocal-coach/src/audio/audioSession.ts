// navigator.audioSession (Safari 16.4+, iOS and macOS): tells WebKit which AVAudioSession category the page wants. This is the ONE
// place the app sets it (the duplex session, the recorder, the practice tones and the import preview all come here).
//
// Why it matters on iPhone:
//  - By default Web Audio is "ambient": it mixes with other apps but OBEYS THE RING/SILENT SWITCH, so the
//    practice tones are silent when the phone is on silent. 'playback' ignores the switch.
//  - WebKit refuses getUserMedia({ audio }) (InvalidStateError "AudioSession category is not compatible with audio capture")
//    unless the type is 'auto' or 'play-and-record'. A 'playback' override left behind by the practice tones or the import
//    preview would therefore stop the microphone from opening: every capture start goes through prepareForCapture().
// Feature-detected and wrapped in try/catch: browsers without the API (Chrome, Firefox) simply skip it.
//
// Not used: `navigator.audioSession.state` and its 'statechange' event. They sit behind a setting that is off in shipping WebKit, so
// they never report; interruptions are read from the AudioContext's own 'statechange' (audio/duplex.ts, audio/recorder.ts).

export type AudioSessionType = 'auto' | 'playback' | 'ambient' | 'play-and-record' | 'transient' | 'transient-solo';

interface AudioSessionLike {
  type: string;
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
    s.type = type;
    return true;
  } catch {
    return false;
  }
}

/**
 * Call before anything that opens the microphone (getUserMedia). 'play-and-record' for a session that also plays the guide
 * (audio/duplex.ts); 'auto' (the default) lets WebKit choose, which is right for a recorder that only listens.
 */
export function prepareForCapture(type: 'auto' | 'play-and-record' = 'auto'): boolean {
  return setAudioSessionType(type);
}
