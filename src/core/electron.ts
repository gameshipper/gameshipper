import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { OUTPUT_BUFFER_CHARS, outputTail, stopWithGameshipper } from './proc.js';
import { GsFailure } from './result.js';

const require = createRequire(import.meta.url);

/** The Electron version every build uses; bump only after the weekly canary passes (Plan 6). */
export const ELECTRON_VERSION: string = (require('electron/package.json') as { version: string }).version;

function binaryInstalled(pkgDir: string): boolean {
  const pathFile = path.join(pkgDir, 'path.txt');
  return fs.existsSync(pathFile) && fs.existsSync(path.join(pkgDir, 'dist', fs.readFileSync(pathFile, 'utf8')));
}

/**
 * Runs Electron's installer, which downloads its binary. Asynchronous, so Gameshipper still handles signals during
 * a slow download; the installer leads its own process group on POSIX, so stopping Gameshipper stops it too.
 */
function runInstaller(pkgDir: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(pkgDir, 'install.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let output = '';
    const onData = (text: string): void => {
      output = (output + text).slice(-OUTPUT_BUFFER_CHARS);
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    const detach = stopWithGameshipper(child);
    child.on('error', (e) => {
      detach();
      resolve({ code: null, signal: null, output: e.message });
    });
    child.on('close', (code, signal) => {
      detach();
      resolve({ code, signal, output });
    });
  });
}

/**
 * Path to the Electron binary installed with this package (used by `play`), downloading it the first time.
 * Electron 44 downloads its binary lazily on first require and prints progress to stdout,
 * which would corrupt `--json` output, so we run its installer ourselves with output captured.
 * `pkgDir` replaces the installed electron package (tests).
 */
export async function electronBinary(opts: { pkgDir?: string } = {}): Promise<string> {
  const pkgDir = opts.pkgDir ?? path.dirname(require.resolve('electron/package.json'));
  if (!binaryInstalled(pkgDir)) {
    const r = await runInstaller(pkgDir);
    if (r.code !== 0 || !binaryInstalled(pkgDir)) {
      const why = outputTail(r.output) || (r.signal ? `the download was stopped (${r.signal})` : 'unknown error');
      throw new GsFailure(
        'ELECTRON_INSTALL_FAILED',
        `Couldn't download Electron ${ELECTRON_VERSION}: ${why}`,
        'Check your internet connection, then re-run. Or run `npx install-electron --no` in the Gameshipper folder.',
      );
    }
  }
  if (opts.pkgDir) return path.join(pkgDir, 'dist', fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8'));
  return require('electron') as string;
}
