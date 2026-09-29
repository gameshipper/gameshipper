import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheRoot, moveIntoCache } from '../../src/core/cache.js';
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

describe('moveIntoCache', () => {
  const complete = (dir: string) => fs.existsSync(path.join(dir, 'lib.so'));
  const fresh = () => {
    const root = makeTmpDir();
    writeFiles(root, { 'tmp/lib.so': 'new' });
    return { root, tmp: path.join(root, 'tmp'), dir: path.join(root, 'key') };
  };

  it('moves a finished download into place', () => {
    const { tmp, dir } = fresh();
    moveIntoCache(tmp, dir, complete);
    expect(fs.readFileSync(path.join(dir, 'lib.so'), 'utf8')).toBe('new');
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('keeps a complete copy another build put there first, and discards its own', () => {
    const { root, tmp, dir } = fresh();
    writeFiles(root, { 'key/lib.so': 'theirs' });
    moveIntoCache(tmp, dir, complete);
    expect(fs.readFileSync(path.join(dir, 'lib.so'), 'utf8')).toBe('theirs');
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('replaces an incomplete copy', () => {
    const { root, tmp, dir } = fresh();
    writeFiles(root, { 'key/partial.txt': '' });
    moveIntoCache(tmp, dir, complete);
    expect(fs.readdirSync(dir)).toEqual(['lib.so']);
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

describe('run logs', () => {
  it("keep the newest 50 of each command's logs, touching nothing else", () => {
    const dir = makeTmpDir();
    const logs = path.join(dir, '.gameshipper', 'logs');
    const stamp = (i: number) => `2020-01-01T00-${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-000Z`;
    const files: Record<string, string> = { 'notes.txt': '', 'build-notes.log': '', 'events-2020-01-01T00-00-00-000Z.jsonl': '' };
    for (let i = 0; i < 60; i++) files[`build-${stamp(i)}.log`] = '';
    for (let i = 0; i < 55; i++) files[`play-${stamp(i)}.log`] = '';
    writeFiles(logs, files);

    const ctx = createCtx(dir, 'build', { cacheDir: makeTmpDir() });

    const left = fs.readdirSync(logs).sort();
    const builds = left.filter((f) => /^build-\d/.test(f));
    expect(builds).toHaveLength(50);
    expect(builds.slice(0, 49)).toEqual(Array.from({ length: 49 }, (_, i) => `build-${stamp(i + 11)}.log`));
    expect(builds[49]).toBe(path.basename(ctx.logPath));
    expect(left.filter((f) => f.startsWith('play-'))).toHaveLength(55);
    expect(left).toEqual(expect.arrayContaining(['notes.txt', 'build-notes.log', 'events-2020-01-01T00-00-00-000Z.jsonl']));
  });
});

describe('listFiles', () => {
  it('lists files recursively as sorted posix paths', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'b.js': '', 'a/z.css': '', 'a/y/x.html': '' });
    expect(listFiles(dir)).toEqual(['a/y/x.html', 'a/z.css', 'b.js']);
  });
});
