import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioSessionState, setAudioSessionType } from './audioSession';

afterEach(() => vi.unstubAllGlobals());

describe('setAudioSessionType', () => {
  it('sets the type when navigator.audioSession exists', () => {
    const audioSession = { type: 'auto', state: 'active' };
    vi.stubGlobal('navigator', { audioSession });
    expect(setAudioSessionType('playback')).toBe(true);
    expect(audioSession.type).toBe('playback');
    expect(audioSessionState()).toBe('active');
  });

  it('is a quiet no-op without the API or when assignment throws', () => {
    vi.stubGlobal('navigator', {});
    expect(setAudioSessionType('playback')).toBe(false);
    expect(audioSessionState()).toBeNull();
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
