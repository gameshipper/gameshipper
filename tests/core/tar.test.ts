import { describe, expect, it } from 'vitest';
import { readTgz } from '../../src/core/steam/tar.js';
import { makeTgz } from '../helpers/tgz.js';

describe('readTgz', () => {
  it('returns every regular file with its contents', () => {
    const files = readTgz(makeTgz({ 'package/package.json': '{"name":"x"}', 'package/darwin_arm64/koffi.node': Buffer.alloc(1300, 1) }));
    expect([...files.keys()]).toEqual(['package/package.json', 'package/darwin_arm64/koffi.node']);
    expect(files.get('package/package.json')!.toString()).toBe('{"name":"x"}');
    expect(files.get('package/darwin_arm64/koffi.node')).toEqual(Buffer.alloc(1300, 1));
  });
});
