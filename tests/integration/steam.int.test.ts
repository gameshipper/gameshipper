import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listFiles } from '../../src/core/fsutil.js';
import { runSmoke } from '../../src/core/smoke.js';
import type { DiagEvent } from '../../src/shell/diagnostics.js';
import { cli, ROOT } from '../helpers/built-cli.js';
import { testCtx } from '../helpers/ctx.js';
import { makeSolidPng } from '../helpers/png.js';
import { screenLock, type ScreenLock } from '../helpers/screen.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

// The first two describe blocks run everywhere. The last is opt-in (GAMESHIPPER_STEAM_E2E=1): it needs macOS, a
// running, signed-in Steam client, network access, and a Steamworks SDK zip (GAMESHIPPER_STEAM_E2E_SDK, or the newest
// in the repo's .sdk/ folder). On the signed-in account it unlocks and then clears Spacewar's ACH_WIN_ONE_GAME, and
// writes Spacewar's NumGames stat back with its current value (no net change). Run it with --reporter=verbose:
//   GAMESHIPPER_STEAM_E2E=1 GAMESHIPPER_STEAM_E2E_SDK=<zip> npm run test:integration -- tests/integration/steam.int.test.ts --reporter=verbose
// Whether Steam's overlay hooks the game can only be checked on an unlocked screen; that test is skipped otherwise.
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
  // NumGames written back with its own value (it only ever goes up, so the test never changes it).
  statRoundTrip: { set: true, stored: true, readBack: true },
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
      statRoundTrip: null,
      save: { level: 2 },
      plugin: 'HI',
      done: true,
    });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('a game with globals of its own named steam and gameshipper', () => {
  it('still runs: its own declarations take the place of Gameshipper\'s', () => {
    const env = { GAMESHIPPER_CACHE: makeTmpDir('gs-empty-cache-') };
    const dir = makeTmpDir('gs-own-globals-');
    writeFiles(dir, {
      'icon.png': makeSolidPng(1024, 1024),
      'index.html': '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Own globals</title></head><body><script src="own.js"></script><script src="check.js"></script></body></html>',
      // Classic scripts: their top-level declarations are globals, which window.steam and window.gameshipper must not block.
      'own.js': 'const steam = { own: true };\nvar gameshipper = { own: true };\n',
      'check.js': [
        "console.log('own-globals:' + JSON.stringify({ steam: steam.own === true, gameshipper: gameshipper.own === true && window.gameshipper.own === true, bridge: typeof window.steam.isAvailable === 'function' }));",
        "window.steam = 'replaced';",
        "console.log('own-globals-assigned:' + JSON.stringify(window.steam === 'replaced'));",
      ].join('\n'),
    });
    expect(cli(['init', '--yes', '--name', 'Own Globals'], dir, env).code).toBe(0);
    const play = cli(['play', '--smoke', '--seconds', '2'], dir, env);
    expect(play.result.errors).toEqual([]);
    const messages = (play.result.data.smoke.summary.events as DiagEvent[]).flatMap((e) => (e.kind === 'console' ? [e.message] : []));
    expect(messages).toEqual(
      expect.arrayContaining(['own-globals:{"steam":true,"gameshipper":true,"bridge":true}', 'own-globals-assigned:true']),
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe.skipIf(!ENABLED)('Steam on this Mac with App ID 480', () => {
  // A fresh cache, so SDK extraction and the Intel Mac koffi download really happen.
  const env = { GAMESHIPPER_CACHE: makeTmpDir('gs-steam-cache-') };
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  /** Set by the first test: the project and its packaged Mac app. */
  let project: { dir: string; executable: string } | undefined;
  /** Set by the injected-overlay run: its events, and the screen lock read before and after it. */
  let injected: { events: DiagEvent[]; lock: Array<{ state: ScreenLock; raw: string }> } | undefined;

  const report = (events: DiagEvent[]) => {
    const r = gameReport(events);
    expect(r).toEqual(EXPECTED_REPORT);
    expect(r.achievements).toBeGreaterThan(0);
  };
  const smoke = (extraEnv: NodeJS.ProcessEnv) => {
    const { dir, executable } = project!;
    return runSmoke(testCtx(dir), { command: executable, args: [], seconds: 8, userDataDir: path.join(dir, '.gameshipper', 'int-data'), windowed: true, env: extraEnv });
  };

  it('status, play --smoke, the Mac build and the packaged app all use Steam', async () => {
    const dir = newProject(env);
    dirs.push(dir);

    const status = cli(['status'], dir, env);
    expect(status.result.data.steamSdk).toMatchObject({ source: 'project', version: expect.stringMatching(/^1\.\d+[a-z]?$/), targets: ['windows', 'mac', 'linux'] });
    expect(status.result.warnings).toEqual([]);

    const play = cli(['play', '--smoke', '--seconds', '8'], dir, env);
    expect(play.result.errors).toEqual([]);
    expect(play.code).toBe(0);
    expect(play.result.data.smoke.exitCode).toBe(0);
    expect(play.result.warnings.filter((w: { code: string }) => w.code.startsWith('STEAM_'))).toEqual([]);
    const devEvents: DiagEvent[] = play.result.data.smoke.summary.events;
    expect(steamEvent(devEvents)).toMatchObject({ state: 'ready', appId: 480, overlay: 'none' });
    report(devEvents);
    // Extracted once into <cache>/steamworks-sdk/<version>-<start of the zip's SHA-256>.
    const version = status.result.data.steamSdk.version;
    const cached = fs.readdirSync(path.join(env.GAMESHIPPER_CACHE, 'steamworks-sdk')).filter((n) => !n.startsWith('.'));
    expect(cached).toEqual([expect.stringMatching(new RegExp(`^${version.replace('.', '\\.')}-[0-9a-f]{8}$`))]);
    expect(fs.existsSync(path.join(env.GAMESHIPPER_CACHE, 'steamworks-sdk', cached[0], 'redistributable_bin', 'osx', 'libsteam_api.dylib'))).toBe(true);

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
    project = { dir, executable: mac.executable };

    const packaged = await smoke({});
    expect(packaged.errors).toEqual([]);
    expect(packaged.data!.exitCode).toBe(0);
    expect(steamEvent(packaged.data!.summary.events)).toMatchObject({ state: 'ready', overlay: 'none' });
    report(packaged.data!.summary.events);
  });

  it('the packaged app starts its native overlay window when Steam injects its overlay renderer', async (ctx) => {
    if (!fs.existsSync(OVERLAY_DYLIB)) ctx.skip(`Steam's overlay renderer isn't installed (${OVERLAY_DYLIB} doesn't exist)`);
    expect(project, 'the packaged app from the previous test').toBeDefined();
    // Launched by Steam, a game gets Steam's overlay renderer injected; this emulates that.
    const before = screenLock();
    const run = await smoke({ DYLD_INSERT_LIBRARIES: OVERLAY_DYLIB, SteamAppId: '480', SteamGameId: '480', SteamOverlayGameId: '480' });
    const after = screenLock();
    injected = { events: run.data?.summary.events ?? [], lock: [before, after] };
    await ctx.annotate(`screen during the injected run: ${before.state} (${before.raw}) → ${after.state} (${after.raw})`);
    expect(run.errors).toEqual([]);
    expect(run.warnings.filter((w) => w.code === 'STEAM_OVERLAY_FAILED')).toEqual([]);
    expect(run.data!.exitCode).toBe(0);
    expect(steamEvent(injected.events)).toMatchObject({ state: 'ready', overlay: 'native' });
    report(injected.events);
  });

  it("Steam's overlay hooks the injected game (needs an unlocked screen)", (ctx) => {
    if (!fs.existsSync(OVERLAY_DYLIB)) ctx.skip(`Steam's overlay renderer isn't installed (${OVERLAY_DYLIB} doesn't exist)`);
    expect(injected, 'the injected run from the previous test').toBeDefined();
    const notUnlocked = injected!.lock.find((l) => l.state !== 'unlocked');
    if (notUnlocked) ctx.skip(`the screen was ${notUnlocked.state} during the injected run (${notUnlocked.raw}), so Steam's overlay couldn't hook the game`);
    expect(injected!.events).toContainEqual({ kind: 'steam-overlay', enabled: true });
  });

  it('cross-builds Windows and Linux with only their own Steam files', () => {
    const dir = newProject(env);
    dirs.push(dir);
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
  });
});
