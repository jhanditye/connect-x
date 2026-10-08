import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareForCapture, setAudioSessionType } from './audioSession';

afterEach(() => vi.unstubAllGlobals());

describe('setAudioSessionType', () => {
  it('sets the type when navigator.audioSession exists', () => {
    const audioSession = { type: 'auto', state: 'active' };
    vi.stubGlobal('navigator', { audioSession });
    expect(setAudioSessionType('playback')).toBe(true);
    expect(audioSession.type).toBe('playback');
    expect(setAudioSessionType('play-and-record')).toBe(true);
    expect(audioSession.type).toBe('play-and-record');
  });

  it('is a quiet no-op without the API or when assignment throws', () => {
    vi.stubGlobal('navigator', {});
    expect(setAudioSessionType('playback')).toBe(false);
    const hostile = {
      get type() {
        return 'auto';
      },
      set type(_v: string) {
        throw new Error('InvalidStateError');
      },
    };
    vi.stubGlobal('navigator', { audioSession: hostile });
    expect(setAudioSessionType('playback')).toBe(false);
  });
});

describe('prepareForCapture', () => {
  it('undoes a leftover playback type before the microphone opens (WebKit refuses capture under playback)', () => {
    const audioSession = { type: 'playback' };
    vi.stubGlobal('navigator', { audioSession });
    expect(prepareForCapture()).toBe(true);
    expect(audioSession.type).toBe('auto');
    expect(prepareForCapture('play-and-record')).toBe(true);
    expect(audioSession.type).toBe('play-and-record');
  });

  it('does nothing where there is no audioSession', () => {
    vi.stubGlobal('navigator', {});
    expect(prepareForCapture()).toBe(false);
  });
});
