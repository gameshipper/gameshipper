import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuild } from '../../src/core/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { packageDesktop } from '../../src/core/desktop/package.js';
import { listFiles } from '../../src/core/fsutil.js';
import { runPlay } from '../../src/core/play.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

type Pack = typeof packageDesktop;
const fakePack: Pack = async (_ctx, _config, _appDir, _icon, job) => ({
  target: job.target,
  dir: `/out/${job.target}`,
  executable: `/out/${job.target}/game`,
  warnings: job.warnings,
});

/** Stand-in koffi native packages, so nothing is downloaded. */
const koffi = {
  installed: (id: string) => {
    const dir = path.join(makeTmpDir('gs-native-'), id);
    writeFiles(dir, { 'package.json': '{}', [`${id.replace('-', '_')}/koffi.node`]: 'native' });
    return dir;
  },
};
/** Keeps darwin-host tests from probing this machine for Xcode's tools. */
const tools = { lipo: true };

const RECORDER = `import * as fs from 'node:fs';
import * as path from 'node:path';
export default {
  name: 'recorder',
  main: { async ping() { return 'pong'; } },
  beforePackage(ctx) { fs.writeFileSync(path.join(ctx.projectDir, 'before.txt'), ctx.targets.join(',')); },
  afterPackage(ctx) {
    if (ctx.target === 'linux') throw new Error('no linux today');
    fs.appendFileSync(path.join(ctx.projectDir, 'after.txt'), ctx.target + ' ' + ctx.executable + '\\n');
  },
};
`;

function project(extra: Record<string, string> = {}): { dir: string; shellDir: string } {
  const dir = makeTmpDir();
  const shellDir = makeTmpDir();
  writeFiles(dir, {
    'index.html': '<html></html>',
    'steamworks_sdk/redistributable_bin/win64/steam_api64.dll': 'dll',
    'steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib': 'dylib',
    'steamworks_sdk/redistributable_bin/linux64/libsteam_api.so': 'so',
    ...extra,
  });
  writeFiles(shellDir, { 'main.js': '' });
  return { dir, shellDir };
}
const config = (extra: object = {}) => parseConfig({ name: 'x', version: '1.0.0', ...extra }).data!;

describe('runBuild with Steam and plugins', () => {
  it('bundles Steam for every target and runs plugin hooks around packaging', async () => {
    const { dir, shellDir } = project({ 'recorder.mjs': RECORDER });
    const r = await runBuild(testCtx(dir), config({ plugins: ['recorder.mjs'] }), { shellDir, host: 'darwin', tools, pack: fakePack, env: {}, koffi });
    expect(r.data!.targets.map((t) => [t.target, t.status])).toEqual([
      ['windows', 'built'],
      ['mac', 'built'],
      ['linux', 'failed'],
    ]);
    expect(r.errors).toEqual([expect.objectContaining({ code: 'PLUGIN_HOOK_FAILED', message: "Plugin recorder's afterPackage failed: no linux today" })]);
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING']);
    expect(readText(dir, 'before.txt')).toBe('windows,mac,linux');
    expect(readText(dir, 'after.txt')).toBe('windows /out/windows/game\nmac /out/mac/game\n');

    const app = path.join(dir, '.gameshipper', 'app');
    const files = listFiles(app);
    for (const f of [
      'steamworks_sdk/redistributable_bin/win64/steam_api64.dll',
      'steamworks_sdk/redistributable_bin/osx/libsteam_api.dylib',
      'steamworks_sdk/redistributable_bin/linux64/libsteam_api.so',
      'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
      'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
      'node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node',
      'node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node',
      'node_modules/steamworks-ffi-node/dist/index.js',
      'plugins/recorder/recorder.mjs',
    ]) {
      expect(files, f).toContain(f);
    }
    // The SDK and the plugin's code are never game files.
    expect(files.filter((f) => f.startsWith('game/steamworks_sdk') || f === 'game/recorder.mjs')).toEqual([]);
    expect(JSON.parse(readText(app, 'shell/config.json')).plugins).toEqual([{ name: 'recorder', entry: 'plugins/recorder/recorder.mjs', functions: ['ping'] }]);
  });

  it('bundles only the natives of the targets being built', async () => {
    const { dir, shellDir } = project();
    await runBuild(testCtx(dir), config(), { shellDir, host: 'darwin', tools, only: ['linux'], pack: fakePack, env: {}, koffi });
    expect(fs.readdirSync(path.join(dir, '.gameshipper', 'app', 'node_modules', '@koromix'))).toEqual(['koffi-linux-x64']);
  });

  it('a failing beforePackage stops the build', async () => {
    const { dir, shellDir } = project({ 'stop.mjs': "export default { name: 'stop', beforePackage() { throw new Error('not today'); } };" });
    const r = await runBuild(testCtx(dir), config({ plugins: ['stop.mjs'] }), { shellDir, host: 'darwin', tools, pack: fakePack, env: {}, koffi });
    expect(r.errors.map((e) => e.code)).toEqual(['PLUGIN_HOOK_FAILED']);
    expect(r.data).toBeUndefined();
  });

  it('a bad SDK setting or plugin fails before the game build runs', async () => {
    const { dir, shellDir } = project({ 'broken.mjs': 'export default {' });
    const buildCommand = `node -e "require('fs').writeFileSync('ran.txt', '1')"`;
    const game = { buildCommand, outputDir: '.' };
    const sdk = await runBuild(testCtx(dir), config({ game, steam: { sdk: 'nope.zip' } }), { shellDir, host: 'linux', pack: fakePack, env: {} });
    expect(sdk.errors.map((e) => e.code)).toEqual(['STEAM_SDK_INVALID']);
    const plugin = await runBuild(testCtx(dir), config({ game, plugins: ['broken.mjs'] }), { shellDir, host: 'linux', pack: fakePack, env: {} });
    expect(plugin.errors.map((e) => e.code)).toEqual(['PLUGIN_LOAD_FAILED']);
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
  });

  it('warns STEAM_SDK_MISSING without an SDK, and the app gets no Steam files', async () => {
    const dir = makeTmpDir();
    const shellDir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    writeFiles(shellDir, { 'main.js': '' });
    const r = await runBuild(testCtx(dir), config({ targets: ['linux'] }), { shellDir, host: 'linux', pack: fakePack, env: {} });
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STEAM_SDK_MISSING']);
    expect(r.warnings[1].fix).toContain('https://partner.steamgames.com/downloads/list');
    expect(fs.existsSync(path.join(dir, '.gameshipper', 'app', 'node_modules'))).toBe(false);
  });
});

describe('runPlay with Steam', () => {
  it('bundles Steam for this computer only', async () => {
    const { dir, shellDir } = project();
    writeFiles(shellDir, { 'main.js': "require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));" });
    const r = await runPlay(testCtx(dir), config(), { shellDir, smokeSeconds: 1, electronPath: process.execPath, env: {}, koffi });
    expect(r.errors).toEqual([]);
    const koffiDirs = fs.readdirSync(path.join(dir, '.gameshipper', 'app', 'node_modules', '@koromix'));
    expect(koffiDirs).toEqual([`koffi-${process.platform}-${process.arch}`]);
  });
});
