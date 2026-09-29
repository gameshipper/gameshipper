import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fail, gsError, ok } from '../../src/core/result.js';
import { readLastRuns, saveLastRun } from '../../src/core/runs.js';
import { getStatus } from '../../src/core/status.js';
import { GAMESHIPPER_VERSION } from '../../src/core/version.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

describe('version', () => {
  it('reads the package version', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(GAMESHIPPER_VERSION).toBe(pkg.version);
  });
});

describe('last runs', () => {
  it('saves one record per command and reads them back', () => {
    const dir = makeTmpDir();
    saveLastRun(dir, 'build', { ...ok({}), logPath: '/l/build.log' }, new Date('2026-09-28T10:00:00Z'));
    saveLastRun(dir, 'play', fail(gsError('GAME_CRASHED', 'x')), new Date('2026-09-28T11:00:00Z'));
    expect(readLastRuns(dir)).toEqual({
      build: { command: 'build', at: '2026-09-28T10:00:00.000Z', ok: true, logPath: '/l/build.log', errors: [], warnings: [] },
      play: { command: 'play', at: '2026-09-28T11:00:00.000Z', ok: false, errors: [{ code: 'GAME_CRASHED', message: 'x' }], warnings: [] },
    });
  });

  it('a later run replaces the earlier record', () => {
    const dir = makeTmpDir();
    saveLastRun(dir, 'build', fail(gsError('PACKAGE_FAILED', 'x')));
    saveLastRun(dir, 'build', ok({}));
    expect(readLastRuns(dir).build.ok).toBe(true);
  });

  it('saving is best-effort: a failure comes back as a LAST_RUN_NOT_SAVED warning', () => {
    expect(saveLastRun(makeTmpDir(), 'build', ok({}))).toBeNull();
    const dir = makeTmpDir();
    writeFiles(dir, { '.gameshipper/last': '' });
    expect(saveLastRun(dir, 'build', ok({}))).toMatchObject({
      code: 'LAST_RUN_NOT_SAVED',
      message: expect.stringContaining("Couldn't record this build for `status`"),
      fix: expect.stringContaining('.gameshipper'),
    });
  });

  it('skips damaged records', () => {
    const dir = makeTmpDir();
    saveLastRun(dir, 'build', ok({}));
    writeFiles(dir, { '.gameshipper/last/play.json': '{"command": ', '.gameshipper/last/check.json': '[]' });
    expect(Object.keys(readLastRuns(dir))).toEqual(['build']);
  });
});

describe('getStatus', () => {
  it('reports config, what this host can build, outputs and last runs', () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '',
      'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
      'out/linux/x': '',
    });
    saveLastRun(dir, 'build', ok({}));
    const r = getStatus(dir, 'win32');
    expect(r.ok).toBe(true);
    // The tests' cache holds no Steamworks SDK (vitest.config.ts).
    expect(r.warnings.map((w) => w.code)).toEqual(['STEAM_SDK_MISSING']);
    const s = r.data!;
    expect(s.projectDir).toBe(dir);
    expect(s.gameshipperVersion).toBe(GAMESHIPPER_VERSION);
    expect(s.electronVersion).toBe('44.4.5');
    expect(s.host).toEqual({ platform: 'win32', arch: process.arch });
    expect(s.config?.name).toBe('x');
    // Xcode and Android Studio projects are generated on any OS.
    expect(s.buildableHere).toEqual(['windows', 'linux', 'ios', 'android']);
    expect(s.notBuildableHere.map((n) => [n.target, n.reason.code])).toEqual([['mac', 'MAC_BUILD_HOST']]);
    expect(s.outputs).toEqual([
      { target: 'windows', dir: path.join(dir, 'out', 'windows'), exists: false },
      { target: 'mac', dir: path.join(dir, 'out', 'mac'), exists: false },
      { target: 'linux', dir: path.join(dir, 'out', 'linux'), exists: true },
      { target: 'ios', dir: path.join(dir, 'out', 'ios'), exists: false },
      { target: 'android', dir: path.join(dir, 'out', 'android'), exists: false },
    ]);
    expect(Object.keys(s.lastRuns)).toEqual(['build']);
    expect(s.steamSdk).toBeNull();
  });

  it('still answers without a config, passing config errors as warnings', () => {
    const r = getStatus(makeTmpDir(), 'darwin');
    expect(r.ok).toBe(true);
    expect(r.data!.config).toBeNull();
    expect(r.warnings[0].code).toBe('CONFIG_MISSING');
  });

  it('shows the config when only a file it names is missing, with that error as a warning', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0', icon: 'icon.png' }) });
    const r = getStatus(dir, 'linux');
    expect(r.ok).toBe(true);
    expect(r.data!.config?.name).toBe('x');
    expect(r.warnings.map((w) => w.code)).toEqual(['ENTRY_MISSING', 'ASSET_MISSING', 'STEAM_SDK_MISSING']);
  });
});
