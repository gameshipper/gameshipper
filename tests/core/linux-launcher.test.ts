import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { linuxBinaryName, linuxLauncherScript, writeLinuxLauncher } from '../../src/core/desktop/linux-launcher.js';
import { executableFor } from '../../src/core/desktop/package.js';
import { readZipEntries } from '../../src/core/steam/zip.js';
import { writeZip } from '../../src/core/tools/zip.js';
import { makeTmpDir } from '../helpers/tmp.js';

const posix = process.platform !== 'win32';
/** The first bytes of a Linux program, which the zip writer knows an executable by where files have no modes. */
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

describe('linuxLauncherScript', () => {
  const script = linuxLauncherScript('moon-game');

  it('is a /bin/sh script that hands its process to the binary next to it, with --no-sandbox before its own arguments', () => {
    const lines = script.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines.at(-2)).toBe('exec "$dir/moon-game-bin" --no-sandbox "$@"');
    // Nothing after the exec, and nothing else is ever run in the game's place.
    expect(lines.at(-1)).toBe('');
    expect(lines.filter((l) => /^\s*exec\b/.test(l))).toHaveLength(1);
    // Once, so Chromium never gets the switch twice from the launcher.
    expect(script.match(/--no-sandbox "\$@"/g)).toHaveLength(1);
  });

  it('ends its lines with LF on every OS: a #! line ending in CR names an interpreter that does not exist', () => {
    expect(script).not.toContain('\r');
    expect(script.endsWith('\n')).toBe(true);
  });

  it('never changes the environment or the working directory Steam starts the game with', () => {
    const code = script.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    expect(code.filter((l) => /\b(cd|export|unset|env|LD_PRELOAD|LD_LIBRARY_PATH)\b/.test(l))).toEqual([]);
  });

  it("names the binary after the build, and refuses a name that isn't a slug: nothing else may reach the script", () => {
    expect(linuxBinaryName('moon-game')).toBe('moon-game-bin');
    expect(linuxLauncherScript('game2')).toContain('exec "$dir/game2-bin" --no-sandbox "$@"');
    for (const name of ['Moon Game', 'moon"; rm -rf ~; "', 'moon\ngame', '$(id)', '', '-moon', 'moon-']) expect(() => linuxLauncherScript(name), name).toThrow(/can't name a Linux build/);
  });
});

describe('writeLinuxLauncher', () => {
  it('writes the launcher under the build\'s own name, the one executableFor and the Steam launch option give, next to the binary', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'moon-game-bin'), ELF, { mode: 0o644 });
    const launcher = writeLinuxLauncher(dir, 'moon-game');
    expect(launcher).toBe(executableFor(parseConfig({ name: 'Moon Game', version: '1.0.0' }).data!, 'linux', dir));
    expect(fs.readFileSync(launcher, 'utf8')).toBe(linuxLauncherScript('moon-game'));
    expect(fs.readFileSync(path.join(dir, 'moon-game-bin'))).toEqual(ELF);
    // Both executable, whatever the binary's mode was and whatever the umask is.
    if (posix) expect([fs.statSync(launcher).mode & 0o777, fs.statSync(path.join(dir, 'moon-game-bin')).mode & 0o777]).toEqual([0o755, 0o755]);
  });

  it('replaces an older launcher, and is executable again', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'moon-game-bin'), ELF);
    fs.writeFileSync(path.join(dir, 'moon-game'), 'old', { mode: 0o600 });
    const launcher = writeLinuxLauncher(dir, 'moon-game');
    expect(fs.readFileSync(launcher, 'utf8')).toBe(linuxLauncherScript('moon-game'));
    if (posix) expect(fs.statSync(launcher).mode & 0o777).toBe(0o755);
  });

  it('throws when the build has no binary for the launcher to start, and writes nothing', () => {
    const dir = makeTmpDir();
    expect(() => writeLinuxLauncher(dir, 'moon-game')).toThrow('the Linux build has no moon-game-bin for its launcher to start');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('in a zip made on Windows, where files have no modes, the launcher and the binary are both executable', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'moon-game-bin'), ELF);
    fs.writeFileSync(path.join(dir, 'resources.pak'), 'data');
    writeLinuxLauncher(dir, 'moon-game');
    const zipFile = path.join(makeTmpDir(), 'linux.zip');
    writeZip(dir, zipFile, { platform: 'win32' });
    const modes = Object.fromEntries(readZipEntries(fs.readFileSync(zipFile)).map((e) => [e.name, e.unixMode! & 0o777]));
    expect(modes).toEqual({ 'moon-game': 0o755, 'moon-game-bin': 0o755, 'resources.pak': 0o644 });
  });

  it.skipIf(!posix)('in a zip made on macOS or Linux, both keep their executable modes', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'moon-game-bin'), ELF);
    writeLinuxLauncher(dir, 'moon-game');
    const zipFile = path.join(makeTmpDir(), 'linux.zip');
    writeZip(dir, zipFile);
    const modes = Object.fromEntries(readZipEntries(fs.readFileSync(zipFile)).map((e) => [e.name, e.unixMode! & 0o777]));
    expect(modes).toEqual({ 'moon-game': 0o755, 'moon-game-bin': 0o755 });
  });
});

/** What the stand-in binary reports about how it was started. */
interface Started {
  pid: number;
  argv: string[];
  cwd: string;
  preload: string | null;
  libraryPath: string | null;
  steamAppId: string | null;
}

/**
 * A build folder, in a path with a space, whose "binary" is a Node script: it writes how it was started to the file
 * named by REPORT, then ends the way HOW says (an exit code, or killing itself with a signal).
 */
function standInBuild(): { dir: string; launcher: string } {
  const dir = path.join(makeTmpDir('gs launcher '), 'Moon Game build');
  fs.mkdirSync(dir, { recursive: true });
  const binary = [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const e = process.env;',
    'const started = { pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), preload: e.LD_PRELOAD ?? null, libraryPath: e.LD_LIBRARY_PATH ?? null, steamAppId: e.SteamAppId ?? null };',
    'fs.writeFileSync(e.REPORT, JSON.stringify(started));',
    "if (e.HOW && e.HOW.startsWith('SIG')) process.kill(process.pid, e.HOW);",
    'else process.exitCode = Number(e.HOW ?? 0);',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'moon-game-bin'), binary);
  return { dir, launcher: writeLinuxLauncher(dir, 'moon-game') };
}

/** Every /bin/sh a player's system may have: dash (Debian, Ubuntu, SteamOS's is bash), bash, and whatever /bin/sh is here. */
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((sh) => fs.existsSync(sh));

// The stand-in binary is a script with a #! line, and the launcher a shell script: Windows runs neither.
describe.skipIf(!posix)('the launcher, run', () => {
  function run(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; how?: string } = {}) {
    const report = path.join(makeTmpDir(), 'started.json');
    // LD_PRELOAD and LD_LIBRARY_PATH only reach the stand-in through opts.env: set for real, a loader would act on them.
    const env = { PATH: process.env.PATH, ...opts.env, REPORT: report, ...(opts.how ? { HOW: opts.how } : {}) };
    const r = spawnSync(command, args, { cwd: opts.cwd, env, encoding: 'utf8' });
    const started = fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, 'utf8')) as Started) : null;
    return { status: r.status, signal: r.signal, pid: r.pid, stderr: r.stderr, started };
  }

  it('started directly (its #! line), it runs the binary with --no-sandbox first, then its own arguments unchanged', () => {
    const { launcher } = standInBuild();
    const args = ['--fullscreen', 'two words', '', '*', '$HOME', "it's", '--no-sandbox=x'];
    const r = run(launcher, args);
    expect(r.stderr).toBe('');
    expect(r.started?.argv).toEqual(['--no-sandbox', ...args]);
    expect(r.status).toBe(0);
  });

  it('with no arguments, as a double-click or the Steam launch option starts it, the binary gets exactly --no-sandbox', () => {
    const { launcher } = standInBuild();
    expect(run(launcher, []).started?.argv).toEqual(['--no-sandbox']);
  });

  it.each(SHELLS)('with %s: finds the binary from another folder, through links to it, and found on PATH', (sh) => {
    const { dir, launcher } = standInBuild();
    const elsewhere = path.join(makeTmpDir('gs else where '), 'bin dir');
    fs.mkdirSync(elsewhere, { recursive: true });
    const absolute = path.join(elsewhere, 'absolute link');
    const relative = path.join(elsewhere, 'relative-link');
    const chained = path.join(elsewhere, 'chained');
    fs.symlinkSync(launcher, absolute);
    fs.symlinkSync(path.relative(elsewhere, launcher), relative);
    fs.symlinkSync('relative-link', chained);
    const cwd = fs.realpathSync(makeTmpDir());
    const starts: Array<[string, string, string[], string]> = [
      ['its own path', sh, [launcher], cwd],
      ['a relative path', sh, [path.relative(cwd, launcher)], cwd],
      ['its name, in its own folder', sh, ['moon-game'], dir],
      ['a link with an absolute target', sh, [absolute], cwd],
      ['a link with a relative target', sh, [relative], cwd],
      ['a link to a link, by its name in its folder', sh, ['chained'], elsewhere],
    ];
    for (const [how, command, args, from] of starts) {
      const r = run(command, [...args, 'one arg'], { cwd: from });
      expect(r.stderr, how).toBe('');
      expect(r.started?.argv, how).toEqual(['--no-sandbox', 'one arg']);
      // The launcher never changes folder: the game starts in the folder it was started from.
      expect(fs.realpathSync(r.started!.cwd), how).toBe(fs.realpathSync(from));
    }
    // Typed as a command, found through PATH (the link's folder is on it; the build's isn't).
    const onPath = run('chained', ['one arg'], { cwd, env: { PATH: `${elsewhere}${path.delimiter}${process.env.PATH}` } });
    expect(onPath.started?.argv).toEqual(['--no-sandbox', 'one arg']);
  });

  it.each(SHELLS)('with %s: the binary takes over the process, so its process ID, exit code and signals are the game\'s', (sh) => {
    const { launcher } = standInBuild();
    const ok = run(sh, [launcher]);
    // The process Gameshipper or Steam started is the game itself: stopping it stops the game, not a shell around it.
    expect(ok.started?.pid).toBe(ok.pid);
    expect([ok.status, ok.signal]).toEqual([0, null]);
    expect([run(sh, [launcher], { how: '7' }).status, run(sh, [launcher], { how: '134' }).status]).toEqual([7, 134]);
    // A shell that waited for the game would end with exit code 128 + the signal's number instead.
    for (const signal of ['SIGTERM', 'SIGKILL', 'SIGTRAP'] as const) {
      const r = run(sh, [launcher], { how: signal });
      expect([r.status, r.signal], signal).toEqual([null, signal]);
    }
  });

  it("passes the environment through unchanged: Steam's overlay (LD_PRELOAD), its libraries and its App ID", () => {
    const { launcher } = standInBuild();
    const steam = { LD_PRELOAD: '/steam/ubuntu12_32/gameoverlayrenderer.so:/steam/ubuntu12_64/gameoverlayrenderer.so', LD_LIBRARY_PATH: '/steam/runtime/lib', SteamAppId: '480' };
    // The stand-in binary reads the variables; only Node's own launch would act on them, so the loader's notes about
    // overlay files that don't exist here (on Linux) are expected on stderr and nothing else is.
    const r = run(launcher, [], { env: { PATH: process.env.PATH, ...steam } });
    expect(r.started).toMatchObject({ argv: ['--no-sandbox'], preload: steam.LD_PRELOAD, libraryPath: steam.LD_LIBRARY_PATH, steamAppId: '480' });
    expect(r.status).toBe(0);
  });

  it('says so, and fails, when the binary is gone', () => {
    const { dir, launcher } = standInBuild();
    fs.rmSync(path.join(dir, 'moon-game-bin'));
    const r = run(launcher, []);
    expect(r.started).toBeNull();
    // 127 (not found) from dash and bash; POSIX allows 126 too.
    expect([126, 127]).toContain(r.status);
    expect(r.stderr).toContain('moon-game-bin');
  });
});
