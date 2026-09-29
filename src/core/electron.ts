import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { GsFailure } from './result.js';

const require = createRequire(import.meta.url);

/** The Electron version every build uses; bump only after the weekly canary passes (Plan 6). */
export const ELECTRON_VERSION: string = (require('electron/package.json') as { version: string }).version;

function binaryInstalled(pkgDir: string): boolean {
  const pathFile = path.join(pkgDir, 'path.txt');
  return fs.existsSync(pathFile) && fs.existsSync(path.join(pkgDir, 'dist', fs.readFileSync(pathFile, 'utf8')));
}

/**
 * Path to the Electron binary installed with this package (used by `play`).
 * Electron 44 downloads its binary lazily on first require and prints progress to stdout,
 * which would corrupt `--json` output, so we run its installer ourselves with output captured.
 */
export function electronBinary(): string {
  const pkgDir = path.dirname(require.resolve('electron/package.json'));
  if (!binaryInstalled(pkgDir)) {
    const r = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0 || !binaryInstalled(pkgDir)) {
      throw new GsFailure(
        'ELECTRON_INSTALL_FAILED',
        `Couldn't download Electron ${ELECTRON_VERSION}: ${(r.stderr || r.stdout || 'unknown error').trim()}`,
        'Check your internet connection, then re-run. Or run `npx install-electron --no` in the Gameshipper folder.',
      );
    }
  }
  return require('electron') as string;
}
