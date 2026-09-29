import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchRemote } from '../../src/core/prepare/fetcher.js';
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
    await expect(fetchRemote(testCtx(makeTmpDir()), `${server.base}/missing.js`, null)).rejects.toMatchObject({
      error: { code: 'CDN_FETCH_FAILED' },
    });
  });

  it('CDN_CHANGED when content no longer matches the lock', async () => {
    server = await startServer({ '/a.js': { body: 'new', type: 'text/javascript' } });
    await expect(fetchRemote(testCtx(makeTmpDir()), `${server.base}/a.js`, sha('old'))).rejects.toMatchObject({
      error: { code: 'CDN_CHANGED' },
    });
  });
});
