import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GithubClient } from '../../../src/core/publish/github/api.js';
import { startFakeGithub, type FakeGithub } from '../../helpers/fake-github.js';
import { refusedUrl } from '../../helpers/server.js';
import { makeTmpDir } from '../../helpers/tmp.js';

const REPO = 'moonstudio/moon-game';
let gh: FakeGithub | undefined;
afterEach(async () => {
  await gh?.close();
  gh = undefined;
});

const client = (token: string, repo = REPO, log: (line: string) => void = () => {}) =>
  new GithubClient({ apiBase: gh!.base, token, repo, userAgent: 'gameshipper-test', log });

function file(bytes: number): string {
  const f = path.join(makeTmpDir(), 'a.zip');
  fs.writeFileSync(f, Buffer.alloc(bytes, 7));
  return f;
}

describe('GithubClient', () => {
  it('turns HTTP failures into errors with fixes, and never logs the token', async () => {
    gh = await startFakeGithub(REPO);
    const lines: string[] = [];
    await expect(client('wrong-token', REPO, (l) => lines.push(l)).checkRepo()).rejects.toMatchObject({ error: { code: 'GITHUB_AUTH_FAILED' } });
    await expect(client('test-token', 'someone/else').checkRepo()).rejects.toMatchObject({ error: { code: 'GITHUB_REPO_NOT_FOUND' } });
    gh.canPush = false;
    await expect(client('test-token').checkRepo()).rejects.toMatchObject({ error: { code: 'GITHUB_AUTH_FAILED', message: expect.stringContaining("can't write") } });
    expect(lines).toEqual([`github: GET /repos/${REPO} → 401`]);
  });

  it('GITHUB_API_FAILED when GitHub cannot be reached', async () => {
    const c = new GithubClient({ apiBase: await refusedUrl(), token: 't', repo: REPO, userAgent: 'gameshipper-test', log: () => {} });
    await expect(c.checkRepo()).rejects.toMatchObject({ error: { code: 'GITHUB_API_FAILED', message: expect.stringContaining('ECONNREFUSED') } });
  });

  it("finds draft releases, which GitHub's release-by-tag lookup never returns", async () => {
    gh = await startFakeGithub(REPO);
    await client('test-token').createDraft({ tag: 'v1.0.0', name: 'x', body: '' });
    expect((await client('test-token').findRelease('v1.0.0'))?.draft).toBe(true);
    expect(await client('test-token').findRelease('v9.9.9')).toBeNull();
  });

  it('uploads a file as it streams from disk, replaces it, and publishes', async () => {
    gh = await startFakeGithub(REPO);
    const c = client('test-token');
    const release = await c.createDraft({ tag: 'v1.0.0', name: 'x', body: '' });
    const zip = file(300_000);
    const asset = await c.uploadAsset(release, 'a.zip', zip);
    expect([asset.name, asset.size, gh.uploads['a.zip'].equals(fs.readFileSync(zip))]).toEqual(['a.zip', 300_000, true]);
    await expect(c.uploadAsset(release, 'a.zip', zip)).rejects.toMatchObject({ error: { code: 'GITHUB_API_FAILED', message: expect.stringContaining('422') } });
    await c.deleteAsset(asset.id);
    // Deleting it again is fine: a re-run may find it gone already.
    await c.deleteAsset(asset.id);
    expect((await c.uploadAsset(release, 'a.zip', zip)).name).toBe('a.zip');
    expect((await c.publish(release.id)).draft).toBe(false);
  });
});
