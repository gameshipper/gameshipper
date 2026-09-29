import { describe, expect, it } from 'vitest';
import { readLock, writeLock } from '../../src/core/prepare/lockfile.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

describe('lockfile', () => {
  it('reads an empty lock when none exists', () => {
    expect(readLock(makeTmpDir())).toEqual({ version: 1, files: {} });
  });

  it('writes sorted, stable JSON', () => {
    const dir = makeTmpDir();
    writeLock(dir, { version: 1, files: { 'https://b': { path: 'b', sha256: '2' }, 'https://a': { path: 'a', sha256: '1' } } });
    expect(readText(dir, 'gameshipper.lock')).toBe(
      '{\n  "version": 1,\n  "files": {\n    "https://a": {\n      "path": "a",\n      "sha256": "1"\n    },\n    "https://b": {\n      "path": "b",\n      "sha256": "2"\n    }\n  }\n}\n',
    );
    expect(Object.keys(readLock(dir).files)).toEqual(['https://a', 'https://b']);
  });

  it('sorts by code unit, not locale, so every machine writes the same lock', () => {
    const dir = makeTmpDir();
    writeLock(dir, { version: 1, files: { 'https://a': { path: 'a', sha256: '1' }, 'https://B': { path: 'B', sha256: '2' } } });
    expect(Object.keys(readLock(dir).files)).toEqual(['https://B', 'https://a']);
  });

  it('LOCK_INVALID on a damaged file', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'gameshipper.lock': 'nope' });
    expect(() => readLock(dir)).toThrow(expect.objectContaining({ error: expect.objectContaining({ code: 'LOCK_INVALID' }) }));
  });
});
