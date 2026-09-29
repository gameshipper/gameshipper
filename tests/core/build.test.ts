import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../../src/core/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { packageDesktop } from '../../src/core/desktop/package.js';
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
      ['ios', 'skipped'],
      ['android', 'skipped'],
    ]);
    expect(r.errors.map((e) => e.code)).toEqual(['MAC_BUILD_HOST']);
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'TARGET_NOT_YET_SUPPORTED', 'TARGET_NOT_YET_SUPPORTED']);
    expect(r.data!.outDir).toBe(path.join(dir, 'out'));
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
    expect(r.warnings).toEqual([]);
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

  it('frozenLock reaches CDN bundling', async () => {
    const { dir, shellDir } = project();
    writeFiles(dir, { 'index.html': '<script src="https://cdn.example.invalid/lib.js"></script>' });
    const r = await runBuild(testCtx(dir), config(), { shellDir, frozenLock: true, pack: fakePack });
    expect(r.errors[0].code).toBe('CDN_NOT_LOCKED');
  });
});
