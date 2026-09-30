import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { defaultDestinations, runPublish } from '../../../src/core/publish/publish.js';
import { testCtx } from '../../helpers/ctx.js';
import { FAKE_BUTLER, FAKE_STEAMCMD, fakeProject } from '../../helpers/fake-builds.js';
import { startFakeGithub, type FakeGithub } from '../../helpers/fake-github.js';
import { refusedUrl } from '../../helpers/server.js';
import { makeTmpDir } from '../../helpers/tmp.js';

let gh: FakeGithub | undefined;
afterEach(async () => {
  await gh?.close();
  gh = undefined;
});

const ALL = { steam: { appId: 1234560, user: 'builder' }, itch: { project: 'moonstudio/moon-game' }, github: { repo: 'moonstudio/moon-game' } };

/** Every tool faked, with a saved butler login, and a saved Steam login when `steamLoggedIn`. */
async function fakes(steamLoggedIn: boolean): Promise<NodeJS.ProcessEnv> {
  gh = await startFakeGithub('moonstudio/moon-game');
  const steamState = makeTmpDir();
  const butlerState = makeTmpDir();
  if (steamLoggedIn) fs.writeFileSync(path.join(steamState, 'login-builder'), 'token');
  fs.writeFileSync(path.join(butlerState, 'creds'), 'key');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GAMESHIPPER_STEAMCMD: FAKE_STEAMCMD,
    FAKE_STEAMCMD_STATE: steamState,
    GAMESHIPPER_BUTLER: FAKE_BUTLER,
    FAKE_BUTLER_STATE: butlerState,
    GAMESHIPPER_GITHUB_API: gh.base,
    GITHUB_TOKEN: 'test-token',
  };
  delete env.BUTLER_API_KEY;
  return env;
}

describe('defaultDestinations', () => {
  it('is what gameshipper.json configures; App ID 480 is no Steam destination', () => {
    const cfg = (raw: object) => parseConfig({ name: 'x', version: '1.0.0', ...raw }).data!;
    expect(defaultDestinations(cfg({}))).toEqual([]);
    expect(defaultDestinations(cfg(ALL))).toEqual(['steam', 'itch', 'github']);
    expect(defaultDestinations(cfg({ steam: { appId: 480, user: 'builder' }, itch: { project: 'a/b' } }))).toEqual(['itch']);
  });
});

describe('runPublish', () => {
  it('publishes everywhere that is configured, each destination on its own', async () => {
    const p = fakeProject(ALL);
    const r = await runPublish(testCtx(p.dir), p.config, { env: await fakes(false) });
    expect(r.data!.destinations.map((d) => [d.to, d.status])).toEqual([
      ['steam', 'failed'],
      ['itch', 'uploaded'],
      ['github', 'uploaded'],
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['STEAM_LOGIN_REQUIRED']);
    expect(r.warnings.map((w) => w.code)).toEqual(['ITCH_UPLOADS_LIVE']);
    expect(r.data).toMatchObject({ version: '1.2.3', dryRun: false, mobile: [] });
  });

  it('succeeds when every destination does', async () => {
    const p = fakeProject(ALL);
    const r = await runPublish(testCtx(p.dir), p.config, { env: await fakes(true), to: ['steam', 'github'], branch: 'beta', live: true });
    expect(r.errors).toEqual([]);
    expect(r.data!.destinations.map((d) => [d.to, d.status])).toEqual([
      ['steam', 'uploaded'],
      ['github', 'uploaded'],
    ]);
  });

  it('--dry-run previews every destination and uploads nothing', async () => {
    const p = fakeProject(ALL);
    const r = await runPublish(testCtx(p.dir), p.config, { env: await fakes(true), dryRun: true });
    expect(r.data!.destinations.map((d) => d.status)).toEqual(['previewed', 'previewed', 'previewed']);
    expect(gh!.releases).toEqual([]);
  });

  it('INPUT_REQUIRED when nothing is configured', async () => {
    const p = fakeProject();
    const r = await runPublish(testCtx(p.dir), p.config, {});
    expect([r.errors[0].code, r.errors[0].fix]).toEqual(['INPUT_REQUIRED', expect.stringContaining('--to')]);
  });

  it('BUILD_MISSING stops it before any upload', async () => {
    const p = fakeProject({ ...ALL, targets: ['linux', 'windows'] }, ['linux']);
    const r = await runPublish(testCtx(p.dir), p.config, { env: await fakes(true) });
    expect(r.errors.map((e) => e.code)).toEqual(['BUILD_MISSING']);
    expect(gh!.requests).toEqual([]);
  });

  it("USAGE for a flag whose destination isn't being published to", async () => {
    const p = fakeProject(ALL);
    for (const [opts, flag] of [
      [{ to: ['itch'], branch: 'beta' }, '--branch'],
      [{ to: ['itch'], steamUser: 'builder' }, '--steam-user'],
      [{ to: ['steam'], live: true }, '--live'],
      [{ to: ['steam'], repo: 'a/b' }, '--repo'],
    ] as const) {
      const r = await runPublish(testCtx(p.dir), p.config, opts);
      expect([r.errors[0].code, r.errors[0].message.startsWith(flag)]).toEqual(['USAGE', true]);
    }
  });

  it('one destination failing, or crashing, never stops the others', async () => {
    const p = fakeProject(ALL);
    const env = await fakes(false);
    const ctx = testCtx(p.dir);
    const r = await runPublish(ctx, p.config, {
      env: { ...env, GAMESHIPPER_GITHUB_API: await refusedUrl() },
      interactive: true,
      handOff: async () => {
        throw new Error('the terminal went away');
      },
    });
    expect(r.data!.destinations.map((d) => [d.to, d.status])).toEqual([
      ['steam', 'failed'],
      ['itch', 'uploaded'],
      ['github', 'failed'],
    ]);
    expect(r.errors.map((e) => e.code)).toEqual(['INTERNAL_ERROR', 'GITHUB_API_FAILED']);
    expect(fs.readFileSync(ctx.logPath, 'utf8')).toContain('Error: the terminal went away');
  });

  it('says what to do about iOS and Android', async () => {
    const p = fakeProject({ ...ALL, targets: ['windows', 'mac', 'linux', 'android'], mobile: { bundleId: 'com.moon.game' } });
    const r = await runPublish(testCtx(p.dir), p.config, { env: await fakes(true), to: ['itch'] });
    expect(r.data!.mobile.map((m) => m.target)).toEqual(['android']);
  });
});
