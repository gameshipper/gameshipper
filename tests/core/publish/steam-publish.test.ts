import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findDesktopBuilds } from '../../../src/core/publish/builds.js';
import { publishSteam, type SteamOptions } from '../../../src/core/publish/steam/publish.js';
import { steamCmdPaths } from '../../../src/core/publish/steam/steamcmd.js';
import { runExternal, type ToolCommand } from '../../../src/core/tools/run.js';
import { testCtx } from '../../helpers/ctx.js';
import { FAKE_STEAMCMD, fakeProject } from '../../helpers/fake-builds.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

interface Setup {
  state: string;
  handOffs: string[][];
  notices: string[];
  opts: SteamOptions;
}

function setup(extra: Partial<SteamOptions> = {}, mode = 'ok', loggedIn = true): Setup {
  const state = makeTmpDir('gs-steamcmd-');
  if (loggedIn) fs.writeFileSync(path.join(state, 'login-builder'), 'token');
  const handOffs: string[][] = [];
  const notices: string[] = [];
  const opts: SteamOptions = {
    dryRun: false,
    interactive: false,
    env: { ...process.env, GAMESHIPPER_STEAMCMD: FAKE_STEAMCMD, FAKE_STEAMCMD_STATE: state, FAKE_STEAMCMD_MODE: mode },
    // Stands in for the terminal hand-off: runs the fake without a terminal and returns its exit code.
    handOff: async (tool: ToolCommand, args: string[]) => {
      handOffs.push(args);
      return (await runExternal(tool, args, { timeoutMs: 20_000 })).exitCode ?? 1;
    },
    notice: (m) => void notices.push(m),
    platform: process.platform,
    arch: process.arch,
    steamUser: 'builder',
    branch: null,
    ...extra,
  };
  return { state, handOffs, notices, opts };
}

const jsonl = (file: string): any[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

const steamProject = () => fakeProject({ steam: { appId: 1234560 } });

describe('publishSteam', () => {
  it('uploads one build with a depot per OS, leaves every steam_appid.txt out, and reports the BuildID', async () => {
    const p = steamProject();
    writeFiles(p.dir, {
      'out/windows/steam_appid.txt': '1234560',
      'out/windows/resources/steam_appid.txt': '1234560',
      'out/linux/resources/app/deep/steam_appid.txt': '1234560',
      'out/linux/my_steam_appid.txt': 'kept',
    });
    const s = setup();
    const ctx = testCtx(p.dir);
    const r = await publishSteam(ctx, p.config, p.builds, s.opts);
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('uploaded');
    expect(r.details).toMatchObject({ appId: 1234560, user: 'builder', buildId: 12345678, branch: null });
    expect(r.details!.depots).toEqual([
      { target: 'windows', depotId: 1234561 },
      { target: 'mac', depotId: 1234562 },
      { target: 'linux', depotId: 1234563 },
    ]);
    const [build] = jsonl(path.join(s.state, 'builds.jsonl'));
    expect(build).toMatchObject({ appId: 1234560, preview: false, setLive: null });
    expect(build.depots[0].files).toEqual(['LICENSE', 'Moon Game.exe', 'resources/app.asar']);
    expect(build.depots[2].files).toEqual(['LICENSE', 'moon-game', 'my_steam_appid.txt', 'resources/app.asar']);
    const [run] = jsonl(path.join(s.state, 'runs.jsonl'));
    expect(run.args.slice(0, 7)).toEqual(['+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1', '+login', 'builder', '+run_app_build']);
    if (process.platform !== 'win32') expect(run.home).toBe(steamCmdPaths(ctx.cacheDir, process.platform).homeDir);
    // On a Mac it finds Gameshipper's stand-in launchctl, never the real one.
    if (process.platform === 'darwin') expect(run.launchctl).toBe(path.join(steamCmdPaths(ctx.cacheDir, 'darwin').shimDir, 'launchctl'));
    expect(fs.readFileSync(ctx.logPath, 'utf8')).toContain('steamcmd: [2026-09-29 10:00:00]: Successfully finished AppID 1234560 build (BuildID 12345678).');
  });

  it('STEAM_LOGIN_REQUIRED without a saved login when nobody is at a terminal, and never prompts', async () => {
    const p = steamProject();
    const s = setup({}, 'ok', false);
    const r = await publishSteam(testCtx(p.dir), p.config, p.builds, s.opts);
    expect([r.status, r.errors[0].code]).toEqual(['failed', 'STEAM_LOGIN_REQUIRED']);
    expect(r.errors[0].message).toContain('Cached credentials not found');
    expect(r.errors[0].fix).toContain('`npx gameshipper publish --to steam --dry-run --steam-user builder`');
    expect([s.handOffs, s.notices]).toEqual([[], []]);
  });

  it('hands the terminal to SteamCMD to log in, then uploads', async () => {
    const p = steamProject();
    const s = setup({ interactive: true }, 'ok', false);
    const ctx = testCtx(p.dir);
    const r = await publishSteam(ctx, p.config, p.builds, s.opts);
    expect(s.handOffs).toEqual([['+@ShutdownOnFailedCommand', '1', '+login', 'builder', '+quit']]);
    expect(s.notices).toEqual([expect.stringContaining('Gameshipper never sees them')]);
    expect([r.status, r.details?.buildId]).toEqual(['uploaded', 12345678]);
    // The login in the terminal gets the stand-in launchctl too, like every other run.
    const runs = jsonl(path.join(s.state, 'runs.jsonl'));
    expect(runs).toHaveLength(3);
    if (process.platform === 'darwin') {
      for (const run of runs) expect(run.launchctl).toBe(path.join(steamCmdPaths(ctx.cacheDir, 'darwin').shimDir, 'launchctl'));
    }
  });

  it('STEAM_LOGIN_FAILED when the login in the terminal is refused', async () => {
    const p = steamProject();
    const r = await publishSteam(testCtx(p.dir), p.config, p.builds, setup({ interactive: true }, 'refuse-login', false).opts);
    expect(r.errors[0].code).toBe('STEAM_LOGIN_FAILED');
  });

  it('--dry-run runs a preview build', async () => {
    const p = steamProject();
    const r = await publishSteam(testCtx(p.dir), p.config, p.builds, setup({ dryRun: true }).opts);
    expect([r.status, r.details?.buildId]).toEqual(['previewed', null]);
    expect(fs.readFileSync(r.details!.appBuildScript, 'utf8')).toContain('"Preview" "1"');
  });

  it('--branch sets the build live on a beta branch', async () => {
    const p = steamProject();
    const s = setup({ branch: 'beta' });
    const r = await publishSteam(testCtx(p.dir), p.config, p.builds, s.opts);
    expect([r.status, r.details?.branch]).toEqual(['uploaded', 'beta']);
    expect(jsonl(path.join(s.state, 'builds.jsonl'))[0].setLive).toBe('beta');
  });

  it('STEAM_SET_LIVE_FAILED keeps the uploaded BuildID', async () => {
    const p = steamProject();
    const r = await publishSteam(testCtx(p.dir), p.config, p.builds, setup({ branch: 'beta' }, 'set-live-fails').opts);
    expect([r.status, r.details?.buildId, r.details?.branch, r.errors[0].code]).toEqual(['uploaded', 12345678, null, 'STEAM_SET_LIVE_FAILED']);
    expect(r.errors[0].fix).toContain('https://partner.steamgames.com/apps/builds/1234560');
  });

  it('refuses the default branch, and names that are not branches, before running SteamCMD', async () => {
    const p = steamProject();
    const s = setup({ branch: 'Default' });
    expect((await publishSteam(testCtx(p.dir), p.config, p.builds, s.opts)).errors[0].code).toBe('STEAM_DEFAULT_BRANCH');
    expect((await publishSteam(testCtx(p.dir), p.config, p.builds, { ...s.opts, branch: 'my beta' })).errors[0].code).toBe('USAGE');
    expect(fs.existsSync(path.join(s.state, 'runs.jsonl'))).toBe(false);
  });

  it('needs your own App ID and the account that uploads', async () => {
    const test = fakeProject();
    expect((await publishSteam(testCtx(test.dir), test.config, test.builds, setup().opts)).errors[0].code).toBe('STEAM_TEST_APP');
    const p = steamProject();
    const noUser = await publishSteam(testCtx(p.dir), p.config, p.builds, setup({ steamUser: null }).opts);
    expect([noUser.errors[0].code, noUser.errors[0].fix]).toEqual(['INPUT_REQUIRED', expect.stringContaining('--steam-user')]);
    expect((await publishSteam(testCtx(p.dir), p.config, p.builds, setup({ steamUser: 'a b' }).opts)).errors[0].code).toBe('USAGE');
  });

  it('uses steam.user from gameshipper.json when no flag is given', async () => {
    const p = fakeProject({ steam: { appId: 1234560, user: 'builder' } });
    expect((await publishSteam(testCtx(p.dir), p.config, p.builds, setup({ steamUser: null }).opts)).details?.user).toBe('builder');
  });

  it("STEAM_UPLOAD_FAILED carries SteamCMD's reasons; Access Denied points at the account's permissions and the depots", async () => {
    const p = steamProject();
    const ctx = testCtx(p.dir);
    const r = await publishSteam(ctx, p.config, p.builds, setup({}, 'access-denied').opts);
    expect(r.errors[0].code).toBe('STEAM_UPLOAD_FAILED');
    expect(r.errors[0].message).toContain('Failed to initialize build on server (Access Denied)');
    expect(r.errors[0].fix).toContain('"Access Denied" means builder can\'t upload builds for app 1234560');
    expect(r.errors[0].fix).toContain('depot IDs');
    expect(r.errors[0].fix).toContain(ctx.logPath);
  });

  it('STEAM_UPLOAD_FAILED for anything else points at the run log, not at permissions', async () => {
    const p = steamProject();
    const ctx = testCtx(p.dir);
    const r = await publishSteam(ctx, p.config, p.builds, setup({}, 'no-connection').opts);
    expect([r.errors[0].code, r.errors[0].message]).toEqual(['STEAM_UPLOAD_FAILED', 'The SteamCMD upload failed: Steam login: No Connection']);
    expect(r.errors[0].fix).not.toMatch(/Access Denied|depot/);
    expect(r.errors[0].fix).toContain(ctx.logPath);
  });

  it.skipIf(process.platform === 'win32')("STEAM_PATH_UNSUPPORTED for a project folder SteamCMD can't read, before SteamCMD runs", async () => {
    for (const name of ['Moon "Game"', 'Moon\\Game']) {
      const p = steamProject();
      const dir = path.join(makeTmpDir(), name);
      fs.cpSync(p.dir, dir, { recursive: true, verbatimSymlinks: true });
      const s = setup();
      const r = await publishSteam(testCtx(dir), p.config, findDesktopBuilds(dir, p.config).builds, s.opts);
      expect([r.status, r.errors[0].code], name).toEqual(['failed', 'STEAM_PATH_UNSUPPORTED']);
      expect(r.errors[0].message).toContain(path.join(dir, 'out'));
      expect(r.errors[0].fix).toBe('Move or rename the project folder so its path has no quotes (or backslashes on macOS/Linux), then publish again.');
      expect(fs.existsSync(path.join(s.state, 'runs.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.gameshipper', 'steam'))).toBe(false);
    }
  });

  it('STEAMCMD_CANT_RUN when this computer cannot run SteamCMD', async () => {
    const p = steamProject();
    const r = await publishSteam(testCtx(p.dir), p.config, p.builds, setup({ platform: 'darwin' }, 'bad-cpu').opts);
    expect(r.errors[0].code).toBe('STEAMCMD_CANT_RUN');
    expect(r.errors[0].fix).toContain('softwareupdate --install-rosetta');
  });

  it('never waits at a password prompt', async () => {
    const p = steamProject();
    const started = Date.now();
    const r = await publishSteam(testCtx(p.dir), p.config, p.builds, setup({}, 'prompt', false).opts);
    expect(r.errors[0].code).toBe('STEAM_LOGIN_REQUIRED');
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
