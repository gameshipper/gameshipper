import * as fs from 'node:fs';
import * as path from 'node:path';
import { gsError, type GsError } from './result.js';

/** All files under root, as sorted posix-style relative paths. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * DIR_MISSING when the game folder (usually from --dir) doesn't exist or isn't a folder. Commands check
 * this before writing anything, so a typo never creates a stray .gameshipper folder.
 */
export function checkProjectDir(dir: string): GsError | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return gsError('DIR_MISSING', `The folder ${dir} doesn't exist.`, 'Check the path, or run the command from your game folder.');
  }
  return stat.isDirectory() ? null : gsError('DIR_MISSING', `${dir} isn't a folder.`, 'Check the path, or run the command from your game folder.');
}
