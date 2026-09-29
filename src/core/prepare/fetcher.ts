import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx } from '../context.js';
import { GsFailure } from '../result.js';

/** Some CDNs (Google Fonts) vary their response by browser; ask as desktop Chrome would. */
export const FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface Fetched {
  url: string;
  finalUrl: string;
  body: Buffer;
  contentType: string | null;
  sha256: string;
}

interface CacheMeta {
  url: string;
  finalUrl: string;
  contentType: string | null;
  sha256: string;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

const FETCH_FIX =
  'Check your internet connection. If the URL is wrong, fix it in your game; or download the file into your game folder and load it from there.';

function readCached(dir: string, key: string): Fetched | null {
  const metaFile = path.join(dir, `${key}.json`);
  const bodyFile = path.join(dir, `${key}.bin`);
  if (!fs.existsSync(metaFile) || !fs.existsSync(bodyFile)) return null;
  let meta: CacheMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as CacheMeta;
  } catch {
    return null; // corrupted: re-download
  }
  const body = fs.readFileSync(bodyFile);
  if (sha256(body) !== meta?.sha256) return null; // corrupted: re-download
  return { ...meta, body };
}

export async function fetchRemote(ctx: Ctx, url: string, expectedSha: string | null): Promise<Fetched> {
  const dir = path.join(ctx.cacheDir, 'cdn');
  const key = sha256(url);
  const cached = readCached(dir, key);
  if (cached && (expectedSha === null || cached.sha256 === expectedSha)) return cached;

  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': FETCH_USER_AGENT } });
  } catch (e) {
    throw new GsFailure('CDN_FETCH_FAILED', `Couldn't download ${url}: ${(e as Error).message}`, FETCH_FIX);
  }
  if (!res.ok) throw new GsFailure('CDN_FETCH_FAILED', `Couldn't download ${url} (HTTP ${res.status}).`, FETCH_FIX);
  const body = Buffer.from(await res.arrayBuffer());
  const got: Fetched = { url, finalUrl: res.url || url, body, contentType: res.headers.get('content-type'), sha256: sha256(body) };
  if (expectedSha !== null && got.sha256 !== expectedSha) {
    throw new GsFailure(
      'CDN_CHANGED',
      `${url} has changed since it was recorded in gameshipper.lock.`,
      'If you meant to update it, delete its entry from gameshipper.lock and rebuild. Otherwise pin a fixed version in the URL (e.g. three@0.170.0).',
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.bin`), body);
  const meta: CacheMeta = { url, finalUrl: got.finalUrl, contentType: got.contentType, sha256: got.sha256 };
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(meta));
  ctx.log(`downloaded ${url} (${body.length} bytes)`);
  return got;
}
