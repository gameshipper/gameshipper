import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheRoot } from '../../src/core/cache.js';
import { parseConfig } from '../../src/core/config/load.js';
import { createCtx } from '../../src/core/context.js';
import { butlerResult, ensureButler, parseButlerJson } from '../../src/core/publish/itch/butler.js';
import { checkButlerLogin } from '../../src/core/publish/itch/publish.js';
import { judgeSteamRun } from '../../src/core/publish/steam/judge.js';
import { ensureSteamCmd, STEAMCMD_ARCHIVES, steamCmdPaths } from '../../src/core/publish/steam/steamcmd.js';
import { writeSteamScripts } from '../../src/core/publish/steam/vdf.js';
import { isInstalled } from '../../src/core/tools/download.js';
import { runExternal } from '../../src/core/tools/run.js';
import { cli } from '../helpers/built-cli.js';
import { fakeProject } from '../helpers/fake-builds.js';
import { refusedUrl } from '../helpers/server.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

/**
 * The real SteamCMD and butler, downloaded from Valve and itch.io into the integration cache (GAMESHIPPER_CACHE in
 * vitest.int.config.ts), which is kept between runs, so SteamCMD's ~80 MB first-run update happens once. Nothing here
 * logs in to an account: SteamCMD only logs in anonymously, or stops at "no saved login"; butler runs only commands
 * that need no login, with a HOME of its own so it never sees the owner's itch.io login.
 */
const CACHE = cacheRoot();
const ctx = () => createCtx(makeTmpDir('gs-int-'), 'int', { cacheDir: CACHE });
const steamHost = ['darwin', 'win32'].includes(process.platform) || (process.platform === 'linux' && process.arch === 'x64');
/** The owner's Steam client files that SteamCMD would write to with the real HOME. */
const USER_STEAM = [
  path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.valvesoftware.steamclean.plist'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Steam', 'config', 'config.vdf'),
];
const fingerprint = (file: string) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
/** An environment for butler with no login: a HOME of its own and no API key. */
function butlerEnv(): NodeJS.ProcessEnv {
  const home = makeTmpDir('gs-butler-home-');
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), BUTLER_API_KEY: '', GAMESHIPPER_BUTLER: '' };
}

describe.skipIf(!steamHost)('the real SteamCMD', () => {
  it("downloads, checks and logs in anonymously in a HOME of its own, leaving the owner's Steam client alone", async () => {
    const before = USER_STEAM.map(fingerprint);
    const c = ctx();
    const tool = await ensureSteamCmd(c, { env: process.env });
    const r = await runExternal(tool, ['+@ShutdownOnFailedCommand', '1', '+login', 'anonymous', '+quit'], { timeoutMs: 15 * 60_000, onLine: c.log });
    expect(r.output).toContain('Connecting anonymously to Steam Public...OK');
    expect(r.output).toContain('Waiting for user info...OK');
    expect(r.exitCode).toBe(0);
    if (process.platform === 'darwin') {
      const home = steamCmdPaths(CACHE, 'darwin').homeDir;
      expect(fs.existsSync(path.join(home, 'Library', 'Application Support', 'Steam', 'config', 'config.vdf'))).toBe(true);
      // SteamCMD writes this LaunchAgent into $HOME: it must be ours, not the owner's.
      expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.valvesoftware.steamclean.plist'))).toBe(true);
    }
    expect(USER_STEAM.map(fingerprint)).toEqual(before);
    // SteamCMD updated itself in its folder, and kept Gameshipper's record of the archive: it isn't downloaded again.
    const paths = steamCmdPaths(CACHE, process.platform);
    expect(isInstalled(paths.installDir, STEAMCMD_ARCHIVES[process.platform]!, paths.program)).toBe(true);
  });

  it('refuses an anonymous preview build, and Gameshipper reads the refusal and leaves every steam_appid.txt out', async () => {
    const c = ctx();
    const tool = await ensureSteamCmd(c, { env: process.env });
    const config = parseConfig({ name: 'Probe', version: '0.0.1', steam: { appId: 480 } }).data!;
    const dir = path.join(c.projectDir, 'out', 'linux');
    writeFiles(dir, { probe: 'x', 'steam_appid.txt': '480', 'resources/deep/steam_appid.txt': '480' });
    const scripts = writeSteamScripts(c.projectDir, config, [{ target: 'linux', dir, executable: path.join(dir, 'probe') }], { preview: true, setLive: null });
    const args = ['+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1', '+login', 'anonymous', '+run_app_build', scripts.appBuild, '+quit'];
    const r = await runExternal(tool, args, { timeoutMs: 10 * 60_000, onLine: c.log });
    const log = path.join(scripts.outputDir, 'app_build_480.log');
    const output = `${r.output}\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''}`;
    const outcome = judgeSteamRun({ appId: 480, preview: true, exitCode: r.exitCode, timedOut: r.timedOut, spawnError: r.spawnError, output });
    expect(outcome, output).toMatchObject({ kind: 'failed', reasons: expect.arrayContaining([expect.stringContaining('Access Denied')]) });
    // probe, resources/ and resources/deep/ (SteamCMD counts folders too): both steam_appid.txt files are left out.
    expect(fs.readFileSync(path.join(scripts.outputDir, 'depot_build_483.log'), 'utf8')).toContain('Found 3 files (0 MB) for depot 483');
  });

  it('`publish` without a saved login is STEAM_LOGIN_REQUIRED, and asks Steam nothing about the account', () => {
    const p = fakeProject({ steam: { appId: 1234560 } });
    const r = cli(['publish', '--to', 'steam', '--dry-run', '--steam-user', 'gameshipper_probe_nobody'], p.dir, { GAMESHIPPER_STEAMCMD: '' });
    expect(r.code).toBe(2);
    expect(r.result.errors[0]).toMatchObject({ code: 'STEAM_LOGIN_REQUIRED', message: expect.stringContaining('Cached credentials not found') });
    expect(fs.readFileSync(r.result.logPath, 'utf8')).toContain('steamcmd: FAILED (No cached credentials and @NoPromptForPassword is set)');
  });
});

describe('the real butler', () => {
  it('downloads the pinned version and reports it', async () => {
    const tool = await ensureButler(ctx(), { env: butlerEnv() });
    const r = await runExternal(tool, ['--json', 'version'], { timeoutMs: 60_000 });
    expect(butlerResult(parseButlerJson(r.output))).toMatchObject({ version: 'v15.31.0' });
  });

  it('a dry-run push needs no login, and checking the login never prompts', async () => {
    const c = ctx();
    const tool = await ensureButler(c, { env: butlerEnv() });
    const dir = makeTmpDir();
    writeFiles(dir, { 'game.txt': 'x' });
    const push = await runExternal(tool, ['--json', 'push', '--dry-run', dir, 'gameshipper/probe:linux', '--userversion', '0.0.1'], { timeoutMs: 60_000 });
    expect(butlerResult(parseButlerJson(push.output))).toMatchObject({ dryRun: true, channel: 'linux' });
    expect(await checkButlerLogin(c, tool)).toEqual({ ok: false, reason: 'No credentials and stdin is not a terminal - terminating.', unreachable: false });
  });

  it("tells itch.io being unreachable from a refused login, and never sends the key anywhere", async () => {
    const c = ctx();
    // Every request goes through a proxy that refuses connections, so the made-up key never leaves this computer.
    const proxy = await refusedUrl();
    const env = { ...butlerEnv(), BUTLER_API_KEY: 'not-a-real-key', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '', no_proxy: '' };
    const login = await checkButlerLogin(c, await ensureButler(c, { env }));
    expect(login).toMatchObject({ ok: false, unreachable: true, reason: expect.stringContaining('proxyconnect tcp: dial tcp') });
  });

  it('`publish --to itch --dry-run` without a login previews the pushes and warns', () => {
    const p = fakeProject({ itch: { project: 'gameshipper/probe' } });
    const r = cli(['publish', '--to', 'itch', '--dry-run'], p.dir, butlerEnv());
    expect(r.code).toBe(0);
    expect(r.result.data.destinations[0].status).toBe('previewed');
    expect(r.result.warnings.map((w: { code: string }) => w.code)).toEqual(['ITCH_UPLOADS_LIVE', 'ITCH_LOGIN_REQUIRED']);
  });
});
