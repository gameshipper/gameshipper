import * as path from 'node:path';

/** Path segments for an app://game/... request, or null if it tries to leave the game folder. */
export function requestParts(requestUrl: string): string[] | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const parts = pathname.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || p.includes('\\') || p.includes('\0'))) return null;
  return parts;
}

export function resolveGamePath(gameRoot: string, requestUrl: string): string | null {
  const parts = requestParts(requestUrl);
  return parts ? path.join(gameRoot, ...parts) : null;
}

/**
 * If `parts` names an existing file only when letter case is ignored, return the real
 * (correctly cased) relative path. Such paths work on Windows/macOS but 404 on Linux/Steam Deck.
 */
export function caseMismatch(gameRoot: string, parts: string[], listDir: (dir: string) => string[]): string | null {
  let dir = gameRoot;
  const actual: string[] = [];
  for (const part of parts) {
    let entries: string[];
    try {
      entries = listDir(dir);
    } catch {
      return null;
    }
    const match = entries.includes(part) ? part : entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!match) return null;
    actual.push(match);
    dir = path.join(dir, match);
  }
  const real = actual.join('/');
  return real === parts.join('/') ? null : real;
}

/**
 * The game's userData folder, where saves live. Play runs pass GAMESHIPPER_USER_DATA to keep them in the
 * project; otherwise it's named after the file-safe productName, since the display name may not be a
 * valid folder name ("Moon: Rising" on Windows).
 */
export function userDataDir(env: NodeJS.ProcessEnv, appDataDir: string, productName: string): string {
  return env.GAMESHIPPER_USER_DATA || path.join(appDataDir, productName);
}
