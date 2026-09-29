import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function cacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.GAMESHIPPER_CACHE) return env.GAMESHIPPER_CACHE;
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'gameshipper');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'gameshipper', 'Cache');
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'gameshipper');
}

/**
 * Moves a finished download or extraction (`tmp`, a folder next to `dir`) to its place in the cache.
 * Two builds can fill the same cache entry at once: when `dir` is already complete, the other build
 * won, so its copy is kept and `tmp` is discarded. An incomplete `dir` (an interrupted earlier run) is
 * replaced. `tmp` is removed afterwards (best effort: a leftover dot-named temp folder is harmless).
 */
export function moveIntoCache(tmp: string, dir: string, complete: (dir: string) => boolean): void {
  try {
    if (!complete(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    }
  } catch (e) {
    // Another build may have moved its own copy in between.
    if (!complete(dir)) throw e;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Never hide the real outcome behind a cleanup error.
    }
  }
}
