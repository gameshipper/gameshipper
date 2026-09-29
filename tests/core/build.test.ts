import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../../src/core/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { packageDesktop } from '../../src/core/desktop/package.js';
import type { buildMobileTargets, MobileInput } from '../../src/core/mobile/build-mobile.js';
import { GsFailure } from '../../src/core/result.js';
import { testCtx } from '../helpers/ctx.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

type Pack = typeof packageDesktop;
const fakePack: Pack = async (_ctx, _config, _appDir, _icon, job) => ({
  target: job.target,
  dir: `/out/${job.target}`,
  executable: `/out/${job.target}/game`,
  warnings: job.warnings,
});

type Mobile = typeof buildMobileTargets;
const fakeMobile: Mobile = async (_ctx, _config, targets) =>
  targets.map((target) => ({ target, output: { target, dir: `/out/${target}`, project: `/out/${target}/project` } }));

function project(): { dir: string; shellDir: string } {
  const dir = makeTmpDir();
  const shellDir = makeTmpDir();
  writeFiles(dir, { 'index.html': '<html></html>' });
  writeFiles(shellDir, { 'main.js': '' });
  return { dir, shellDir };
}
const config = (extra: object = {}) => parseConfig({ name: 'x', version: '1.0.0', ...extra }).data!;
/** Keeps darwin-host tests from probing this machine for Xcode's tools. */
const tools = { lipo: true };

describe('runBuild', () => {
  it('builds each target independently and reports status per target', async () => {
    const { dir, shellDir } = project();
    const r = await runBuild(testCtx(dir), config(), { shellDir, host: 'win32', pack: fakePack });
    expect(r.ok).toBe(false);
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([
      ['windows', 'built'],
      ['mac', 'failed'],
      ['linux', 'built'],
    ]);
    expect(r.errors.map((e) => e.code)).toEqual(['MAC_BUILD_HOST']);
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STEAM_SDK_MISSING', 'STORE_IMAGES_SKIPPED']);
    expect(r.data!.outDir).toBe(path.join(dir, 'out'));
  });

  it('hands iOS and Android the staged game and the icon, after the desktop targets', async () => {
    const { dir, shellDir } = project();
    writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
    const seen: Array<{ targets: readonly string[]; input: MobileInput }> = [];
    const mobile: Mobile = async (ctx, cfg, targets, input) => {
      seen.push({ targets, input });
      return fakeMobile(ctx, cfg, targets, input);
    };
    const r = await runBuild(testCtx(dir), config({ icon: 'icon.png', targets: ['linux', 'ios', 'android'] }), { shellDir, host: 'linux', pack: fakePack, mobile });
    expect(r.ok).toBe(true);
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([
      ['linux', 'built'],
      ['ios', 'built'],
      ['android', 'built'],
    ]);
    expect(r.data!.targets[1].mobile).toEqual({ target: 'ios', dir: '/out/ios', project: '/out/ios/project' });
    expect(seen).toEqual([
      { targets: ['ios', 'android'], input: { stageDir: path.join(dir, '.gameshipper', 'stage'), iconPng: path.join(dir, '.gameshipper', 'icons', 'icon.png') } },
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(['STEAM_SDK_MISSING', 'STORE_IMAGES_SKIPPED']);
  });

  it('reports an error iOS and Android share once, and fails only those targets', async () => {
    const { dir, shellDir } = project();
    const mobile: Mobile = async (_ctx, _cfg, targets) => targets.map((target) => ({ target, error: { code: 'BUNDLE_ID_REQUIRED', message: 'no bundle ID', fix: 'set it' } }));
    const r = await runBuild(testCtx(dir), config({ targets: ['linux', 'ios', 'android'] }), { shellDir, host: 'linux', pack: fakePack, mobile });
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([
      ['linux', 'built'],
      ['ios', 'failed'],
      ['android', 'failed'],
    ]);
    expect(r.errors.map((e) => e.code)).toEqual(['BUNDLE_ID_REQUIRED']);
  });

  it('a mobile-only build packages nothing and runs no desktop build hooks', async () => {
    const { dir, shellDir } = project();
    writeFiles(dir, { 'hooks.mjs': "import * as fs from 'node:fs';\nexport default { name: 'hooks', beforePackage(ctx) { fs.writeFileSync(ctx.projectDir + '/before.txt', 'ran'); } };\n" });
    const pack: Pack = async () => {
      throw new Error('nothing to package');
    };
    const r = await runBuild(testCtx(dir), config({ targets: ['ios'], plugins: ['hooks.mjs'] }), { shellDir, host: 'win32', pack, mobile: fakeMobile });
    expect(r.errors).toEqual([]);
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([['ios', 'built']]);
    expect(fs.existsSync(path.join(dir, 'before.txt'))).toBe(false);
    // No desktop app is made, so no Steamworks SDK is needed.
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STORE_IMAGES_SKIPPED']);
  });

  it('--target limits the build', async () => {
    const { dir, shellDir } = project();
    const r = await runBuild(testCtx(dir), config(), { shellDir, host: 'darwin', tools, only: ['linux'], pack: fakePack });
    expect(r.ok).toBe(true);
    expect(r.data!.targets.map((t) => t.target)).toEqual(['linux']);
  });

  it('TARGET_NOT_CONFIGURED for a target missing from the config', async () => {
    const { dir, shellDir } = project();
    const r = await runBuild(testCtx(dir), config({ targets: ['windows'] }), { shellDir, only: ['mac'], pack: fakePack });
    expect(r.errors[0].code).toBe('TARGET_NOT_CONFIGURED');
  });

  it('a packaging failure on one target does not stop the others', async () => {
    const { dir, shellDir } = project();
    const pack: Pack = async (ctx, cfg, appDir, icon, job) => {
      if (job.target === 'windows') throw new GsFailure('PACKAGE_FAILED', 'disk full', 'free space');
      return fakePack(ctx, cfg, appDir, icon, job);
    };
    const r = await runBuild(testCtx(dir), config({ targets: ['windows', 'linux'] }), { shellDir, host: 'darwin', tools, pack });
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([
      ['windows', 'failed'],
      ['linux', 'built'],
    ]);
    expect(r.errors[0]).toMatchObject({ code: 'PACKAGE_FAILED', message: 'disk full' });
  });

  it('turns an unexpected packaging error into PACKAGE_FAILED for that target', async () => {
    const { dir, shellDir } = project();
    const pack: Pack = async () => {
      throw new Error('EACCES: permission denied');
    };
    const r = await runBuild(testCtx(dir), config({ targets: ['linux'] }), { shellDir, host: 'linux', pack });
    expect(r.data!.targets[0]).toMatchObject({ target: 'linux', status: 'failed' });
    expect(r.errors[0].code).toBe('PACKAGE_FAILED');
    expect(r.errors[0].message).toContain('EACCES');
  });

  it('stops early with the preparation error', async () => {
    const dir = makeTmpDir();
    const r = await runBuild(testCtx(dir), config(), { shellDir: makeTmpDir(), pack: fakePack });
    expect(r.errors[0].code).toBe('ENTRY_MISSING');
  });

  it('assembles the app with the icon and passes the icon to the packager', async () => {
    const { dir, shellDir } = project();
    writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
    const icons: Array<string | null> = [];
    const pack: Pack = async (ctx, cfg, appDir, icon, job) => {
      icons.push(icon);
      return fakePack(ctx, cfg, appDir, icon, job);
    };
    const r = await runBuild(testCtx(dir), config({ icon: 'icon.png', targets: ['linux'] }), { shellDir, host: 'linux', pack });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['STEAM_SDK_MISSING', 'STORE_IMAGES_SKIPPED']);
    const iconBase = path.join(dir, '.gameshipper', 'icons', 'icon');
    expect(icons).toEqual([iconBase]);
    expect(fs.existsSync(`${iconBase}.icns`)).toBe(true);
    const appDir = path.join(dir, '.gameshipper', 'app');
    expect(fs.existsSync(path.join(appDir, 'shell', 'icon.png'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'game', 'index.html'))).toBe(true);
  });

  it('ASSET_MISSING when the icon file is gone', async () => {
    const { dir, shellDir } = project();
    const r = await runBuild(testCtx(dir), config({ icon: 'icon.png' }), { shellDir, pack: fakePack });
    expect(r.errors[0].code).toBe('ASSET_MISSING');
  });

  it('an icon that is too small, not square or not a PNG stops the build', async () => {
    const { dir, shellDir } = project();
    writeFiles(dir, { 'small.png': makeSolidPng(512, 512), 'wide.png': makeSolidPng(2048, 1024), 'fake.png': 'GIF89a' });
    for (const [icon, code] of [
      ['small.png', 'ICON_TOO_SMALL'],
      ['wide.png', 'ICON_NOT_SQUARE'],
      ['fake.png', 'ICON_INVALID'],
    ]) {
      const r = await runBuild(testCtx(dir), config({ icon, targets: ['linux'] }), { shellDir, host: 'linux', pack: fakePack });
      expect([r.ok, r.errors.map((e) => e.code)]).toEqual([false, [code]]);
      expect(r.errors[0].message).toMatch(new RegExp(`^${icon.replace('.', '\\.')} `));
    }
  });

  it('frozenLock reaches CDN bundling', async () => {
    const { dir, shellDir } = project();
    writeFiles(dir, { 'index.html': '<script src="https://cdn.example.invalid/lib.js"></script>' });
    const r = await runBuild(testCtx(dir), config(), { shellDir, frozenLock: true, pack: fakePack });
    expect(r.errors[0].code).toBe('CDN_NOT_LOCKED');
  });
});
