import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { electronBinary } from '../../src/core/electron.js';
import { makeTmpDir } from '../helpers/tmp.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (check()) return true;
  }
  return check();
}

/**
 * An electron package folder whose install.js runs `installer` (CommonJS) instead of downloading Electron. Installers
 * here fail with process.exitCode, never process.exit(): with NODE_USE_SYSTEM_CA=1 Node 24.7 can crash exiting early.
 */
function fakeElectronPackage(installer: string): string {
  const pkgDir = makeTmpDir();
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0-test' }));
  fs.writeFileSync(path.join(pkgDir, 'install.js'), installer);
  return pkgDir;
}

/** What Electron's installer leaves behind: the binary under dist/, named in path.txt. */
const INSTALLS = `
  const fs = require('fs');
  const path = require('path');
  setTimeout(() => {
    fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'dist', 'electron'), '');
    fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron');
  }, 300);
`;

describe('electronBinary', () => {
  it("downloads Electron's binary the first time without blocking Gameshipper, and returns its path", async () => {
    const pkgDir = fakeElectronPackage(INSTALLS);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      expect(await electronBinary({ pkgDir })).toBe(path.join(pkgDir, 'dist', 'electron'));
    } finally {
      clearInterval(timer);
    }
    // Signals and timers are handled during the download.
    expect(ticks).toBeGreaterThan(5);
    // Installed now: no second download.
    fs.writeFileSync(path.join(pkgDir, 'install.js'), 'process.exitCode = 1;');
    expect(await electronBinary({ pkgDir })).toBe(path.join(pkgDir, 'dist', 'electron'));
  });

  it("ELECTRON_INSTALL_FAILED with the installer's last output when the download fails", async () => {
    const pkgDir = fakeElectronPackage("console.error('RequestError: getaddrinfo ENOTFOUND github.com'); process.exitCode = 1;");
    await expect(electronBinary({ pkgDir })).rejects.toMatchObject({
      error: { code: 'ELECTRON_INSTALL_FAILED', message: expect.stringContaining('ENOTFOUND github.com'), fix: expect.stringContaining('internet') },
    });
  });

  it.skipIf(process.platform === 'win32')('stopping Gameshipper stops the download, with everything it started', async () => {
    const pidFile = path.join(makeTmpDir(), 'installer.pid');
    const pkgDir = fakeElectronPackage(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const cli = vi.fn();
    process.on('SIGTERM', cli);
    try {
      const installing = electronBinary({ pkgDir });
      expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      // Delivers the event to the listeners without a real signal; `cli` stands in for the CLI's own handler.
      process.emit('SIGTERM', 'SIGTERM');
      await expect(installing).rejects.toMatchObject({ error: { code: 'ELECTRON_INSTALL_FAILED' } });
      expect(await waitFor(() => !alive(pid))).toBe(true);
    } finally {
      process.off('SIGTERM', cli);
    }
  });
});
