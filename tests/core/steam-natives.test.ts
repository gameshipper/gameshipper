import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureKoffiNative,
  installedKoffiNative,
  KOFFI_VERSION,
  koffiDir,
  nativeIds,
  packageIgnore,
  sdkTargetFor,
} from '../../src/core/steam/natives.js';
import { testCtx } from '../helpers/ctx.js';
import { startServer, type TestServer } from '../helpers/server.js';
import { makeTgz } from '../helpers/tgz.js';
import { makeTmpDir } from '../helpers/tmp.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('native ids', () => {
  it('maps packaging jobs to koffi packages and Steam libraries', () => {
    expect(nativeIds({ platform: 'darwin', arch: 'universal' })).toEqual(['darwin-arm64', 'darwin-x64']);
    expect(nativeIds({ platform: 'win32', arch: 'x64' })).toEqual(['win32-x64']);
    expect([sdkTargetFor('win32'), sdkTargetFor('darwin'), sdkTargetFor('linux'), sdkTargetFor('freebsd')]).toEqual(['windows', 'mac', 'linux', null]);
  });

  it('pins the koffi version that is installed', () => {
    const installed = JSON.parse(fs.readFileSync(path.join(koffiDir(), 'package.json'), 'utf8')) as { version: string };
    expect(installed.version).toBe(KOFFI_VERSION);
    expect(installedKoffiNative(`${process.platform}-${process.arch}`)).not.toBeNull();
  });
});

describe('ensureKoffiNative', () => {
  const tgz = makeTgz({ 'package/package.json': '{"name":"@koromix/koffi-win32-x64"}', 'package/win32_x64/koffi.node': 'native' });
  const pins = { 'win32-x64': `sha512-${createHash('sha512').update(tgz).digest('base64')}` };
  const route = `/@koromix/koffi-win32-x64/-/koffi-win32-x64-${KOFFI_VERSION}.tgz`;

  it('downloads, checks and caches a native package', async () => {
    server = await startServer({ [route]: { body: tgz } });
    const ctx = testCtx(makeTmpDir());
    const dir = await ensureKoffiNative(ctx, 'win32-x64', { registry: server.base, pins, installed: () => null });
    expect(dir).toBe(path.join(ctx.cacheDir, 'koffi', KOFFI_VERSION, 'win32-x64'));
    expect(fs.readFileSync(path.join(dir, 'win32_x64', 'koffi.node'), 'utf8')).toBe('native');
    await server.close();
    server = undefined;
    expect(await ensureKoffiNative(ctx, 'win32-x64', { registry: 'http://127.0.0.1:9', pins, installed: () => null })).toBe(dir);
  });

  it('uses the package npm installed for this computer', async () => {
    const ctx = testCtx(makeTmpDir());
    expect(await ensureKoffiNative(ctx, 'win32-x64', { installed: () => '/installed/koffi-win32-x64' })).toBe('/installed/koffi-win32-x64');
  });

  it('STEAM_NATIVE_DOWNLOAD_FAILED on a bad checksum, an HTTP error or a download that hangs', async () => {
    server = await startServer({ [route]: { body: Buffer.from('tampered') } });
    const opts = { registry: server.base, pins, installed: () => null };
    await expect(ensureKoffiNative(testCtx(makeTmpDir()), 'win32-x64', opts)).rejects.toMatchObject({
      error: { code: 'STEAM_NATIVE_DOWNLOAD_FAILED', message: expect.stringContaining("checksum doesn't match") },
    });
    server.routes[route] = { status: 404 };
    await expect(ensureKoffiNative(testCtx(makeTmpDir()), 'win32-x64', opts)).rejects.toMatchObject({
      error: { code: 'STEAM_NATIVE_DOWNLOAD_FAILED', message: expect.stringContaining('HTTP 404') },
    });
    server.routes[route] = { hang: true };
    await expect(ensureKoffiNative(testCtx(makeTmpDir()), 'win32-x64', { ...opts, timeoutMs: 200 })).rejects.toMatchObject({
      error: { code: 'STEAM_NATIVE_DOWNLOAD_FAILED', message: expect.stringContaining('timed out') },
    });
  });

  it('STEAM_UNSUPPORTED_PLATFORM for an id with no pinned package', async () => {
    await expect(ensureKoffiNative(testCtx(makeTmpDir()), 'freebsd-x64', { installed: () => null })).rejects.toMatchObject({
      error: { code: 'STEAM_UNSUPPORTED_PLATFORM' },
    });
  });
});

describe('packageIgnore', () => {
  const kept = (job: { platform: string; arch: string }, paths: string[]) => paths.filter((p) => !packageIgnore(job)(p));
  const paths = [
    '/game/index.html',
    '/game/models/ship.obj',
    '/game/package-lock.json',
    '/node_modules/koffi/index.cjs',
    '/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
    '/node_modules/@koromix/koffi-darwin-x64',
    '/node_modules/@koromix/koffi-win32-x64',
    '/node_modules/@koromix/koffi-linux-x64',
    '/node_modules/steamworks-ffi-node/prebuilds/darwin-arm64/steam-overlay.node',
    '/node_modules/steamworks-ffi-node/prebuilds/win32-x64',
    '/node_modules/steamworks-ffi-node/prebuilds/linux-x64',
    '/steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib',
    '/steamworks_sdk/redistributable_bin/win64',
    '/steamworks_sdk/redistributable_bin/linux64',
  ];

  it("keeps only the target OS's native files, and every game file", () => {
    expect(kept({ platform: 'win32', arch: 'x64' }, paths)).toEqual([
      '/game/index.html',
      '/game/models/ship.obj',
      '/game/package-lock.json',
      '/node_modules/koffi/index.cjs',
      '/node_modules/@koromix/koffi-win32-x64',
      '/node_modules/steamworks-ffi-node/prebuilds/win32-x64',
      '/steamworks_sdk/redistributable_bin/win64',
    ]);
    expect(kept({ platform: 'darwin', arch: 'universal' }, paths)).toEqual([
      '/game/index.html',
      '/game/models/ship.obj',
      '/game/package-lock.json',
      '/node_modules/koffi/index.cjs',
      '/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
      '/node_modules/@koromix/koffi-darwin-x64',
      '/node_modules/steamworks-ffi-node/prebuilds/darwin-arm64/steam-overlay.node',
      '/steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib',
    ]);
    expect(kept({ platform: 'linux', arch: 'x64' }, paths)).toContain('/steamworks_sdk/redistributable_bin/linux64');
  });
});
