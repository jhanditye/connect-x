// The practice messages are fixed text built once when the module loads, in the words of the device. Each case loads a fresh copy
// of the module after the user agent has been set.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecorderError } from '../audio/recorder';

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

async function loadAs(userAgent: string, platform: string, touch: number) {
  vi.resetModules();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touch });
  return import('./practiceSession');
}

afterEach(() => {
  for (const key of ['userAgent', 'platform', 'maxTouchPoints']) Reflect.deleteProperty(navigator, key);
});

describe('practice messages on a Mac', () => {
  it('say click and the computer, and no phone words', async () => {
    const m = await loadAs(MAC_SAFARI, 'MacIntel', 0);
    const all = [
      m.COPY.gap,
      m.COPY.empty,
      m.COPY.noSpeaker,
      m.COPY.cancelled,
      m.COPY.audioBusy,
      m.COPY.noAudioApi,
      m.COPY.guideFailed('x'),
      m.COPY.analysisFailed('x'),
      m.COPY.playbackFailed('x'),
      m.microphoneMessage(new RecorderError('denied', 'Microphone access was blocked.')),
      m.microphoneMessage(new Error('boom')),
      ...(['hidden', 'mic-ended', 'device-change', 'no-audio', 'audio-session'] as const).flatMap((r) => [m.interruptionMessage(r, 'take'), m.interruptionMessage(r, 'playback')]),
    ];
    for (const text of all) {
      expect(text, text).not.toMatch(/\b[Tt]ap\b|iPhone|Home Screen|the phone/);
    }
    expect(m.COPY.empty).toMatch(/Click Sing to try again/);
    expect(m.COPY.gap).toMatch(/the computer was busy/);
    expect(m.microphoneMessage(new Error('boom'))).toMatch(/click Sing to try again\. You can still click Listen/);
    expect(m.interruptionMessage('no-audio', 'take')).toMatch(/System Settings, then Sound, then Input/);
    expect(m.interruptionMessage('hidden', 'playback')).toMatch(/click Listen to hear it again/);
  });
});

describe('practice messages on an iPhone', () => {
  it('keep the words they always had', async () => {
    const m = await loadAs(IPHONE, 'iPhone', 5);
    expect(m.COPY.empty).toMatch(/Tap Sing to try again/);
    expect(m.COPY.gap).toMatch(/the phone was busy/);
    expect(m.COPY.noAudioApi).toMatch(/Home Screen/);
    expect(m.microphoneMessage(new Error('boom'))).toMatch(/tap Sing to try again\. You can still tap Listen/);
    expect(m.interruptionMessage('no-audio', 'take')).toMatch(/Settings, then Mimic or Safari, then Microphone/);
  });
});
