import * as fs from 'node:fs';
import * as path from 'node:path';
import { GsFailure } from '../result.js';

export const LOCK_FILE = 'gameshipper.lock';

export interface LockEntry {
  path: string;
  sha256: string;
}

export interface Lockfile {
  version: 1;
  files: Record<string, LockEntry>;
}

export function lockExists(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, LOCK_FILE));
}

export function readLock(projectDir: string): Lockfile {
  const file = path.join(projectDir, LOCK_FILE);
  if (!fs.existsSync(file)) return { version: 1, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Lockfile;
    if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch {
    // fall through to the error below
  }
  throw new GsFailure('LOCK_INVALID', 'gameshipper.lock is damaged.', 'Delete gameshipper.lock and rebuild; it is recreated from the current CDN files.');
}

export function writeLock(projectDir: string, lock: Lockfile): void {
  const files = Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(projectDir, LOCK_FILE), `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
}
