import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSteamCmd, STEAMCMD_ARCHIVES, steamCmdEnv, steamCmdPaths } from '../../../src/core/publish/steam/steamcmd.js';
import { testCtx } from '../../helpers/ctx.js';
import { startServer, type TestServer } from '../../helpers/server.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('where SteamCMD lives and how it runs', () => {
  it("pins Valve's archives for every desktop OS", () => {
    expect(Object.keys(STEAMCMD_ARCHIVES).sort()).toEqual(['darwin', 'linux', 'win32']);
    for (const a of Object.values(STEAMCMD_ARCHIVES)) {
      expect(a!.url).toMatch(/^https:\/\/steamcdn-a\.akamaihd\.net\/client\/installer\/steamcmd/);
      expect(a!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('lives in the cache, with a HOME of its own on macOS and Linux', () => {
    const mac = steamCmdPaths('/c', 'darwin');
    expect(mac).toEqual({
      installDir: path.resolve('/c', 'tools', 'steamcmd', 'app'),
      homeDir: path.resolve('/c', 'tools', 'steamcmd', 'home'),
      program: 'steamcmd.sh',
      executable: path.resolve('/c', 'tools', 'steamcmd', 'app', 'steamcmd.sh'),
    });
    expect(steamCmdPaths('/c', 'win32').executable).toBe(path.resolve('/c', 'tools', 'steamcmd', 'app', 'steamcmd.exe'));
    expect(steamCmdEnv(mac, 'darwin', { HOME: '/Users/me', PATH: '/bin' })).toEqual({ HOME: mac.homeDir, PATH: '/bin' });
    expect(steamCmdEnv(mac, 'win32', { USERPROFILE: 'C:\\u' })).toEqual({ USERPROFILE: 'C:\\u' });
  });

  it('its HOME is an absolute path, even with a relative cache folder', () => {
    const paths = steamCmdPaths(path.join('rel', 'cache'), 'linux');
    expect(paths.homeDir).toBe(path.resolve('rel', 'cache', 'tools', 'steamcmd', 'home'));
    expect(steamCmdEnv(paths, 'linux', {}).HOME).toBe(paths.homeDir);
  });

  it('on Linux, keeps its XDG folders in its own HOME too', () => {
    const paths = steamCmdPaths('/c', 'linux');
    const env = steamCmdEnv(paths, 'linux', { HOME: '/home/me', XDG_CONFIG_HOME: '/home/me/.config', XDG_DATA_HOME: '/d', XDG_CACHE_HOME: '/x' });
    expect(env).toEqual({
      HOME: paths.homeDir,
      XDG_CONFIG_HOME: path.join(paths.homeDir, '.config'),
      XDG_DATA_HOME: path.join(paths.homeDir, '.local', 'share'),
      XDG_CACHE_HOME: path.join(paths.homeDir, '.cache'),
    });
  });

  it("never gets the other destinations' tokens or the Apple signing variables", () => {
    const base = {
      PATH: '/bin',
      GAMESHIPPER_CACHE: '/c',
      GITHUB_TOKEN: 'g',
      GH_TOKEN: 'h',
      gh_token: 'lower case, as Windows allows',
      BUTLER_API_KEY: 'b',
      GAMESHIPPER_MAC_IDENTITY: 'Developer ID Application: Someone (ABCDE12345)',
      GAMESHIPPER_NOTARY_PROFILE: 'p',
      GAMESHIPPER_NOTARY_KEY: '/keys/k.p8',
      GAMESHIPPER_NOTARY_KEY_ID: 'k',
      GAMESHIPPER_NOTARY_ISSUER: 'i',
    };
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const env = steamCmdEnv(steamCmdPaths('/c', platform), platform, base);
      expect(Object.keys(env).filter((k) => !k.startsWith('XDG_') && k !== 'HOME'), platform).toEqual(['PATH', 'GAMESHIPPER_CACHE']);
    }
  });
});

describe('ensureSteamCmd', () => {
  it('GAMESHIPPER_STEAMCMD runs another program instead, still with the HOME of its own', async () => {
    const ctx = testCtx(makeTmpDir());
    const tool = await ensureSteamCmd(ctx, { env: { GAMESHIPPER_STEAMCMD: '/fakes/steamcmd.mjs' }, platform: 'darwin' });
    expect([tool.command, tool.args]).toEqual([process.execPath, ['/fakes/steamcmd.mjs']]);
    expect(tool.env.HOME).toBe(steamCmdPaths(ctx.cacheDir, 'darwin').homeDir);
    expect(fs.existsSync(tool.env.HOME!)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('makes its HOME, where its login lives, readable only by you', async () => {
    const ctx = testCtx(makeTmpDir());
    const home = steamCmdPaths(ctx.cacheDir, process.platform).homeDir;
    fs.mkdirSync(home, { recursive: true, mode: 0o755 });
    fs.chmodSync(home, 0o755);
    const tool = await ensureSteamCmd(ctx, { env: { GAMESHIPPER_STEAMCMD: '/fakes/steamcmd.mjs' } });
    expect(fs.statSync(tool.env.HOME!).mode & 0o777).toBe(0o700);
    fs.rmSync(home, { recursive: true });
    await ensureSteamCmd(ctx, { env: { GAMESHIPPER_STEAMCMD: '/fakes/steamcmd.mjs' } });
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it("TOOL_UNSUPPORTED_HOST where Valve doesn't make SteamCMD", async () => {
    const ctx = testCtx(makeTmpDir());
    for (const [platform, arch] of [
      ['linux', 'arm64'],
      ['freebsd', 'x64'],
    ] as const) {
      await expect(ensureSteamCmd(ctx, { env: {}, platform, arch })).rejects.toMatchObject({ error: { code: 'TOOL_UNSUPPORTED_HOST' } });
    }
  });

  it.skipIf(process.platform === 'win32')('downloads once into the cache, then works offline', async () => {
    const src = makeTmpDir();
    writeFiles(src, { 'steamcmd.sh': '#!/bin/sh\n' });
    const tgz = path.join(makeTmpDir(), 'steamcmd_osx.tar.gz');
    expect(spawnSync('tar', ['-czf', tgz, '-C', src, '.']).status).toBe(0);
    const body = fs.readFileSync(tgz);
    server = await startServer({ '/steamcmd_osx.tar.gz': { body } });
    const archive = { url: `${server.base}/steamcmd_osx.tar.gz`, sha256: createHash('sha256').update(body).digest('hex'), format: 'tar.gz' as const };
    const ctx = testCtx(makeTmpDir());
    const first = await ensureSteamCmd(ctx, { env: {}, platform: 'darwin', archive });
    expect(first.command).toBe(steamCmdPaths(ctx.cacheDir, 'darwin').executable);
    expect(fs.existsSync(first.command)).toBe(true);
    await server.close();
    server = undefined;
    expect((await ensureSteamCmd(ctx, { env: {}, platform: 'darwin', archive })).command).toBe(first.command);
  });
});
