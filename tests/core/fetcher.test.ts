import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchFailure, fetchRemote } from '../../src/core/prepare/fetcher.js';
import { testCtx } from '../helpers/ctx.js';
import { startServer, type TestServer } from '../helpers/server.js';
import { makeTmpDir } from '../helpers/tmp.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('fetchRemote', () => {
  it('downloads once, then serves from cache (even offline)', async () => {
    server = await startServer({ '/a.js': { body: 'export default 1;', type: 'text/javascript' } });
    const ctx = testCtx(makeTmpDir());
    const url = `${server.base}/a.js`;
    const first = await fetchRemote(ctx, url, null);
    expect(first).toMatchObject({ url, finalUrl: url, contentType: 'text/javascript', sha256: sha('export default 1;') });
    expect(first.body.toString()).toBe('export default 1;');
    await server.close();
    server = undefined;
    const second = await fetchRemote(ctx, url, first.sha256);
    expect(second.body.toString()).toBe('export default 1;');
  });

  it('re-downloads when the cache entry is damaged', async () => {
    server = await startServer({ '/a.js': { body: 'export default 1;', type: 'text/javascript' } });
    const cacheDir = makeTmpDir();
    const ctx = testCtx(makeTmpDir(), cacheDir);
    const url = `${server.base}/a.js`;
    await fetchRemote(ctx, url, null);
    const cdn = path.join(cacheDir, 'cdn');
    for (const f of fs.readdirSync(cdn).filter((n) => n.endsWith('.json'))) fs.writeFileSync(path.join(cdn, f), '{broken');
    const again = await fetchRemote(ctx, url, null);
    expect(again.body.toString()).toBe('export default 1;');
    expect(server.hits).toEqual(['/a.js', '/a.js']);
  });

  it('follows redirects and reports the final URL', async () => {
    server = await startServer({ '/three': { redirect: '/three@1/three.js' }, '/three@1/three.js': { body: 'x', type: 'text/javascript' } });
    const got = await fetchRemote(testCtx(makeTmpDir()), `${server.base}/three`, null);
    expect(got.finalUrl).toBe(`${server.base}/three@1/three.js`);
  });

  it('CDN_FETCH_FAILED on HTTP errors', async () => {
    server = await startServer({});
    const failure = await fetchRemote(testCtx(makeTmpDir()), `${server.base}/missing.js`, null).catch((e) => e);
    expect(failure).toBeInstanceOf(FetchFailure);
    expect(failure).toMatchObject({ status: 404, error: { code: 'CDN_FETCH_FAILED', message: expect.stringContaining('HTTP 404') } });
  });

  it("CDN_FETCH_FAILED names the network error's code", async () => {
    server = await startServer({});
    const url = `${server.base}/a.js`;
    await server.close();
    server = undefined;
    const failure = await fetchRemote(testCtx(makeTmpDir()), url, null).catch((e) => e);
    expect(failure).toBeInstanceOf(FetchFailure);
    expect(failure).toMatchObject({ status: null, error: { code: 'CDN_FETCH_FAILED', message: `Couldn't download ${url}: fetch failed (ECONNREFUSED)` } });
  });

  it('CDN_FETCH_FAILED when the server drops the connection', async () => {
    server = await startServer({ '/a.js': { reset: 1 } });
    const failure = await fetchRemote(testCtx(makeTmpDir()), `${server.base}/a.js`, null).catch((e) => e);
    expect(failure).toMatchObject({ status: null, error: { code: 'CDN_FETCH_FAILED', message: expect.stringMatching(/fetch failed \([A-Z_]+\)$/) } });
  });

  it('uses the cache only when it matches the expected hash', async () => {
    server = await startServer({ '/a.js': { body: 'v1', type: 'text/javascript' } });
    const ctx = testCtx(makeTmpDir());
    const url = `${server.base}/a.js`;
    await fetchRemote(ctx, url, null);
    server.routes['/a.js'] = { body: 'v2', type: 'text/javascript' };
    expect((await fetchRemote(ctx, url, sha('v1'))).body.toString()).toBe('v1');
    // The lock expects something else: ask the server; the caller compares hashes.
    const fresh = await fetchRemote(ctx, url, sha('old'));
    expect(fresh).toMatchObject({ sha256: sha('v2') });
    expect(server.hits).toEqual(['/a.js', '/a.js']);
  });

  it('CDN_FETCH_FAILED says so when a download times out', async () => {
    server = await startServer({ '/slow.js': { hang: true } });
    const started = Date.now();
    await expect(fetchRemote(testCtx(makeTmpDir()), `${server.base}/slow.js`, null, { timeoutMs: 100 })).rejects.toMatchObject({
      status: null,
      error: { code: 'CDN_FETCH_FAILED', message: expect.stringContaining('timed out after 0.1s') },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
