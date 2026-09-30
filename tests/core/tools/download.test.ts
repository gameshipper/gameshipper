import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installArchive, isInstalled, type ToolArchive } from '../../../src/core/tools/download.js';
import { writeZip } from '../../../src/core/tools/zip.js';
import { testCtx } from '../../helpers/ctx.js';
import { refusedUrl, startServer, type TestServer } from '../../helpers/server.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A zip like butler's: an executable and a library. */
function toolZip(): Buffer {
  const src = makeTmpDir();
  writeFiles(src, { 'lib/7z.so': 'so' });
  fs.writeFileSync(path.join(src, 'run'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const file = path.join(makeTmpDir(), 't.zip');
  writeZip(src, file);
  return fs.readFileSync(file);
}

describe('installArchive', () => {
  it('downloads, checks and unpacks a zip, then knows it is installed', async () => {
    const body = toolZip();
    server = await startServer({ '/t.zip': { body } });
    const archive: ToolArchive = { url: `${server.base}/t.zip`, sha256: sha(body), format: 'zip' };
    const installDir = path.join(makeTmpDir(), 'tools', 'thing', '1.0');
    expect(isInstalled(installDir, archive, 'run')).toBe(false);
    await installArchive(testCtx(makeTmpDir()), 'Thing', archive, installDir, 'run');
    expect(fs.readFileSync(path.join(installDir, 'lib', '7z.so'), 'utf8')).toBe('so');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(installDir, 'run')).mode & 0o111).not.toBe(0);
    expect(isInstalled(installDir, archive, 'run')).toBe(true);
    expect(isInstalled(installDir, { ...archive, sha256: 'another' }, 'run')).toBe(false);
    // Nothing is left beside it.
    expect(fs.readdirSync(path.dirname(installDir))).toEqual(['1.0']);
    fs.rmSync(path.join(installDir, 'run'));
    expect(isInstalled(installDir, archive, 'run')).toBe(false);
  });

  it('replaces a damaged install', async () => {
    const body = toolZip();
    server = await startServer({ '/t.zip': { body } });
    const archive: ToolArchive = { url: `${server.base}/t.zip`, sha256: sha(body), format: 'zip' };
    const installDir = path.join(makeTmpDir(), 'thing');
    writeFiles(installDir, { 'half-written': 'x' });
    await installArchive(testCtx(makeTmpDir()), 'Thing', archive, installDir, 'run');
    expect(fs.existsSync(path.join(installDir, 'half-written'))).toBe(false);
    expect(isInstalled(installDir, archive, 'run')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('unpacks a tar.gz with the system tar, links included', async () => {
    const src = makeTmpDir();
    writeFiles(src, { 'steamcmd.sh': '#!/bin/sh\n', 'Frameworks/B.framework/Versions/A/B': 'lib' });
    fs.symlinkSync('A', path.join(src, 'Frameworks', 'B.framework', 'Versions', 'Current'));
    const tgz = path.join(makeTmpDir(), 's.tar.gz');
    expect(spawnSync('tar', ['-czf', tgz, '-C', src, '.']).status).toBe(0);
    const body = fs.readFileSync(tgz);
    server = await startServer({ '/s.tar.gz': { body } });
    const installDir = path.join(makeTmpDir(), 'steamcmd', 'app');
    await installArchive(testCtx(makeTmpDir()), 'SteamCMD', { url: `${server.base}/s.tar.gz`, sha256: sha(body), format: 'tar.gz' }, installDir, 'steamcmd.sh');
    expect(fs.readlinkSync(path.join(installDir, 'Frameworks', 'B.framework', 'Versions', 'Current'))).toBe('A');
  });

  it('TOOL_CHECKSUM_MISMATCH when the download is not the pinned file', async () => {
    server = await startServer({ '/t.zip': { body: 'tampered' } });
    const archive: ToolArchive = { url: `${server.base}/t.zip`, sha256: sha(Buffer.from('original')), format: 'zip' };
    const installDir = path.join(makeTmpDir(), 'thing');
    await expect(installArchive(testCtx(makeTmpDir()), 'Thing', archive, installDir, 'run')).rejects.toMatchObject({
      error: { code: 'TOOL_CHECKSUM_MISMATCH', message: expect.stringContaining(sha(Buffer.from('tampered'))) },
    });
    expect(fs.existsSync(installDir)).toBe(false);
  });

  it('TOOL_DOWNLOAD_FAILED on an HTTP error, a dead server and an archive that is not one', async () => {
    server = await startServer({ '/bad.zip': { body: 'not a zip' } });
    const ctx = testCtx(makeTmpDir());
    const dir = path.join(makeTmpDir(), 'thing');
    await expect(installArchive(ctx, 'Thing', { url: `${server.base}/missing.zip`, sha256: 'x', format: 'zip' }, dir, 'run')).rejects.toMatchObject({
      error: { code: 'TOOL_DOWNLOAD_FAILED', message: expect.stringContaining('HTTP 404') },
    });
    await expect(installArchive(ctx, 'Thing', { url: `${await refusedUrl()}/t.zip`, sha256: 'x', format: 'zip' }, dir, 'run')).rejects.toMatchObject({
      error: { code: 'TOOL_DOWNLOAD_FAILED', message: expect.stringContaining('ECONNREFUSED') },
    });
    const bad = { url: `${server.base}/bad.zip`, sha256: sha(Buffer.from('not a zip')), format: 'zip' as const };
    await expect(installArchive(ctx, 'Thing', bad, dir, 'run')).rejects.toMatchObject({
      error: { code: 'TOOL_DOWNLOAD_FAILED', message: expect.stringContaining("isn't a ZIP file") },
    });
    expect(fs.existsSync(dir)).toBe(false);
  });
});
