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

export const FETCH_TIMEOUT_MS = 60_000;

export interface FetchOptions {
  /** Give up on one download after this many milliseconds (default 60 s). */
  timeoutMs?: number;
}

/** CDN_FETCH_FAILED, with the HTTP status when the server answered and null when the download itself failed. */
export class FetchFailure extends GsFailure {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super('CDN_FETCH_FAILED', message, FETCH_FIX);
    this.status = status;
  }
}

function downloadFailed(url: string, e: unknown, timeoutMs: number): FetchFailure {
  const err = e as (Error & { cause?: unknown }) | undefined;
  const cause = err?.cause as (Error & { code?: unknown }) | undefined;
  const timedOut = err?.name === 'TimeoutError' || cause?.name === 'TimeoutError';
  let reason = timedOut ? `timed out after ${timeoutMs / 1000}s` : (err?.message ?? String(e));
  // fetch only says "fetch failed"; the cause says why (ENOTFOUND, ECONNREFUSED, ECONNRESET, ...).
  if (!timedOut && typeof cause?.code === 'string') reason += ` (${cause.code})`;
  return new FetchFailure(`Couldn't download ${url}: ${reason}`, null);
}

/**
 * Returns the cached copy of `url` when it matches `expectedSha` (any cached copy when that is null),
 * otherwise downloads it. The result can differ from `expectedSha`; the caller decides what that means.
 */
export async function fetchRemote(ctx: Ctx, url: string, expectedSha: string | null, opts: FetchOptions = {}): Promise<Fetched> {
  const dir = path.join(ctx.cacheDir, 'cdn');
  const key = sha256(url);
  const cached = readCached(dir, key);
  if (cached && (expectedSha === null || cached.sha256 === expectedSha)) return cached;

  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': FETCH_USER_AGENT }, signal });
  } catch (e) {
    throw downloadFailed(url, e, timeoutMs);
  }
  if (!res.ok) throw new FetchFailure(`Couldn't download ${url} (HTTP ${res.status}).`, res.status);
  let body: Buffer;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw downloadFailed(url, e, timeoutMs); // the body stalled or the connection dropped
  }
  const got: Fetched = { url, finalUrl: res.url || url, body, contentType: res.headers.get('content-type'), sha256: sha256(body) };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.bin`), body);
  const meta: CacheMeta = { url, finalUrl: got.finalUrl, contentType: got.contentType, sha256: got.sha256 };
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(meta));
  ctx.log(`downloaded ${url} (${body.length} bytes)`);
  return got;
}
