import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { executableFor, packageDesktop, packagerOptions, removeStalePackOutput } from '../../src/core/desktop/package.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const config = parseConfig({ name: 'Moon Game', version: '1.2.3' }).data!;

describe('packagerOptions', () => {
  const linuxJob = { target: 'linux', platform: 'linux', arch: 'x64', warnings: [] } as const;

  it('maps a job to @electron/packager options', () => {
    const opts = packagerOptions(
      config,
      '/p/.gameshipper/app',
      '/p/.gameshipper/pack',
      '/p/.gameshipper/packager-tmp',
      '/p/.gameshipper/icons/icon',
      { ...linuxJob, warnings: [] },
    );
    expect(opts).toMatchObject({
      dir: '/p/.gameshipper/app',
      out: '/p/.gameshipper/pack',
      tmpdir: '/p/.gameshipper/packager-tmp',
      platform: 'linux',
      arch: 'x64',
      electronVersion: '44.4.5',
      name: 'Moon Game',
      executableName: 'moon-game',
      appVersion: '1.2.3',
      appBundleId: 'local.gameshipper.moongame',
      icon: '/p/.gameshipper/icons/icon',
      asar: { unpack: '*.{node,dll,dylib,so}' },
      osxUniversal: { x64ArchFiles: '*.node' },
      overwrite: true,
      prune: false,
      quiet: true,
      appCategoryType: 'public.app-category.games',
      appCopyright: `Copyright © ${new Date().getFullYear()} Moon Game`,
    });
    expect(opts.win32metadata).toEqual({ ProductName: 'Moon Game', FileDescription: 'Moon Game', CompanyName: 'Moon Game' });
  });

  it('keeps the display name for Windows and Mac executables and omits a missing icon', () => {
    const win = packagerOptions(config, 'a', 'o', 't', null, { target: 'windows', platform: 'win32', arch: 'x64', warnings: [] });
    expect(win.executableName).toBe('Moon Game');
    expect(win.icon).toBeUndefined();
  });

  it("keeps every file of the assembled app, including .obj models packager's default ignore list drops", () => {
    const opts = packagerOptions(config, 'a', 'o', 't', null, { ...linuxJob, warnings: [] });
    expect(typeof opts.ignore).toBe('function');
    const ignore = opts.ignore as (file: string) => boolean;
    for (const file of ['/game/models/ship.obj', '/game/lib/thing.o', '/game/package-lock.json', '/shell/main.js']) {
      expect(ignore(file)).toBe(false);
    }
  });
});

describe('executableFor', () => {
  it('points at the file a player (or Steam launch option) runs', () => {
    expect(executableFor(config, 'windows', '/o/windows')).toBe(path.join('/o/windows', 'Moon Game.exe'));
    expect(executableFor(config, 'linux', '/o/linux')).toBe(path.join('/o/linux', 'moon-game'));
    expect(executableFor(config, 'mac', '/o/mac')).toBe(path.join('/o/mac', 'Moon Game.app', 'Contents', 'MacOS', 'Moon Game'));
  });

  it('uses the same file-safe name packager gives the .exe, the .app and its binary', () => {
    const space = parseConfig({ name: 'Space: The Game', version: '1.0.0' }).data!;
    expect(executableFor(space, 'windows', '/o/windows')).toBe(path.join('/o/windows', 'Space- The Game.exe'));
    expect(executableFor(space, 'mac', '/o/mac')).toBe(path.join('/o/mac', 'Space- The Game.app', 'Contents', 'MacOS', 'Space- The Game'));
    expect(executableFor(space, 'linux', '/o/linux')).toBe(path.join('/o/linux', 'space-the-game'));
  });
});

describe('removeStalePackOutput', () => {
  it("removes packager's leftover folders for one platform, whatever the game was called", () => {
    const packDir = makeTmpDir();
    writeFiles(packDir, {
      'Moon Game-linux-x64/moon-game': '',
      'Old Name-linux-x64/old-name': '',
      'Moon Game-linux-arm64/moon-game': '',
      'Moon Game-win32-x64/Moon Game.exe': '',
      'Moon Game-darwin-universal/x': '',
      'Moon Game-darwin-arm64/x': '',
    });
    removeStalePackOutput(packDir, 'linux');
    expect(fs.readdirSync(packDir).sort()).toEqual(['Moon Game-darwin-arm64', 'Moon Game-darwin-universal', 'Moon Game-win32-x64']);
    removeStalePackOutput(packDir, 'darwin');
    expect(fs.readdirSync(packDir)).toEqual(['Moon Game-win32-x64']);
  });

  it('does nothing when the pack folder does not exist', () => {
    expect(() => removeStalePackOutput(`${makeTmpDir()}/missing`, 'win32')).not.toThrow();
  });
});

describe('packageDesktop', () => {
  const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(!canLock)("PACKAGE_FAILED with a fix when an earlier build's output can't be removed", async () => {
    const projectDir = makeTmpDir();
    const packDir = path.join(projectDir, '.gameshipper', 'pack');
    writeFiles(packDir, { 'Moon Game-linux-x64/moon-game': '' });
    // Stands in for a folder Windows keeps locked (EBUSY) while the old build runs or Explorer shows it.
    fs.chmodSync(packDir, 0o555);
    try {
      const job = { target: 'linux', platform: 'linux', arch: 'x64', warnings: [] } as const;
      const run = packageDesktop(testCtx(projectDir), config, path.join(projectDir, 'app'), null, job);
      await expect(run).rejects.toMatchObject({
        error: {
          code: 'PACKAGE_FAILED',
          message: expect.stringContaining('Moon Game-linux-x64'),
          fix: expect.stringContaining('in use or read-only'),
        },
      });
    } finally {
      fs.chmodSync(packDir, 0o755);
    }
  });
});
