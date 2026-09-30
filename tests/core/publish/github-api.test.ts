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

  it("keeps GitHub's reason short: its JSON message and first error, or the first line of anything else", async () => {
    gh = await startFakeGithub(REPO);
    const c = client('test-token');
    gh.respondWith = { status: 422, body: JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Release', code: 'custom', message: 'tag_name is not a valid tag' }] }) };
    await expect(c.checkRepo()).rejects.toMatchObject({
      error: { code: 'GITHUB_API_FAILED', message: `GitHub GET /repos/${REPO} failed (HTTP 422: Validation Failed: tag_name is not a valid tag).` },
    });
    gh.respondWith = { status: 502, body: '<html>\n<head><title>502 Bad Gateway</title></head>\n</html>', contentType: 'text/html' };
    await expect(c.checkRepo()).rejects.toMatchObject({ error: { message: `GitHub GET /repos/${REPO} failed (HTTP 502: <html>).` } });
    // A 2 MB page on one line.
    gh.respondWith = { status: 500, body: `<html>${'x'.repeat(2 * 1024 * 1024)}</html>`, contentType: 'text/html' };
    const error = await c.checkRepo().then(
      () => null,
      (e: { error: unknown }) => e.error,
    );
    expect(JSON.stringify(error).length).toBeLessThan(1000);
    expect((error as { message: string }).message).toBe(`GitHub GET /repos/${REPO} failed (HTTP 500: <html>${'x'.repeat(293)}…).`);
  });

  it('never puts the token in a message, even when an error quotes it', async () => {
    gh = await startFakeGithub(REPO, 'gs-marker-token');
    gh.respondWith = { status: 500, body: (auth) => JSON.stringify({ message: `Server Error for ${auth}` }) };
    const error = await client('gs-marker-token').checkRepo().then(
      () => null,
      (e: { error: unknown }) => e.error,
    );
    expect(JSON.stringify(error)).not.toContain('gs-marker-token');
    expect((error as { message: string }).message).toContain('Server Error for Bearer ***');
    // Node's fetch quotes a header it refuses, token and all.
    const bad = await client('gs-marker\nrest').checkRepo().then(
      () => null,
      (e: { error: unknown }) => e.error,
    );
    expect(bad).toMatchObject({ code: 'GITHUB_API_FAILED' });
    expect(JSON.stringify(bad)).not.toContain('gs-marker');
  });

  it('takes the token out before it cuts a long reason, so no part of it is left where the cut falls', async () => {
    gh = await startFakeGithub(REPO, 'gs-marker-token');
    // "Bearer gs-marker-token" starts at character 283: the 300-character cut falls inside the token.
    for (const [contentType, body] of [
      ['text/html', (auth: string) => `${'x'.repeat(282)} ${auth} and the rest of the page`],
      ['application/json', (auth: string) => JSON.stringify({ message: `${'x'.repeat(282)} ${auth} and the rest of the message` })],
    ] as const) {
      gh.respondWith = { status: 500, body, contentType };
      const error = await client('gs-marker-token').checkRepo().then(
        () => null,
        (e: { error: unknown }) => e.error,
      );
      expect(JSON.stringify(error), contentType).not.toMatch(/gs-m|marker/);
      expect((error as { message: string }).message, contentType).toContain(`${'x'.repeat(282)} Bearer *** and`);
    }
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
