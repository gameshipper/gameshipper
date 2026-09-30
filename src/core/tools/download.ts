import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { moveIntoCache } from '../cache.js';
import type { Ctx } from '../context.js';
import { GsFailure } from '../result.js';
import { withoutSecrets } from './run.js';
import { unzipTo } from './zip.js';

/** A vendor's archive, pinned by URL and SHA-256 (the cache keeps checksums). */
export interface ToolArchive {
  url: string;
  sha256: string;
  format: 'zip' | 'tar.gz';
}

/** Which archive an install folder holds. Kept inside the folder, so it moves (and goes) with it. */
const RECORD = '.gameshipper-archive.json';
/** A tool is 2-11 MB; this only stops a download that stalls. */
export const TOOL_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Far more than any tool; a download past it isn't the tool (and would fill the memory it's read into). */
export const TOOL_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
/** Apple's tar by its full path on a Mac; elsewhere the system's own, which may be in /bin or /usr/bin. */
const TAR = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';

const size = (bytes: number) => (bytes >= 1 << 20 ? `${Math.round(bytes / (1 << 20))} MB` : `${bytes} bytes`);

/** The whole body, or an Error once it's larger than maxBytes (as it says, or as it arrives). */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new Error(`it's larger than ${size(maxBytes)}`);
  if (!res.body) return Buffer.alloc(0);
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body.cancel();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    // Leaving the loop early cancels the rest of the download.
    if (total > maxBytes) throw tooLarge();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** True when installDir holds exactly this archive and `executable` (relative to it) is still there. */
export function isInstalled(installDir: string, archive: ToolArchive, executable: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(installDir, RECORD), 'utf8')) as { sha256?: unknown };
    return record.sha256 === archive.sha256 && fs.existsSync(path.join(installDir, executable));
  } catch {
    return false;
  }
}

/** fetch only says "fetch failed"; its cause says why (ENOTFOUND, ECONNREFUSED, a timeout). */
function why(e: unknown): string {
  const err = e as (Error & { cause?: unknown }) | undefined;
  const cause = err?.cause as (Error & { code?: unknown }) | undefined;
  if (err?.name === 'TimeoutError' || cause?.name === 'TimeoutError') return `it didn't finish in ${TOOL_DOWNLOAD_TIMEOUT_MS / 60_000} minutes`;
  return `${err?.message ?? String(e)}${typeof cause?.code === 'string' ? ` (${cause.code})` : ''}`;
}

/**
 * Downloads a pinned archive (at most TOOL_DOWNLOAD_MAX_BYTES, or `maxBytes`), checks its SHA-256 and unpacks it into
 * installDir: zips with Gameshipper's own reader, .tar.gz (macOS and Linux only) with the system tar, which keeps links
 * and modes and refuses entries that would land outside the folder. It's unpacked beside installDir
 * and then moved into place, so an interrupted install never looks complete. `executable` (relative to installDir)
 * must be in it. Throws GsFailure: TOOL_DOWNLOAD_FAILED or TOOL_CHECKSUM_MISMATCH.
 */
export async function installArchive(
  ctx: Ctx,
  name: string,
  archive: ToolArchive,
  installDir: string,
  executable: string,
  opts: { maxBytes?: number } = {},
): Promise<void> {
  ctx.log(`downloading ${name} from ${archive.url}`);
  let body: Buffer;
  try {
    const res = await fetch(archive.url, { signal: AbortSignal.timeout(TOOL_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await readCapped(res, opts.maxBytes ?? TOOL_DOWNLOAD_MAX_BYTES);
  } catch (e) {
    throw new GsFailure('TOOL_DOWNLOAD_FAILED', `Couldn't download ${name} from ${archive.url}: ${why(e)}.`, 'Check your internet connection, then run the command again.');
  }
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== archive.sha256) {
    throw new GsFailure(
      'TOOL_CHECKSUM_MISMATCH',
      `The ${name} download from ${archive.url} isn't the file Gameshipper expects (SHA-256 ${got}, expected ${archive.sha256}).`,
      'Run the command again in case the download was damaged. If it keeps happening, the vendor replaced the file: update Gameshipper (`npx gameshipper@latest`) or report it.',
    );
  }
  const parent = path.dirname(installDir);
  let tmp: string | null = null;
  try {
    fs.mkdirSync(parent, { recursive: true });
    tmp = fs.mkdtempSync(path.join(parent, `.${path.basename(installDir)}-`));
    if (archive.format === 'zip') {
      unzipTo(body, tmp);
    } else {
      const file = `${tmp}.tar.gz`;
      fs.writeFileSync(file, body);
      try {
        // Like every tool Gameshipper runs, tar never gets the GitHub token, butler's key or the Apple variables.
        const r = spawnSync(TAR, ['-xzf', file, '-C', tmp], { encoding: 'utf8', env: withoutSecrets(process.env) });
        if (r.status !== 0) throw new Error((r.stderr || r.error?.message || 'tar failed').trim());
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    if (!fs.existsSync(path.join(tmp, executable))) throw new Error(`it has no ${executable}`);
    fs.writeFileSync(path.join(tmp, RECORD), `${JSON.stringify({ url: archive.url, sha256: archive.sha256 }, null, 2)}\n`);
    moveIntoCache(tmp, installDir, (dir) => isInstalled(dir, archive, executable));
  } catch (e) {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    throw new GsFailure(
      'TOOL_DOWNLOAD_FAILED',
      `Couldn't unpack ${name} into ${installDir}: ${e instanceof Error ? e.message : String(e)}`,
      "Free up disk space and check that Gameshipper's cache folder is writable (GAMESHIPPER_CACHE sets another), then run the command again.",
    );
  }
  ctx.log(`installed ${name} → ${installDir}`);
}
