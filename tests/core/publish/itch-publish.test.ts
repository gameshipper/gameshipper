import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishItch, type ItchOptions } from '../../../src/core/publish/itch/publish.js';
import { runExternal, type ToolCommand } from '../../../src/core/tools/run.js';
import { testCtx } from '../../helpers/ctx.js';
import { FAKE_BUTLER, fakeProject } from '../../helpers/fake-builds.js';
import { makeTmpDir } from '../../helpers/tmp.js';

function setup(extra: Partial<ItchOptions> = {}, mode = 'ok', loggedIn = true, apiKey?: string) {
  const state = makeTmpDir('gs-butler-');
  if (loggedIn) fs.writeFileSync(path.join(state, 'creds'), 'key');
  const handOffs: string[][] = [];
  const notices: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, GAMESHIPPER_BUTLER: FAKE_BUTLER, FAKE_BUTLER_STATE: state, FAKE_BUTLER_MODE: mode };
  delete env.BUTLER_API_KEY;
  if (apiKey) env.BUTLER_API_KEY = apiKey;
  const opts: ItchOptions = {
    dryRun: false,
    interactive: false,
    env,
    handOff: async (tool: ToolCommand, args: string[]) => {
      handOffs.push(args);
      return (await runExternal(tool, args, { timeoutMs: 20_000 })).exitCode ?? 1;
    },
    notice: (m) => void notices.push(m),
    platform: process.platform,
    arch: process.arch,
    ...extra,
  };
  return { state, handOffs, notices, opts };
}

const pushes = (state: string): Array<{ src: string; target: string; userversion: string }> =>
  fs.existsSync(path.join(state, 'pushes.jsonl'))
    ? fs.readFileSync(path.join(state, 'pushes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];

const itchProject = () => fakeProject({ itch: { project: 'moonstudio/moon-game' } });

describe('publishItch', () => {
  it('pushes each build to its channel with the version, and warns that uploads are live', async () => {
    const p = itchProject();
    const s = setup();
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, s.opts);
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('uploaded');
    expect(r.details).toEqual({
      project: 'moonstudio/moon-game',
      pageUrl: 'https://moonstudio.itch.io/moon-game',
      channels: [
        { target: 'windows', channel: 'windows', buildId: 1000 },
        { target: 'mac', channel: 'mac', buildId: 1001 },
        { target: 'linux', channel: 'linux', buildId: 1002 },
      ],
    });
    expect(pushes(s.state).map((x) => [path.basename(x.src), x.target, x.userversion])).toEqual([
      ['windows', 'moonstudio/moon-game:windows', '1.2.3'],
      ['mac', 'moonstudio/moon-game:mac', '1.2.3'],
      ['linux', 'moonstudio/moon-game:linux', '1.2.3'],
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['ITCH_UPLOADS_LIVE']);
  });

  it('ITCH_LOGIN_REQUIRED when butler has no login and nobody is at a terminal', async () => {
    const p = itchProject();
    const s = setup({}, 'ok', false);
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, s.opts);
    expect([r.status, r.errors[0].code]).toEqual(['failed', 'ITCH_LOGIN_REQUIRED']);
    expect(r.errors[0].message).toContain('No credentials and stdin is not a terminal');
    expect(r.errors[0].fix).toContain('`npx gameshipper publish --to itch --dry-run`');
    expect([pushes(s.state), s.handOffs]).toEqual([[], []]);
  });

  it('hands the terminal to `butler login`, then pushes', async () => {
    const p = itchProject();
    const s = setup({ interactive: true }, 'ok', false);
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, s.opts);
    expect(s.handOffs).toEqual([['login']]);
    expect(s.notices).toEqual([expect.stringContaining('butler opens your browser')]);
    expect(r.status).toBe('uploaded');
  });

  it('ITCH_LOGIN_FAILED when the browser login does not finish', async () => {
    const p = itchProject();
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, setup({ interactive: true }, 'login-fails', false).opts);
    expect(r.errors[0].code).toBe('ITCH_LOGIN_FAILED');
  });

  it('a refused BUTLER_API_KEY is named, and never answered with a browser login', async () => {
    const p = itchProject();
    const s = setup({ interactive: true }, 'ok', false, 'bad');
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, s.opts);
    expect(r.errors[0]).toMatchObject({ code: 'ITCH_LOGIN_REQUIRED', message: expect.stringContaining('BUTLER_API_KEY') });
    expect(r.errors[0].message).toContain('invalid key');
    expect(r.errors[0].message).not.toContain('github.com/itchio');
    expect(s.handOffs).toEqual([]);
  });

  it('--dry-run lists what would be pushed, even before logging in', async () => {
    const p = itchProject();
    const s = setup({ dryRun: true }, 'ok', false);
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, s.opts);
    expect(r.status).toBe('previewed');
    expect(r.details!.channels.every((c) => c.buildId === null)).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['ITCH_UPLOADS_LIVE', 'ITCH_LOGIN_REQUIRED']);
    expect(pushes(s.state)).toEqual([]);
  });

  it("ITCH_PUSH_FAILED with butler's reason, for each channel", async () => {
    const p = itchProject();
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, setup({}, 'push-fails').opts);
    expect(r.errors.map((e) => e.code)).toEqual(['ITCH_PUSH_FAILED', 'ITCH_PUSH_FAILED', 'ITCH_PUSH_FAILED']);
    expect(r.errors[0].message).toBe('Pushing windows to moonstudio/moon-game:windows failed: itch.io API error (400): /wharf/builds: invalid target (bad user/game)');
  });

  it("ITCH_PUSH_FAILED when itch.io can't be reached: never a login problem, and no browser login", async () => {
    const p = itchProject();
    for (const [name, extra, apiKey] of [
      ['saved login, at a terminal', { interactive: true }, undefined],
      ['BUTLER_API_KEY', {}, 'a-key'],
      ['dry run', { dryRun: true }, undefined],
    ] as const) {
      const s = setup(extra, 'offline', true, apiKey);
      const r = await publishItch(testCtx(p.dir), p.config, p.builds, s.opts);
      expect([r.status, r.errors.map((e) => e.code)], name).toEqual(['failed', ['ITCH_PUSH_FAILED']]);
      expect(r.errors[0].message, name).toBe(
        'butler couldn\'t reach itch.io to check its login: Get "https://api.itch.io/wharf/status": dial tcp: lookup api.itch.io: no such host',
      );
      expect(r.errors[0].fix, name).toContain('internet connection');
      expect([s.handOffs, pushes(s.state)], name).toEqual([[], []]);
    }
  });

  it("ITCH_PUSH_FAILED when itch.io fails itself, with butler's reason", async () => {
    const p = itchProject();
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, setup({ interactive: true }, 'server-error').opts);
    expect([r.errors[0].code, r.errors[0].message]).toEqual([
      'ITCH_PUSH_FAILED',
      "butler couldn't reach itch.io to check its login: itch.io API error (500): /wharf/status: internal error",
    ]);
  });

  it("the page's address turns _ in the username into -, as itch.io's subdomains do; butler gets the name as it is", async () => {
    const p = fakeProject({ itch: { project: 'moon_studio/moon-game' } });
    const s = setup();
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, s.opts);
    expect(r.details!.pageUrl).toBe('https://moon-studio.itch.io/moon-game');
    expect(pushes(s.state).map((x) => x.target)).toEqual(['moon_studio/moon-game:windows', 'moon_studio/moon-game:mac', 'moon_studio/moon-game:linux']);
  });

  it('INPUT_REQUIRED without itch.project', async () => {
    const p = fakeProject();
    const r = await publishItch(testCtx(p.dir), p.config, p.builds, setup().opts);
    expect([r.errors[0].code, r.errors[0].fix]).toEqual(['INPUT_REQUIRED', expect.stringContaining('itch.project')]);
  });
});
