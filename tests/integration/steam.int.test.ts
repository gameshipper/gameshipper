import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles } from '../../src/core/fsutil.js';
import { runSmoke } from '../../src/core/smoke.js';
import type { DiagEvent } from '../../src/shell/diagnostics.js';
import { cli, ROOT } from '../helpers/built-cli.js';
import { testCtx } from '../helpers/ctx.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

// The first test runs everywhere. The others are opt-in (GAMESHIPPER_STEAM_E2E=1): they need macOS, a running,
// signed-in Steam client, network access, and a Steamworks SDK zip (GAMESHIPPER_STEAM_E2E_SDK, or the newest in
// the repo's .sdk/ folder). They unlock and then clear Spacewar's ACH_WIN_ONE_GAME on the signed-in account.
const ENABLED = process.env.GAMESHIPPER_STEAM_E2E === '1' && process.platform === 'darwin';
const OVERLAY_DYLIB = path.join(os.homedir(), 'Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/gameoverlayrenderer.dylib');

function sdkZip(): string {
  const fromEnv = process.env.GAMESHIPPER_STEAM_E2E_SDK;
  if (fromEnv) return fromEnv;
  const folder = path.join(ROOT, '.sdk');
  const zips = fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => /^steamworks_sdk.*\.zip$/i.test(n)).sort() : [];
  if (!zips.length) throw new Error('No Steamworks SDK zip: set GAMESHIPPER_STEAM_E2E_SDK or put one in .sdk/.');
  return path.join(folder, zips[zips.length - 1]);
}

/** On a locked screen nothing is drawn, so Steam's overlay can't hook a game. macOS reports the lock through ioreg. */
function screenLocked(): boolean {
  return /"CGSSessionScreenIsLocked"=Yes/.test(spawnSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' }).stdout ?? '');
}

/** The "steam-e2e:<step>:<json>" lines the fixture game logs, as { step: value }. */
function gameReport(events: DiagEvent[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of events) {
    const m = e.kind === 'console' ? /^steam-e2e:(\w+):(.*)$/.exec(e.message) : null;
    if (m) out[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

const EXPECTED_REPORT = {
  available: true,
  user: true,
  language: expect.any(String),
  deck: false,
  unlock: true,
  unlocked: true,
  clear: true,
  cleared: true,
  achievements: expect.any(Number),
  presence: true,
  stat: 'number',
  save: { level: 2 },
  plugin: 'HI',
  done: true,
};

const steamEvent = (events: DiagEvent[]) => events.find((e) => e.kind === 'steam');
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

/** The fixture in a fresh folder, with the plugin switched on and, unless `withSdk` is false, the SDK zip in .sdk/. */
function newProject(env: NodeJS.ProcessEnv, withSdk = true): string {
  const dir = makeTmpDir('gs-steam-e2e-');
  fs.cpSync(path.join(ROOT, 'fixtures', 'steam-achievements'), dir, { recursive: true });
  writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
  if (withSdk) {
    const zip = sdkZip();
    fs.mkdirSync(path.join(dir, '.sdk'));
    fs.copyFileSync(zip, path.join(dir, '.sdk', path.basename(zip)));
  }
  expect(cli(['init', '--yes', '--name', 'Steam Test'], dir, env).code).toBe(0);
  const configFile = path.join(dir, 'gameshipper.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.plugins = ['plugins/echo.mjs'];
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return dir;
}

describe('the Steam fixture without an SDK', () => {
  it('runs cleanly with window.steam a harmless no-op while saves and plugins work', () => {
    const env = { GAMESHIPPER_CACHE: makeTmpDir('gs-empty-cache-') };
    const dir = newProject(env, false);
    const play = cli(['play', '--smoke', '--seconds', '3'], dir, env);
    expect(play.result.errors).toEqual([]);
    expect(codes(play.result.warnings)).toEqual(['STEAM_SDK_MISSING']);
    const events: DiagEvent[] = play.result.data.smoke.summary.events;
    expect(steamEvent(events)).toMatchObject({ state: 'no-sdk', overlay: 'none' });
    expect(gameReport(events)).toEqual({
      available: false,
      user: false,
      language: null,
      deck: false,
      unlock: false,
      unlocked: false,
      clear: false,
      cleared: true,
      achievements: 0,
      presence: false,
      stat: 'object',
      save: { level: 2 },
      plugin: 'HI',
      done: true,
    });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe.skipIf(!ENABLED)('Steam on this Mac with App ID 480', () => {
  // A fresh cache, so SDK extraction and the Intel Mac koffi download really happen.
  const env = { GAMESHIPPER_CACHE: makeTmpDir('gs-steam-cache-') };

  it('play --smoke, the packaged app, and the injected overlay all work', async () => {
    const dir = newProject(env);

    const status = cli(['status'], dir, env);
    expect(status.result.data.steamSdk).toMatchObject({ source: 'project', version: expect.stringMatching(/^1\.\d+$/), targets: ['windows', 'mac', 'linux'] });
    expect(status.result.warnings).toEqual([]);

    const play = cli(['play', '--smoke', '--seconds', '8'], dir, env);
    expect(play.result.errors).toEqual([]);
    expect(play.result.warnings.filter((w: { code: string }) => w.code.startsWith('STEAM_'))).toEqual([]);
    const devEvents: DiagEvent[] = play.result.data.smoke.summary.events;
    expect(steamEvent(devEvents)).toMatchObject({ state: 'ready', appId: 480, overlay: 'none' });
    expect(gameReport(devEvents)).toEqual(EXPECTED_REPORT);
    const version = status.result.data.steamSdk.version;
    expect(fs.existsSync(path.join(env.GAMESHIPPER_CACHE, 'steamworks-sdk', version, 'redistributable_bin', 'osx', 'libsteam_api.dylib'))).toBe(true);

    const build = cli(['build', '--target', 'mac'], dir, env);
    expect(build.result.errors).toEqual([]);
    expect(fs.readFileSync(path.join(dir, '.gameshipper', 'before-package.txt'), 'utf8')).toBe('mac');
    expect(fs.readFileSync(path.join(dir, '.gameshipper', 'after-package.txt'), 'utf8')).toBe('mac\n');
    const mac = build.result.data.targets.find((t: { target: string }) => t.target === 'mac').output;
    const unpacked = path.join(mac.dir, 'Steam Test.app', 'Contents', 'Resources', 'app.asar.unpacked');
    const files = listFiles(unpacked);
    expect(files).toEqual(
      expect.arrayContaining([
        'steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib',
        'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
        'node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node',
        'node_modules/steamworks-ffi-node/prebuilds/darwin-arm64/steam-overlay.node',
        'node_modules/steamworks-ffi-node/prebuilds/darwin-x64/steam-overlay.node',
      ]),
    );
    expect(files.filter((f) => /win64|linux64|win32|linux-x64|linux_x64/.test(f))).toEqual([]);
    expect(listFiles(mac.dir).filter((f) => f.endsWith('steam_appid.txt'))).toEqual([]);

    const smoke = (extraEnv: NodeJS.ProcessEnv) =>
      runSmoke(testCtx(dir), { command: mac.executable, args: [], seconds: 8, userDataDir: path.join(dir, '.gameshipper', 'int-data'), windowed: true, env: extraEnv });
    const packaged = await smoke({});
    expect(packaged.errors).toEqual([]);
    expect(packaged.data!.exitCode).toBe(0);
    expect(steamEvent(packaged.data!.summary.events)).toMatchObject({ state: 'ready', overlay: 'none' });
    expect(gameReport(packaged.data!.summary.events)).toEqual(EXPECTED_REPORT);

    // Launched by Steam, a game gets Steam's overlay renderer injected; this emulates that.
    if (fs.existsSync(OVERLAY_DYLIB)) {
      const injected = await smoke({ DYLD_INSERT_LIBRARIES: OVERLAY_DYLIB, SteamAppId: '480', SteamGameId: '480', SteamOverlayGameId: '480' });
      expect(injected.errors).toEqual([]);
      expect(injected.data!.exitCode).toBe(0);
      const events = injected.data!.summary.events;
      expect(steamEvent(events)).toMatchObject({ state: 'ready', overlay: 'native' });
      if (screenLocked()) console.warn("The screen is locked, so Steam's overlay can't hook the game: whether it did wasn't checked.");
      else expect(events).toContainEqual({ kind: 'steam-overlay', enabled: true });
    } else {
      console.warn(`Skipped the injected-overlay run: ${OVERLAY_DYLIB} doesn't exist.`);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('cross-builds Windows and Linux with only their own Steam files', () => {
    const dir = newProject(env);
    const build = cli(['build', '--target', 'windows,linux'], dir, env);
    expect(build.result.errors).toEqual([]);
    const own = {
      windows: ['steamworks_sdk/redistributable_bin/win64/steam_api64.dll', 'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node', 'node_modules/steamworks-ffi-node/prebuilds/win32-x64/steam-overlay.node'],
      linux: ['steamworks_sdk/redistributable_bin/linux64/libsteam_api.so', 'node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node', 'node_modules/steamworks-ffi-node/prebuilds/linux-x64/steam-overlay.node'],
    };
    for (const [target, expected] of Object.entries(own)) {
      const files = listFiles(path.join(dir, 'out', target, 'resources', 'app.asar.unpacked'));
      expect(files).toEqual(expect.arrayContaining(expected));
      const other = target === 'windows' ? /osx|linux64|darwin|linux/ : /osx|win64|darwin|win32/;
      expect(files.filter((f) => other.test(f)), target).toEqual([]);
      expect(listFiles(path.join(dir, 'out', target)).filter((f) => f.endsWith('steam_appid.txt'))).toEqual([]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
