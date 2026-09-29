import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../src/cli/output.js';
import { runBuild } from '../../src/core/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { packageDesktop } from '../../src/core/desktop/package.js';
import { GsFailure, gsError } from '../../src/core/result.js';
import type { finishMacApp } from '../../src/core/sign/mac.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

const fakePack: typeof packageDesktop = async (_ctx, _config, _appDir, _icon, job) => ({
  target: job.target,
  dir: `/out/${job.target}`,
  executable: `/out/${job.target}/game`,
  warnings: job.warnings,
});
/** Keeps darwin-host tests from probing this machine for Xcode's tools. */
const tools = { lipo: true };

/** Records the afterPackage hook and the signing in one file, in the order they happen. */
const RECORDER = `import * as fs from 'node:fs';
import * as path from 'node:path';
export default {
  name: 'recorder',
  afterPackage(ctx) { fs.appendFileSync(path.join(ctx.projectDir, 'order.txt'), 'afterPackage ' + ctx.target + '\\n'); },
};
`;

function project(extra: Record<string, string> = {}): { dir: string; shellDir: string } {
  const dir = makeTmpDir();
  const shellDir = makeTmpDir();
  writeFiles(dir, { 'index.html': '<html></html>', 'recorder.mjs': RECORDER, ...extra });
  writeFiles(shellDir, { 'main.js': '' });
  return { dir, shellDir };
}
const config = (extra: object = {}) => parseConfig({ name: 'Moon Game', version: '1.0.0', plugins: ['recorder.mjs'], ...extra }).data!;

describe('runBuild signs the Mac app', () => {
  it('after its afterPackage hooks, and reports how it was signed', async () => {
    const { dir, shellDir } = project();
    const finishMac: typeof finishMacApp = async (ctx, _config, app, plan, deps) => {
      fs.appendFileSync(path.join(ctx.projectDir, 'order.txt'), `sign ${plan.kind} ${app} steam=${deps?.steam}\n`);
      return { signing: 'adhoc', notarized: false, warnings: [gsError('MAC_UNSIGNED', 'only ad-hoc', 'set the variables')] };
    };
    const r = await runBuild(testCtx(dir), config({ targets: ['mac', 'linux'] }), { shellDir, host: 'darwin', tools, pack: fakePack, env: {}, finishMac });
    expect(r.errors).toEqual([]);
    // No Steamworks SDK, so no Steam in the app and none of Steam's entitlements.
    expect(readText(dir, 'order.txt')).toBe('afterPackage mac\nsign adhoc /out/mac/Moon Game.app steam=false\nafterPackage linux\n');
    const [mac, linux] = r.data!.targets;
    expect(mac.output).toMatchObject({ mac: { signing: 'adhoc', notarized: false } });
    expect(mac.warnings.map((w) => w.code)).toEqual(['MAC_UNSIGNED']);
    expect(linux.output!.mac).toBeUndefined();
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STEAM_SDK_MISSING', 'MAC_UNSIGNED', 'STORE_IMAGES_SKIPPED']);
  });

  it('a signing or notarization failure fails only the Mac target', async () => {
    const { dir, shellDir } = project();
    const finishMac: typeof finishMacApp = async () => {
      throw new GsFailure('NOTARIZE_FAILED', "Apple didn't notarize the Mac app (status: Invalid)", 'see the log');
    };
    const r = await runBuild(testCtx(dir), config(), { shellDir, host: 'darwin', tools, pack: fakePack, env: {}, finishMac });
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([
      ['windows', 'built'],
      ['mac', 'failed'],
      ['linux', 'built'],
    ]);
    expect(r.errors.map((e) => e.code)).toEqual(['NOTARIZE_FAILED']);
    expect(exitCodeFor(r)).toBe(1);
  });

  it('half-set Apple variables stop the build before the game build runs (exit 2)', async () => {
    const buildCommand = `node -e "require('fs').writeFileSync('ran.txt', '1')"`;
    const { dir, shellDir } = project();
    const r = await runBuild(testCtx(dir), config({ game: { buildCommand, outputDir: '.' } }), {
      shellDir,
      host: 'darwin',
      tools,
      pack: fakePack,
      env: { GAMESHIPPER_NOTARY_PROFILE: 'gameshipper' },
    });
    expect(r.errors.map((e) => e.code)).toEqual(['APPLE_CREDENTIALS_INVALID']);
    expect(r.data).toBeUndefined();
    expect(exitCodeFor(r)).toBe(2);
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
  });

  it('ignores the Apple variables when no Mac app is built', async () => {
    const { dir, shellDir } = project();
    const r = await runBuild(testCtx(dir), config({ targets: ['linux'] }), { shellDir, host: 'darwin', tools, pack: fakePack, env: { GAMESHIPPER_NOTARY_PROFILE: 'gs' } });
    expect(r.errors).toEqual([]);
  });
});
