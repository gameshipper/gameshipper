import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpData } from '../../src/cli/help.js';
import { main, type CliIO } from '../../src/cli/main.js';
import { exitCodeFor } from '../../src/cli/output.js';
import { publishSummary } from '../../src/cli/summaries.js';
import { fail, gsError, ok } from '../../src/core/result.js';
import { FAKE_BUTLER, FAKE_STEAMCMD, fakeProject } from '../helpers/fake-builds.js';
import { startFakeGithub, type FakeGithub } from '../helpers/fake-github.js';
import { makeTmpDir } from '../helpers/tmp.js';

async function run(argv: string[]): Promise<{ code: number; out: string; json: () => any }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY: false };
  const code = await main(argv, io);
  return { code, out, json: () => JSON.parse(out) };
}

let gh: FakeGithub | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await gh?.close();
  gh = undefined;
});

const ALL = { steam: { appId: 1234560, user: 'builder' }, itch: { project: 'moonstudio/moon-game' }, github: { repo: 'moonstudio/moon-game' } };

/** The fake SteamCMD, butler (logged in) and GitHub, through the environment as a person would set it. */
async function useFakes(steamLoggedIn: boolean): Promise<void> {
  gh = await startFakeGithub('moonstudio/moon-game');
  const steamState = makeTmpDir();
  const butlerState = makeTmpDir();
  if (steamLoggedIn) fs.writeFileSync(path.join(steamState, 'login-builder'), 'token');
  fs.writeFileSync(path.join(butlerState, 'creds'), 'key');
  vi.stubEnv('GAMESHIPPER_STEAMCMD', FAKE_STEAMCMD);
  vi.stubEnv('FAKE_STEAMCMD_STATE', steamState);
  vi.stubEnv('GAMESHIPPER_BUTLER', FAKE_BUTLER);
  vi.stubEnv('FAKE_BUTLER_STATE', butlerState);
  vi.stubEnv('BUTLER_API_KEY', undefined);
  vi.stubEnv('GAMESHIPPER_GITHUB_API', gh.base);
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
}

describe('gameshipper publish', () => {
  it('is in the help catalog, with the variables it reads', async () => {
    const data = (await run(['help', '--json'])).json().data;
    const publish = data.commands.find((c: { name: string }) => c.name === 'publish');
    expect(publish.flags.map((f: { name: string }) => f.name)).toEqual(['to', 'dry-run', 'steam-user', 'branch', 'repo', 'live']);
    expect(data.environment.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(['GITHUB_TOKEN', 'GH_TOKEN', 'BUTLER_API_KEY']));
    expect((await run(['publish', '--help'])).out).toContain('Usage: npx gameshipper publish');
  });

  it('rejects destinations it does not know (exit 2)', async () => {
    const r = await run(['publish', '--to', 'steam,xbox', '--json', '--dir', makeTmpDir()]);
    expect([r.code, r.json().errors[0].message]).toEqual([2, 'Unknown destination "xbox".']);
  });

  it('CONFIG_MISSING without gameshipper.json, writing nothing', async () => {
    const dir = makeTmpDir();
    const r = await run(['publish', '--json', '--dir', dir]);
    expect([r.code, r.json().errors[0].code]).toEqual([2, 'CONFIG_MISSING']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('STEAM_LOGIN_REQUIRED (exit 2) asks for the human, and the other destinations still publish', async () => {
    await useFakes(false);
    const p = fakeProject(ALL);
    const r = await run(['publish', '--json', '--dir', p.dir]);
    const result = r.json();
    expect(r.code).toBe(2);
    expect(result.errors.map((e: { code: string }) => e.code)).toEqual(['STEAM_LOGIN_REQUIRED']);
    expect(result.data.destinations.map((d: { to: string; status: string }) => `${d.to}:${d.status}`)).toEqual(['steam:failed', 'itch:uploaded', 'github:uploaded']);
    expect(result.logPath).toMatch(/publish-.+\.log$/);
    expect(fs.readFileSync(result.logPath, 'utf8')).toContain('publish failed: STEAM_LOGIN_REQUIRED');
    expect(JSON.parse(fs.readFileSync(path.join(p.dir, '.gameshipper', 'last', 'publish.json'), 'utf8')).ok).toBe(false);
  });

  it('exit 0 when everything uploads', async () => {
    await useFakes(true);
    const p = fakeProject(ALL);
    const r = await run(['publish', '--json', '--dir', p.dir, '--branch', 'beta', '--live']);
    expect(r.json().errors).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('prints what it uploaded, and the Steamworks settings to enter once', async () => {
    await useFakes(true);
    const p = fakeProject(ALL);
    const r = await run(['publish', '--dir', p.dir]);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toBe('Publishing to Steam, itch.io and GitHub Releases (add --verbose to follow SteamCMD and butler)…');
    expect(lines[1]).toBe("Note: itch.io makes uploads downloadable at once if the game's page is public.");
    expect(r.out).toContain('✓ steam   build 12345678 uploaded to app 1234560 (not live yet)');
    expect(r.out).toContain('Set the build live on the default branch: https://partner.steamgames.com/apps/builds/1234560');
    expect(r.out).toContain('    macOS            Moon Game.app');
    expect(r.out).toContain('    Linux + SteamOS  root LinuxHome, subdirectory ".config/Moon Game/saves", pattern *.json');
    expect(r.out).toContain('✓ itch    pushed windows, mac, linux to https://moonstudio.itch.io/moon-game');
    expect(r.out).toMatch(/✓ github  draft release v1\.2\.3: http:\/\/127\.0\.0\.1:\d+\/moonstudio\/moon-game\/releases\/tag\/untagged-\d+ \(publish it there, or publish again with --live\)/);
  });

  it('login and setup problems are exit 2; failed uploads are exit 1', () => {
    for (const code of ['BUILD_MISSING', 'STEAM_TEST_APP', 'STEAM_DEFAULT_BRANCH', 'STEAM_LOGIN_REQUIRED', 'ITCH_LOGIN_REQUIRED', 'GITHUB_TOKEN_MISSING', 'GITHUB_AUTH_FAILED', 'GITHUB_REPO_NOT_FOUND', 'GITHUB_RELEASE_PUBLISHED']) {
      expect(exitCodeFor(fail(gsError(code, 'x'))), code).toBe(2);
    }
    for (const code of ['STEAM_UPLOAD_FAILED', 'STEAM_SET_LIVE_FAILED', 'STEAM_LOGIN_FAILED', 'STEAMCMD_CANT_RUN', 'ITCH_PUSH_FAILED', 'ITCH_LOGIN_FAILED', 'GITHUB_API_FAILED', 'ZIP_FAILED', 'TOOL_DOWNLOAD_FAILED', 'TOOL_CHECKSUM_MISMATCH', 'TOOL_UNSUPPORTED_HOST']) {
      expect(exitCodeFor(fail(gsError(code, 'x'))), code).toBe(1);
    }
  });

  it('help --json tells agents where publish goes in the loop', () => {
    expect(helpData().agentLoop.some((step) => step.startsWith('npx gameshipper publish --dry-run --json'))).toBe(true);
  });
});

describe('publishSummary', () => {
  it('lists failures by code, dry runs, and what to do about iOS and Android', () => {
    const lines = publishSummary(
      ok({
        version: '1.0.0',
        dryRun: true,
        destinations: [
          { to: 'itch' as const, status: 'failed' as const, errors: [{ code: 'ITCH_LOGIN_REQUIRED', message: 'x' }], warnings: [] },
          {
            to: 'github' as const,
            status: 'previewed' as const,
            details: { repo: 'a/b', tag: 'v1.0.0', action: 'create' as const, draft: true, url: null, assets: [{ target: 'linux' as const, name: 'g-1.0.0-linux.zip', size: null, url: null }] },
            errors: [],
            warnings: [],
          },
        ],
        mobile: [{ target: 'ios' as const, steps: ['Open out/ios/App/App.xcodeproj in Xcode.'] }],
      }),
    );
    expect(lines).toEqual([
      '✗ itch    failed (ITCH_LOGIN_REQUIRED)',
      '✓ github  would create draft release v1.0.0 on a/b with g-1.0.0-linux.zip',
      '',
      "iOS isn't uploaded by Gameshipper. Next steps:",
      '  1. Open out/ios/App/App.xcodeproj in Xcode.',
    ]);
  });
});
