import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linuxLauncherScript } from '../../src/core/desktop/linux-launcher.js';
import { runSmoke } from '../../src/core/smoke.js';
import { readZipEntries } from '../../src/core/steam/zip.js';
import { cli, cliAsync, ROOT } from '../helpers/built-cli.js';
import { testCtx } from '../helpers/ctx.js';
import { FAKE_BUTLER, FAKE_STEAMCMD } from '../helpers/fake-builds.js';
import { startFakeGithub, type FakeGithub } from '../helpers/fake-github.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const REPO = 'moonstudio/spinning-cube';
const TARGETS = process.platform === 'win32' ? ['windows', 'linux'] : ['windows', 'mac', 'linux'];

let gh: FakeGithub;
let dir: string;

/** Every tool faked, with a saved Steam login and a butler login. */
function fakeEnv(): NodeJS.ProcessEnv {
  const steamState = makeTmpDir('gs-e2e-steamcmd-');
  const butlerState = makeTmpDir('gs-e2e-butler-');
  fs.writeFileSync(path.join(steamState, 'login-builder'), 'token');
  fs.writeFileSync(path.join(butlerState, 'creds'), 'key');
  return {
    GAMESHIPPER_STEAMCMD: FAKE_STEAMCMD,
    FAKE_STEAMCMD_STATE: steamState,
    GAMESHIPPER_BUTLER: FAKE_BUTLER,
    FAKE_BUTLER_STATE: butlerState,
    BUTLER_API_KEY: '',
    GAMESHIPPER_GITHUB_API: gh.base,
    GITHUB_TOKEN: 'test-token',
    GH_TOKEN: '',
  };
}

beforeAll(async () => {
  gh = await startFakeGithub(REPO);
  dir = makeTmpDir('gs-e2e-publish-');
  fs.cpSync(path.join(ROOT, 'fixtures', 'threejs-cdn'), dir, { recursive: true });
  writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
  expect(cli(['init', '--yes', '--name', 'Spinning Cube'], dir).code).toBe(0);
  const file = path.join(dir, 'gameshipper.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.steam = { ...config.steam, appId: 1234560, user: 'builder' };
  config.itch = { project: REPO };
  config.github = { repo: REPO };
  config.targets = TARGETS;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  const build = cli(['build'], dir);
  expect(build.result.errors).toEqual([]);
});

afterAll(async () => {
  await gh?.close();
});

describe('publish end to end: real builds, fake SteamCMD, butler and GitHub', () => {
  it('--dry-run previews every destination and uploads nothing', async () => {
    const r = await cliAsync(['publish', '--dry-run'], dir, fakeEnv());
    expect(r.result.errors).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.result.data.destinations.map((d: { to: string; status: string }) => `${d.to}:${d.status}`)).toEqual(['steam:previewed', 'itch:previewed', 'github:previewed']);
    expect(gh.releases).toEqual([]);
  });

  it('uploads everywhere, and the Mac release zip is the signed app, still signed', async () => {
    const env = fakeEnv();
    const r = await cliAsync(['publish'], dir, env);
    expect(r.result.errors).toEqual([]);
    expect(r.code).toBe(0);
    const [steam, itch, github] = r.result.data.destinations;

    expect(steam.details.buildId).toBe(12345678);
    const [build] = fs.readFileSync(path.join(env.FAKE_STEAMCMD_STATE!, 'builds.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const windowsDepot = build.depots.find((d: { depotId: number }) => d.depotId === 1234561);
    expect(windowsDepot.files).toContain('Spinning Cube.exe');
    expect(build.depots.flatMap((d: { files: string[] }) => d.files).some((f: string) => f.endsWith('steam_appid.txt'))).toBe(false);
    // The Linux depot has the launcher the launch option names, and the Electron binary it starts.
    const linuxDepot = build.depots.find((d: { root: string }) => path.basename(d.root) === 'linux');
    expect(linuxDepot.files).toEqual(expect.arrayContaining(['spinning-cube', 'spinning-cube-bin']));
    expect(steam.details.dashboard.launchOptions).toContainEqual({ os: 'Linux + SteamOS', executable: 'spinning-cube' });
    // Every launch option names a file that's in the depot.
    for (const option of steam.details.dashboard.launchOptions as Array<{ os: string; executable: string }>) {
      const target = ({ Windows: 'windows', macOS: 'mac', 'Linux + SteamOS': 'linux' } as Record<string, string>)[option.os];
      expect(fs.existsSync(path.join(dir, 'out', target, option.executable)), option.executable).toBe(true);
    }

    expect(itch.details.channels.every((c: { buildId: number }) => c.buildId >= 1000)).toBe(true);
    expect(github.details).toMatchObject({ tag: 'v1.0.0', draft: true });
    expect(gh.releases[0].assets.map((a) => a.name).sort()).toEqual(TARGETS.map((t) => `spinning-cube-1.0.0-${t}.zip`).sort());

    if (process.platform === 'darwin') {
      const tmp = makeTmpDir('gs-e2e-zip-');
      fs.writeFileSync(path.join(tmp, 'mac.zip'), gh.uploads['spinning-cube-1.0.0-mac.zip']);
      // As Archive Utility (ditto) and as `unzip` unpack it: the signature holds either way.
      expect(spawnSync('ditto', ['-x', '-k', path.join(tmp, 'mac.zip'), path.join(tmp, 'ditto')]).status).toBe(0);
      expect(spawnSync('unzip', ['-q', path.join(tmp, 'mac.zip'), '-d', path.join(tmp, 'unzip')]).status).toBe(0);
      for (const how of ['ditto', 'unzip']) {
        const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', path.join(tmp, how, 'Spinning Cube.app')], { encoding: 'utf8' });
        expect(verify.status, `${how}: ${verify.stderr}`).toBe(0);
      }
      const app = path.join(tmp, 'unzip', 'Spinning Cube.app');
      const smoke = await runSmoke(testCtx(dir), { command: path.join(app, 'Contents', 'MacOS', 'Spinning Cube'), args: [], seconds: 3, userDataDir: path.join(tmp, 'data'), windowed: true });
      expect(smoke.errors).toEqual([]);
    }
    // The Linux build made on this OS, Windows included: its launcher is the script as written, with LF line endings,
    // and in the release zip the launcher and the Electron binary are both executable (on Windows, which has no file
    // modes, the zip writer knows them by their first bytes).
    expect(fs.readFileSync(path.join(dir, 'out', 'linux', 'spinning-cube'), 'utf8')).toBe(linuxLauncherScript('spinning-cube'));
    const linuxZip = gh.uploads['spinning-cube-1.0.0-linux.zip'];
    const zipModes = Object.fromEntries(readZipEntries(linuxZip).map((e) => [e.name, e.unixMode === null ? null : e.unixMode & 0o777]));
    expect([zipModes['spinning-cube'], zipModes['spinning-cube-bin']]).toEqual([0o755, 0o755]);
    if (process.platform !== 'win32') {
      const tmp = makeTmpDir('gs-e2e-zip-');
      fs.writeFileSync(path.join(tmp, 'linux.zip'), linuxZip);
      expect(spawnSync('unzip', ['-q', path.join(tmp, 'linux.zip'), '-d', tmp]).status).toBe(0);
      for (const file of ['spinning-cube', 'spinning-cube-bin']) expect(fs.statSync(path.join(tmp, file)).mode & 0o111, file).toBe(0o111);
    }
  });

  it('with --live it reuses the draft, replaces its files and publishes it; after that the release is left alone', async () => {
    const r = await cliAsync(['publish', '--to', 'github', '--live'], dir, fakeEnv());
    expect(r.code).toBe(0);
    expect(r.result.data.destinations[0].details).toMatchObject({ action: 'update', draft: false });
    expect(gh.releases).toHaveLength(1);
    const again = await cliAsync(['publish', '--to', 'github'], dir, fakeEnv());
    expect([again.code, again.result.errors[0].code]).toEqual([2, 'GITHUB_RELEASE_PUBLISHED']);
  });

  it('status shows the last publish', () => {
    const r = cli(['status'], dir);
    expect(r.result.data.lastRuns.publish).toMatchObject({ ok: false, errors: [{ code: 'GITHUB_RELEASE_PUBLISHED' }] });
  });
});
