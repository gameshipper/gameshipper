import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishGithub, type GithubOptions } from '../../../src/core/publish/github/publish.js';
import type { GsError } from '../../../src/core/result.js';
import { handOff } from '../../../src/core/tools/run.js';
import { testCtx } from '../../helpers/ctx.js';
import { fakeProject } from '../../helpers/fake-builds.js';
import { startFakeGithub, type FakeGithub } from '../../helpers/fake-github.js';
import { makeTmpDir } from '../../helpers/tmp.js';

const REPO = 'moonstudio/moon-game';
let gh: FakeGithub | undefined;
afterEach(async () => {
  await gh?.close();
  gh = undefined;
});

function opts(extra: Partial<GithubOptions> = {}, env: NodeJS.ProcessEnv = { GITHUB_TOKEN: 'test-token' }): GithubOptions {
  return {
    dryRun: false,
    interactive: false,
    env: { GAMESHIPPER_GITHUB_API: gh?.base, ...env },
    handOff,
    notice: () => {},
    platform: process.platform,
    arch: process.arch,
    repo: null,
    live: false,
    ...extra,
  };
}

const project = () => fakeProject({ github: { repo: REPO } });

describe('publishGithub', () => {
  it('makes a draft release v<version> with one zip per OS, then clears the zips away', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts());
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('uploaded');
    expect(r.details).toMatchObject({ repo: REPO, tag: 'v1.2.3', action: 'create', draft: true });
    expect(r.details!.assets.map((a) => a.name)).toEqual(['moon-game-1.2.3-windows.zip', 'moon-game-1.2.3-mac.zip', 'moon-game-1.2.3-linux.zip']);
    expect(r.details!.assets.every((a) => (a.size ?? 0) > 0 && a.url)).toBe(true);
    const [release] = gh.releases;
    expect(release).toMatchObject({ tag_name: 'v1.2.3', name: 'Moon Game 1.2.3', draft: true });
    expect(release.body).toContain('- macOS: moon-game-1.2.3-mac.zip');
    expect(fs.existsSync(path.join(p.dir, '.gameshipper', 'release'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('the Mac zip unzips to the build, symlinks and the executable bit included', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    await publishGithub(testCtx(p.dir), p.config, p.builds, opts());
    const tmp = makeTmpDir();
    fs.writeFileSync(path.join(tmp, 'mac.zip'), gh.uploads['moon-game-1.2.3-mac.zip']);
    expect(spawnSync('unzip', ['-q', path.join(tmp, 'mac.zip'), '-d', path.join(tmp, 'x')]).status).toBe(0);
    const app = path.join(tmp, 'x', 'Moon Game.app');
    expect(fs.statSync(path.join(app, 'Contents', 'MacOS', 'Moon Game')).mode & 0o111).not.toBe(0);
    expect(fs.readlinkSync(path.join(app, 'Contents', 'Frameworks', 'X.framework', 'Versions', 'Current'))).toBe('A');
    expect(fs.readFileSync(path.join(tmp, 'x', 'LICENSE'), 'utf8')).toBe('MIT');
  });

  it('publishing again reuses the draft and replaces its files', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    await publishGithub(testCtx(p.dir), p.config, p.builds, opts());
    const again = await publishGithub(testCtx(p.dir), p.config, p.builds, opts());
    expect(again.details!.action).toBe('update');
    expect(gh.releases).toHaveLength(1);
    expect(gh.releases[0].assets.map((a) => a.name).sort()).toEqual(['moon-game-1.2.3-linux.zip', 'moon-game-1.2.3-mac.zip', 'moon-game-1.2.3-windows.zip']);
    expect(gh.requests.filter((r) => r.startsWith('DELETE'))).toHaveLength(3);
  });

  it('--live publishes the release once every file is attached', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts({ live: true }));
    expect(r.details).toMatchObject({ draft: false, url: `${gh.base}/${REPO}/releases/tag/v1.2.3` });
    expect(gh.requests.at(-1)).toBe(`PATCH /repos/${REPO}/releases/1`);
  });

  it('GITHUB_RELEASE_PUBLISHED instead of changing a published release', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    await publishGithub(testCtx(p.dir), p.config, p.builds, opts({ live: true }));
    const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts());
    expect(r.errors[0].code).toBe('GITHUB_RELEASE_PUBLISHED');
    expect(r.errors[0].fix).toContain('version');
  });

  it('--dry-run checks the repository and plans, without zipping or uploading', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts({ dryRun: true }));
    expect(r.status).toBe('previewed');
    expect(r.details!.assets.map((a) => a.size)).toEqual([null, null, null]);
    expect(gh.requests).toEqual([`GET /repos/${REPO}`, `GET /repos/${REPO}/releases`]);
  });

  it('tells the human to make a token for the repository and set it themselves, never to hand it over', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    const missing = (await publishGithub(testCtx(p.dir), p.config, p.builds, opts({}, {}))).errors[0];
    // Thrown past publishGithub; publish makes it the destination's error.
    const refused = await publishGithub(testCtx(p.dir), p.config, p.builds, opts({}, { GITHUB_TOKEN: 'wrong-token' })).then(
      (r) => r.errors[0],
      (e: { error: GsError }) => e.error,
    );
    expect([missing.code, refused.code]).toEqual(['GITHUB_TOKEN_MISSING', 'GITHUB_AUTH_FAILED']);
    for (const fix of [missing.fix, refused.fix]) {
      expect(fix).toContain(`The human creates a fine-grained token limited to ${REPO} (Contents: Read and write)`);
      expect(fix).toContain('sets GITHUB_TOKEN to it themselves where Gameshipper runs');
      expect(fix).toContain('never pasting it into a chat or a command line');
      expect(fix).not.toMatch(/\bask\b[^.]*\btoken/i);
    }
  });

  it('refuses a token with spaces or line breaks before using it, and never repeats it', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    for (const [name, value] of [
      ['GITHUB_TOKEN', 'gs-marker\ndef'],
      ['GH_TOKEN', 'gs-marker def'],
      ['GITHUB_TOKEN', 'gs-marker\u0000def'],
    ] as const) {
      const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts({}, { [name]: value }));
      expect(r.errors[0], name).toMatchObject({ code: 'GITHUB_AUTH_FAILED', message: `The token in ${name} has spaces or line breaks in it.` });
      expect(JSON.stringify(r)).not.toContain('gs-marker');
    }
    expect(gh.requests).toEqual([]);
    // Space or a line break around it is only trimmed.
    expect((await publishGithub(testCtx(p.dir), p.config, p.builds, opts({}, { GITHUB_TOKEN: '  test-token\n' }))).status).toBe('uploaded');
  });

  it('GITHUB_API_FAILED naming GAMESHIPPER_GITHUB_API when it is not a web address', async () => {
    const p = project();
    for (const api of ['not a url', 'ftp://github.example.com']) {
      const r = await publishGithub(testCtx(p.dir), p.config, p.builds, { ...opts(), env: { GITHUB_TOKEN: 'test-token', GAMESHIPPER_GITHUB_API: api } });
      expect(r.errors[0], api).toMatchObject({ code: 'GITHUB_API_FAILED', fix: expect.stringContaining('GAMESHIPPER_GITHUB_API') });
    }
  });

  it('an empty --repo falls back to github.repo', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts({ repo: '' }));
    expect([r.status, r.details?.repo]).toEqual(['uploaded', REPO]);
  });

  it(". and .. aren't repositories", async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    for (const repo of ['moonstudio/.', 'moonstudio/..', './moon-game', '../moon-game']) {
      expect((await publishGithub(testCtx(p.dir), p.config, p.builds, opts({ repo }))).errors[0].code, repo).toBe('USAGE');
    }
    expect(gh.requests).toEqual([]);
  });

  it('takes the token from GITHUB_TOKEN or GH_TOKEN, and nowhere else', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    const missing = await publishGithub(testCtx(p.dir), p.config, p.builds, opts({}, {}));
    expect([missing.errors[0].code, missing.errors[0].fix]).toEqual(['GITHUB_TOKEN_MISSING', expect.stringContaining("doesn't use the gh CLI")]);
    expect(gh.requests).toEqual([]);
    expect((await publishGithub(testCtx(p.dir), p.config, p.builds, opts({}, { GH_TOKEN: 'test-token' }))).status).toBe('uploaded');
  });

  it('--repo overrides github.repo; INPUT_REQUIRED without either; USAGE for a name that is not owner/repo', async () => {
    gh = await startFakeGithub('other/repo');
    const p = fakeProject();
    expect((await publishGithub(testCtx(p.dir), p.config, p.builds, opts())).errors[0].code).toBe('INPUT_REQUIRED');
    expect((await publishGithub(testCtx(p.dir), p.config, p.builds, opts({ repo: 'other/repo' }))).status).toBe('uploaded');
    expect((await publishGithub(testCtx(p.dir), p.config, p.builds, opts({ repo: 'not a repo' }))).errors[0].code).toBe('USAGE');
  });

  it('ZIP_FAILED stops before anything is made on GitHub', async () => {
    gh = await startFakeGithub(REPO);
    const p = project();
    // A folder in place of the zip: it can't be written.
    fs.mkdirSync(path.join(p.dir, '.gameshipper', 'release', 'moon-game-1.2.3-mac.zip', 'x'), { recursive: true });
    const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts());
    expect(r.errors[0].code).toBe('ZIP_FAILED');
    expect(gh.releases).toEqual([]);
  });

  it('a failed upload leaves the draft, and the result says where it is; the zips are cleared away all the same', async () => {
    gh = await startFakeGithub(REPO);
    gh.failUploads = true;
    const p = project();
    const exitListeners = process.listenerCount('exit');
    const r = await publishGithub(testCtx(p.dir), p.config, p.builds, opts());
    expect([r.status, r.errors[0].code]).toEqual(['failed', 'GITHUB_API_FAILED']);
    expect(r.details).toMatchObject({ draft: true, url: `${gh.base}/${REPO}/releases/tag/untagged-1` });
    expect(fs.existsSync(path.join(p.dir, '.gameshipper', 'release'))).toBe(false);
    // Removing the zips as Gameshipper exits (Ctrl+C mid-upload) is only arranged while they exist.
    expect(process.listenerCount('exit')).toBe(exitListeners);
  });
});
