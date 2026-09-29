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
