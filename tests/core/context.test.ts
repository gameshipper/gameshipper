import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheRoot } from '../../src/core/cache.js';
import { createCtx } from '../../src/core/context.js';
import { listFiles } from '../../src/core/fsutil.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

describe('cacheRoot', () => {
  it('honours GAMESHIPPER_CACHE', () => {
    expect(cacheRoot({ GAMESHIPPER_CACHE: '/x' }, 'linux', '/home/u')).toBe('/x');
  });
  it('uses the OS convention', () => {
    expect(cacheRoot({}, 'darwin', '/Users/u')).toBe(path.join('/Users/u', 'Library', 'Caches', 'gameshipper'));
    expect(cacheRoot({}, 'linux', '/home/u')).toBe(path.join('/home/u', '.cache', 'gameshipper'));
    expect(cacheRoot({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/u')).toBe(path.join('/xdg', 'gameshipper'));
    expect(cacheRoot({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe(path.join('C:\\L', 'gameshipper', 'Cache'));
  });
});

describe('createCtx', () => {
  it('writes log lines to .gameshipper/logs/<command>-<stamp>.log', () => {
    const dir = makeTmpDir();
    const ctx = createCtx(dir, 'build', { cacheDir: makeTmpDir() });
    ctx.log('hello');
    expect(path.dirname(ctx.logPath)).toBe(path.join(dir, '.gameshipper', 'logs'));
    expect(path.basename(ctx.logPath)).toMatch(/^build-.+\.log$/);
    expect(fs.readFileSync(ctx.logPath, 'utf8')).toMatch(/\] hello\n$/);
  });
});

describe('listFiles', () => {
  it('lists files recursively as sorted posix paths', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'b.js': '', 'a/z.css': '', 'a/y/x.html': '' });
    expect(listFiles(dir)).toEqual(['a/y/x.html', 'a/z.css', 'b.js']);
  });
});
