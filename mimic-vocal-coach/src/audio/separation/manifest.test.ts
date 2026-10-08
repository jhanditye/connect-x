import { describe, expect, it } from 'vitest';
import { MAX_MODEL_BYTES, parseManifest } from './manifest';

const good = {
  name: 'Spleeter 2-stems',
  version: '1',
  bytes: 19903775,
  sha256: 'a8b5502ae4aa2c58ec3f4297c8e9150f5241242cb2cfbcb53ee700ddf3d84d2c',
  licence: 'MIT code',
  source: 'https://github.com/deezer/spleeter',
  inputRate: 44100,
};

describe('parseManifest', () => {
  it('reads a complete manifest', () => {
    expect(parseManifest(good)).toEqual(good);
  });

  it('lower-cases the hash and trims the text', () => {
    expect(parseManifest({ ...good, sha256: good.sha256.toUpperCase(), name: '  Spleeter  ' })).toMatchObject({ sha256: good.sha256, name: 'Spleeter' });
  });

  it('rejects anything missing or out of range, so a wrong manifest can never start a download', () => {
    for (const bad of [
      null,
      'text',
      {},
      { ...good, name: '' },
      { ...good, version: undefined },
      { ...good, licence: ' ' },
      { ...good, source: 3 },
      { ...good, sha256: 'abc' },
      { ...good, sha256: 'z'.repeat(64) },
      { ...good, bytes: 0 },
      { ...good, bytes: 1.5 },
      { ...good, bytes: MAX_MODEL_BYTES + 1 },
      { ...good, bytes: '19903775' },
      { ...good, inputRate: 0 },
      { ...good, inputRate: 1e9 },
    ]) {
      expect(parseManifest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
