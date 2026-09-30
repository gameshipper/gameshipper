import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { signMacApp } from '../../../src/core/sign/sign.js';
import { readZipEntries } from '../../../src/core/steam/zip.js';
import { DITTO, unzipTo, writeZip, zipFolder } from '../../../src/core/tools/zip.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeMiniApp } from '../../helpers/mac-bundle.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';
import { makeZip } from '../../helpers/zip.js';

const posix = process.platform !== 'win32';
const mac = process.platform === 'darwin';
const hasUnzip = posix && spawnSync('unzip', ['-v']).status === 0;

/** A folder shaped like out/mac: an app with a framework symlink, an executable, an empty folder and a license file. */
function buildFolder(): string {
  const dir = makeTmpDir();
  writeFiles(dir, { LICENSE: 'MIT', 'Moon Game.app/Contents/Frameworks/X.framework/Versions/A/X': 'lib' });
  fs.mkdirSync(path.join(dir, 'Moon Game.app', 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Moon Game.app', 'Contents', 'MacOS', 'Moon Game'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'Moon Game.app', 'Contents', 'Empty'));
  if (posix) fs.symlinkSync('A', path.join(dir, 'Moon Game.app', 'Contents', 'Frameworks', 'X.framework', 'Versions', 'Current'));
  return dir;
}

const modes = (zipFile: string) => Object.fromEntries(readZipEntries(fs.readFileSync(zipFile)).map((e) => [e.name, e.unixMode]));
const verifies = (app: string) => spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });

describe('writeZip', () => {
  it('puts the folder’s contents at the top, keeping executables, symlinks and empty folders', () => {
    const zipFile = path.join(makeTmpDir(), 'release', 'moon-game-1.0.0-mac.zip');
    expect(writeZip(buildFolder(), zipFile).entries).toBe(posix ? 12 : 11);
    const found = modes(zipFile);
    expect(found['LICENSE']).toBeDefined();
    expect(found['Moon Game.app/Contents/Empty/']).toBeDefined();
    if (posix) {
      expect(found['Moon Game.app/Contents/MacOS/Moon Game']! & 0o777).toBe(0o755);
      expect(found['Moon Game.app/Contents/Frameworks/X.framework/Versions/Current']! & 0o170000).toBe(0o120000);
    }
  });

  it('on Windows, where files have no modes, marks Linux executables and scripts executable', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'moon-game': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), 'run.sh': '#!/bin/sh\n', 'resources.pak': 'data' });
    const zipFile = path.join(makeTmpDir(), 'linux.zip');
    writeZip(dir, zipFile, { platform: 'win32' });
    const found = modes(zipFile);
    expect([found['moon-game']! & 0o777, found['run.sh']! & 0o777, found['resources.pak']! & 0o777]).toEqual([0o755, 0o755, 0o644]);
  });

  it.skipIf(!hasUnzip)('unzips with the system unzip, links and modes intact', () => {
    const tmp = makeTmpDir();
    writeZip(buildFolder(), path.join(tmp, 'a.zip'));
    expect(spawnSync('unzip', ['-q', path.join(tmp, 'a.zip'), '-d', path.join(tmp, 'x')]).status).toBe(0);
    const app = path.join(tmp, 'x', 'Moon Game.app', 'Contents');
    expect(fs.readlinkSync(path.join(app, 'Frameworks', 'X.framework', 'Versions', 'Current'))).toBe('A');
    expect(fs.statSync(path.join(app, 'MacOS', 'Moon Game')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(app, 'Empty'))).toBe(true);
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (check()) return true;
  }
  return check();
}

describe.skipIf(!posix)('zipFolder with ditto, stopped with Gameshipper', () => {
  it("runs Apple's own ditto, never one found on PATH", () => {
    expect(DITTO).toBe('/usr/bin/ditto');
  });

  it('stops a slow ditto on Ctrl+C (or SIGTERM, or an MCP cancel), and leaves no half-written zip', async () => {
    const tmp = makeTmpDir();
    const pidFile = path.join(tmp, 'ditto.pid');
    // A ditto that starts writing the zip (its last argument), then never finishes.
    const fake = path.join(tmp, 'ditto.mjs');
    fs.writeFileSync(
      fake,
      `import * as fs from 'node:fs';
       fs.writeFileSync(process.argv.at(-1), 'PK');
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       setInterval(() => {}, 1000);`,
    );
    const zipFile = path.join(tmp, 'release', 'mac.zip');
    const cli = vi.fn();
    process.on('SIGINT', cli);
    try {
      const zipping = zipFolder(buildFolder(), zipFile, { platform: 'darwin', ditto: fake });
      const settled = zipping.then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      expect(await waitFor(() => fs.existsSync(pidFile))).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      // Delivers the event to the listeners without a real signal; `cli` stands in for the CLI's own handler.
      process.emit('SIGINT', 'SIGINT');
      expect(await settled).toBe('ditto failed: it was stopped');
      expect(await waitFor(() => !alive(pid))).toBe(true);
      expect(fs.existsSync(zipFile)).toBe(false);
      expect(cli).toHaveBeenCalledTimes(1);
    } finally {
      process.off('SIGINT', cli);
    }
  });
});

describe.runIf(mac)('zipFolder on a Mac (ditto)', () => {
  it('leaves out extended attributes, so no ._ files appear when someone unzips it with unzip', async () => {
    const dir = buildFolder();
    expect(spawnSync('xattr', ['-w', 'com.gameshipper.test', 'x', path.join(dir, 'LICENSE')]).status).toBe(0);
    const zipFile = path.join(makeTmpDir(), 'mac.zip');
    await zipFolder(dir, zipFile);
    const names = readZipEntries(fs.readFileSync(zipFile)).map((e) => e.name);
    expect(names).toContain('LICENSE');
    expect(names.filter((n) => /(^|\/)\._|__MACOSX/.test(n))).toEqual([]);
    expect(modes(zipFile)['Moon Game.app/Contents/Frameworks/X.framework/Versions/Current']! & 0o170000).toBe(0o120000);
  });

  it('a signed app still verifies after unzipping with ditto or unzip, from zipFolder and from writeZip', async () => {
    const dir = makeTmpDir('gs-zip-sign-');
    const app = makeMiniApp(dir);
    await signMacApp(testCtx(dir), app, null);
    expect(verifies(app).status).toBe(0);
    for (const [how, make] of [
      ['ditto', (zipFile: string) => zipFolder(dir, zipFile)],
      ['writeZip', async (zipFile: string) => void writeZip(dir, zipFile)],
    ] as const) {
      const tmp = makeTmpDir();
      const zipFile = path.join(tmp, 'mini.zip');
      await make(zipFile);
      expect(spawnSync('ditto', ['-x', '-k', zipFile, path.join(tmp, 'ditto')]).status).toBe(0);
      expect(spawnSync('unzip', ['-q', zipFile, '-d', path.join(tmp, 'unzip')]).status).toBe(0);
      for (const out of ['ditto', 'unzip']) {
        const r = verifies(path.join(tmp, out, 'Mini.app'));
        expect(r.status, `${how} → ${out}: ${r.stderr}`).toBe(0);
      }
    }
  });
});

describe('unzipTo', () => {
  it('unpacks files with their modes', () => {
    const src = makeTmpDir();
    writeFiles(src, { 'lib/7z.so': 'so' });
    fs.writeFileSync(path.join(src, 'butler'), '#!/bin/sh\n', { mode: 0o755 });
    const tmp = makeTmpDir();
    writeZip(src, path.join(tmp, 'b.zip'));
    unzipTo(fs.readFileSync(path.join(tmp, 'b.zip')), path.join(tmp, 'out'));
    expect(fs.readFileSync(path.join(tmp, 'out', 'lib', '7z.so'), 'utf8')).toBe('so');
    if (posix) expect(fs.statSync(path.join(tmp, 'out', 'butler')).mode & 0o777).toBe(0o755);
  });

  it.skipIf(!posix)('refuses a symbolic link, which would otherwise be written as a file (or point anywhere)', () => {
    const src = makeTmpDir();
    writeFiles(src, { butler: '#!/bin/sh\n' });
    fs.symlinkSync('/etc/passwd', path.join(src, 'link'));
    const tmp = makeTmpDir();
    writeZip(src, path.join(tmp, 'b.zip'));
    expect(() => unzipTo(fs.readFileSync(path.join(tmp, 'b.zip')), path.join(tmp, 'out'))).toThrow('link is a symbolic link');
    expect(fs.existsSync(path.join(tmp, 'out', 'link'))).toBe(false);
  });

  it('refuses entries that would land outside the folder, and files that are not zips', () => {
    const out = path.join(makeTmpDir(), 'out');
    expect(() => unzipTo(makeZip({ '../evil.txt': 'x' }), out)).toThrow('outside');
    expect(() => unzipTo(Buffer.from('nope'), out)).toThrow("isn't a ZIP file");
  });
});
