import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../src/cli/output.js';
import { runBuild } from '../../src/core/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { packageDesktop } from '../../src/core/desktop/package.js';
import { testCtx } from '../helpers/ctx.js';
import { makeLogoPng, makeQuadrantPng } from '../helpers/images.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const fakePack: typeof packageDesktop = async (_ctx, _config, _appDir, _icon, job) => ({
  target: job.target,
  dir: `/out/${job.target}`,
  executable: `/out/${job.target}/game`,
  warnings: job.warnings,
});

async function project(keyArt: Buffer | string): Promise<{ dir: string; shellDir: string }> {
  const dir = makeTmpDir();
  const shellDir = makeTmpDir();
  writeFiles(dir, { 'index.html': '<html></html>', 'art/key.png': keyArt, 'art/logo.png': await makeLogoPng(1400, 600) });
  writeFiles(shellDir, { 'main.js': '' });
  return { dir, shellDir };
}

const config = parseConfig({ name: 'x', version: '1.0.0', targets: ['linux'], keyArt: 'art/key.png', logo: 'art/logo.png' }).data!;

describe('runBuild store images', () => {
  it('makes the store images after the desktop builds', async () => {
    const { dir, shellDir } = await project(await makeQuadrantPng(3840, 2160));
    const r = await runBuild(testCtx(dir), config, { shellDir, host: 'linux', pack: fakePack, env: {} });
    expect(r.errors).toEqual([]);
    expect(r.data!.store).toMatchObject({ status: 'built', dir: path.join(dir, 'out', 'store') });
    expect(r.data!.store!.images).toHaveLength(8);
    expect(fs.existsSync(path.join(dir, 'out', 'store', 'library_hero.png'))).toBe(true);
  });

  it('unusable key art fails the build as an input problem (exit 2), keeping the desktop results', async () => {
    const { dir, shellDir } = await project('not an image');
    const r = await runBuild(testCtx(dir), config, { shellDir, host: 'linux', pack: fakePack, env: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['KEYART_INVALID']);
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([['linux', 'built']]);
    expect(exitCodeFor(r)).toBe(2);
  });

  it('a fully transparent logo fails the build as an input problem (exit 2)', async () => {
    const { dir, shellDir } = await project(await makeQuadrantPng(3840, 2160));
    writeFiles(dir, { 'art/logo.png': makeSolidPng(800, 300, [0, 0, 0, 0]) });
    const r = await runBuild(testCtx(dir), config, { shellDir, host: 'linux', pack: fakePack, env: {} });
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([['LOGO_INVALID', 'logo logo.png is empty (fully transparent).']]);
    expect(exitCodeFor(r)).toBe(2);
  });

  it('warns STORE_IMAGES_SKIPPED, after everything else, when keyArt and logo are not set', async () => {
    const { dir, shellDir } = await project('');
    const r = await runBuild(testCtx(dir), parseConfig({ name: 'x', version: '1.0.0', targets: ['linux'] }).data!, { shellDir, host: 'linux', pack: fakePack, env: {} });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STEAM_SDK_MISSING', 'STORE_IMAGES_SKIPPED']);
    expect(r.data!.store!.status).toBe('skipped');
  });
});
