import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { listFiles } from '../../src/core/fsutil.js';
import { copyPlugins, loadPlugins, runPluginHook } from '../../src/core/plugins.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

const config = (plugins: string[]) => parseConfig({ name: 'x', version: '1.0.0', plugins }).data!;

const ECHO = `export default {
  name: 'echo',
  main: { async shout(s) { return String(s).toUpperCase(); }, version: 2 },
  async afterPackage(ctx) { ctx.log('packaged ' + ctx.target); },
};
`;

describe('loadPlugins', () => {
  it('loads file and folder plugins and lists their game functions', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'plugins/echo.mjs': ECHO,
      'tools/stats/package.json': '{"type":"module","main":"src/main.js"}',
      'tools/stats/src/main.js': "import { twice } from './twice.js';\nexport default { name: 'stats', main: { twice } };\n",
      'tools/stats/src/twice.js': 'export const twice = (n) => n * 2;\n',
    });
    const plugins = await loadPlugins(testCtx(dir), config(['plugins/echo.mjs', 'tools/stats']));
    expect(plugins.map((p) => [p.name, p.functions, path.relative(dir, p.entryFile)])).toEqual([
      ['echo', ['shout'], path.join('plugins', 'echo.mjs')],
      ['stats', ['twice'], path.join('tools', 'stats', 'src', 'main.js')],
    ]);
    expect(await (plugins[0].plugin.main!.shout as (s: string) => Promise<string>)('hi')).toBe('HI');
  });

  it('PLUGIN_LOAD_FAILED with the reason', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'broken.mjs': 'export default {',
      'nodefault.mjs': 'export const x = 1;',
      'badname.mjs': "export default { name: 'my-plugin' };",
      'a.mjs': "export default { name: 'dup' };",
      'b.mjs': "export default { name: 'dup' };",
      'badmain.mjs': "export default { name: 'm', main: 5 };",
      'badhook.mjs': "export default { name: 'h', beforePackage: 'soon' };",
      'emptyfolder/readme.txt': '',
      'badpkg/package.json': '{ "main": ',
    });
    const reason = async (plugins: string[]) => {
      try {
        await loadPlugins(testCtx(dir), config(plugins));
        return 'loaded';
      } catch (e) {
        expect((e as { error: { code: string } }).error.code).toBe('PLUGIN_LOAD_FAILED');
        return (e as Error).message;
      }
    };
    expect(await reason(['missing.mjs'])).toContain("doesn't exist");
    expect(await reason(['broken.mjs'])).toContain('broken.mjs');
    expect(await reason(['nodefault.mjs'])).toContain('no default export');
    expect(await reason(['badname.mjs'])).toContain('"my-plugin"');
    expect(await reason(['a.mjs', 'b.mjs'])).toContain('already named "dup"');
    expect(await reason(['badmain.mjs'])).toContain('"main" must be an object');
    expect(await reason(['badhook.mjs'])).toContain('"beforePackage" must be a function');
    expect(await reason(['emptyfolder'])).toContain('index.mjs');
    expect(await reason(['badpkg'])).toContain("its package.json can't be read");
  });

  it("PLUGIN_LOAD_FAILED when a folder plugin's main is outside its folder", async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'shared.mjs': "export default { name: 'shared' };",
      'up/package.json': '{"main":"../shared.mjs"}',
      'absolute/package.json': JSON.stringify({ main: path.join(dir, 'shared.mjs') }),
      'missing/package.json': '{"main":"src/nope.mjs"}',
    });
    for (const spec of ['up', 'absolute']) {
      await expect(loadPlugins(testCtx(dir), config([spec])), spec).rejects.toMatchObject({
        error: { code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining('outside the plugin folder') },
      });
    }
    if (process.platform !== 'win32') {
      writeFiles(dir, { 'linked/package.json': '{"main":"index.mjs"}' });
      fs.symlinkSync(path.join(dir, 'shared.mjs'), path.join(dir, 'linked', 'index.mjs'));
      await expect(loadPlugins(testCtx(dir), config(['linked']))).rejects.toMatchObject({
        error: { code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining('outside the plugin folder') },
      });
    }
    await expect(loadPlugins(testCtx(dir), config(['missing']))).rejects.toMatchObject({
      error: { code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining('"main" (src/nope.mjs) doesn\'t exist') },
    });
  });

  it("PLUGIN_LOAD_FAILED when a folder plugin's main is in a folder the copy leaves out, or is left out itself", async () => {
    const dir = makeTmpDir();
    const plugin = "export default { name: 'p' };";
    writeFiles(dir, {
      'built/package.json': '{"main":"out/index.mjs"}',
      'built/out/index.mjs': plugin,
      'dotted/package.json': '{"main":".build/index.mjs"}',
      'dotted/.build/index.mjs': plugin,
      'bin/package.json': '{"main":"node_modules/.bin/tool.mjs"}',
      'bin/node_modules/.bin/tool.mjs': plugin,
      'sdk/package.json': '{"main":"valve/index.mjs"}',
      'sdk/valve/index.mjs': plugin,
      'sdk/valve/redistributable_bin/osx/libsteam_api.dylib': 'lib',
      'named/package.json': '{"main":"lib/steamworks_sdk_bridge.mjs"}',
      'named/lib/steamworks_sdk_bridge.mjs': plugin,
      'fine/package.json': '{"main":"lib/out/index.mjs"}',
      'fine/lib/out/index.mjs': plugin,
    });
    for (const [spec, folder] of [
      ['built', 'out'],
      ['dotted', '.build'],
      ['bin', 'node_modules/.bin'],
      ['sdk', 'valve'],
    ]) {
      await expect(loadPlugins(testCtx(dir), config([spec])), spec).rejects.toMatchObject({
        error: { code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining(`the plugin's main file is in a folder that isn't packaged (${folder})`) },
      });
    }
    await expect(loadPlugins(testCtx(dir), config(['named']))).rejects.toMatchObject({
      error: { code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining("the plugin's main file (lib/steamworks_sdk_bridge.mjs) isn't packaged") },
    });
    // out/ is only left out at the top of the folder.
    expect((await loadPlugins(testCtx(dir), config(['fine'])))[0].name).toBe('p');
  });

  it('PLUGIN_LOAD_FAILED for names that differ only in case, or that every object already has', async () => {
    const dir = makeTmpDir();
    const files: Record<string, string> = { 'lower.mjs': "export default { name: 'echo' };", 'upper.mjs': "export default { name: 'Echo' };" };
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) files[`${name}.mjs`] = `export default { name: '${name}' };`;
    writeFiles(dir, files);
    await expect(loadPlugins(testCtx(dir), config(['lower.mjs', 'upper.mjs']))).rejects.toMatchObject({
      error: { code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining('"echo", which differs only in letter case') },
    });
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      await expect(loadPlugins(testCtx(dir), config([`${name}.mjs`])), name).rejects.toMatchObject({
        error: { code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining(`"${name}" can't be a plugin name`) },
      });
    }
  });

  it('loads fresh code when a plugin changes between loads (a long-running process)', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'live.mjs');
    fs.writeFileSync(file, "export default { name: 'live', main: { one() {} } };");
    expect((await loadPlugins(testCtx(dir), config(['live.mjs'])))[0].functions).toEqual(['one']);
    fs.writeFileSync(file, "export default { name: 'live', main: { one() {}, two() {} } };");
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(file, later, later);
    expect((await loadPlugins(testCtx(dir), config(['live.mjs'])))[0].functions).toEqual(['one', 'two']);
  });

  it('warns PLUGIN_IMPORTS_NOT_COPIED when a single-file plugin imports other files or packages', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'helper.mjs': 'export const x = 1;',
      'node_modules/leftpad/package.json': '{"name":"leftpad","main":"index.js"}',
      'node_modules/leftpad/index.js': 'module.exports = (s) => s;',
      'relative.mjs': "import { x } from './helper.mjs';\nexport default { name: 'relative', main: { go: () => x } };",
      'bare.mjs': "import leftpad from 'leftpad';\nexport default { name: 'bare', main: { go: () => leftpad('x') } };",
      'lazy.mjs': "export default { name: 'lazy', main: { async go() { return import('./helper.mjs'); } } };",
      'required.cjs': "const { x } = require('./helper.cjs');\nmodule.exports = { name: 'required', main: { go: () => x } };",
      'helper.cjs': 'exports.x = 1;',
      // Node's built-in modules and Electron are always there.
      'builtins.mjs':
        "import * as fs from 'node:fs';\nimport path from 'path';\nexport default { name: 'builtins', main: { async open(u) { const { shell } = await import('electron'); return shell.openExternal(u); }, async quit() { (await import('electron/main')).app.quit(); } } };",
      'folder/index.mjs': "import { x } from './more.mjs';\nexport default { name: 'folder', main: { go: () => x } };",
      'folder/more.mjs': 'export const x = 1;',
    });
    const specs = ['relative.mjs', 'bare.mjs', 'lazy.mjs', 'required.cjs', 'builtins.mjs', 'folder'];
    const plugins = await loadPlugins(testCtx(dir), config(specs));
    const warned = plugins.map((p) => [p.name, p.warnings.map((w) => w.code)]);
    expect(warned).toEqual([
      ['relative', ['PLUGIN_IMPORTS_NOT_COPIED']],
      ['bare', ['PLUGIN_IMPORTS_NOT_COPIED']],
      ['lazy', ['PLUGIN_IMPORTS_NOT_COPIED']],
      ['required', ['PLUGIN_IMPORTS_NOT_COPIED']],
      ['builtins', []],
      ['folder', []],
    ]);
    expect(plugins[0].warnings[0].message).toContain('./helper.mjs');
    expect(plugins[0].warnings[0].message).toContain('only the plugin file is packaged');
    expect(plugins[0].warnings[0].fix).toMatch(/^Bundle it into one file .* or make it a folder plugin/);
  });
});

describe('copyPlugins', () => {
  it('copies each plugin under plugins/<name>/ and keeps its module type', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'package.json': '{"type":"module"}',
      'echo.js': ECHO,
      'tools/stats/index.mjs': "export default { name: 'stats', main: { n() { return 1; } } };\n",
      'tools/stats/.git/HEAD': 'ref',
    });
    const appDir = makeTmpDir();
    const runtime = copyPlugins(appDir, await loadPlugins(testCtx(dir), config(['echo.js', 'tools/stats'])));
    expect(runtime).toEqual([
      { name: 'echo', entry: 'plugins/echo/echo.js', functions: ['shout'] },
      { name: 'stats', entry: 'plugins/stats/index.mjs', functions: ['n'] },
    ]);
    expect(readText(appDir, 'plugins/echo/echo.js')).toBe(ECHO);
    expect(JSON.parse(readText(appDir, 'plugins/echo/package.json'))).toEqual({ type: 'module' });
    expect(fs.existsSync(path.join(appDir, 'plugins/stats/.git'))).toBe(false);
  });
});

describe('copyPlugins by staging rules', () => {
  const STATS = "export default { name: 'stats', main: { n() { return 1; } } };\n";

  it('leaves out secrets, every top-level dot entry, the SDK, build output and tool folders', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'tools/stats/index.mjs': STATS,
      'tools/stats/lib/util.js': '',
      'tools/stats/.env': 'SECRET=1',
      'tools/stats/lib/.env.local': 'SECRET=1',
      'tools/stats/steam_appid.txt': '480',
      'tools/stats/lib/.DS_Store': '',
      'tools/stats/.git/HEAD': 'ref',
      'tools/stats/vendor/steamworks_sdk_165.zip': 'zip',
      'tools/stats/valve/redistributable_bin/osx/libsteam_api.dylib': 'lib',
      'tools/stats/.sdk/any.zip': 'zip',
      'tools/stats/.gameshipper/app/shell/main.js': '',
      'tools/stats/out/windows/game.exe': '',
      'tools/stats/node_modules/.bin/tool': '',
      'tools/stats/node_modules/dep/index.js': '',
      'tools/stats/node_modules/dep/out/built.js': '',
      'tools/stats/node_modules/dep/node_modules/.bin/x': '',
      'tools/stats/.npmrc': '//registry.npmjs.org/:_authToken=npm_secret',
      'tools/stats/.vscode/settings.json': '{}',
      'tools/stats/.github/workflows/ci.yml': '',
      'tools/stats/.claude/settings.json': '{}',
    });
    if (process.platform !== 'win32') {
      fs.symlinkSync('lib', path.join(dir, 'tools', 'stats', 'alias'));
      fs.symlinkSync('.env', path.join(dir, 'tools', 'stats', 'settings.txt'));
    }
    const appDir = makeTmpDir();
    copyPlugins(appDir, await loadPlugins(testCtx(dir), config(['tools/stats'])));
    const expected = ['index.mjs', 'lib/util.js', 'node_modules/dep/index.js', 'node_modules/dep/out/built.js', 'package.json'];
    if (process.platform !== 'win32') expected.unshift('alias/util.js');
    expect(listFiles(path.join(appDir, 'plugins', 'stats'))).toEqual(expected);
  });

  it.skipIf(process.platform === 'win32')('PLUGIN_LOAD_FAILED for links out of the plugin folder, loops and failed copies', async () => {
    const outside = makeTmpDir();
    writeFiles(outside, { 'id_rsa': 'key', 'more/x.js': '' });
    const cases: Array<[string, (pluginDir: string) => void, string]> = [
      ['a file outside', (p) => fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(p, 'key.txt')), 'links outside the plugin folder'],
      ['a folder outside', (p) => fs.symlinkSync(path.join(outside, 'more'), path.join(p, 'more')), 'links outside the plugin folder'],
      ['a loop', (p) => fs.symlinkSync('..', path.join(p, 'lib', 'loop')), 'links to a folder that contains it'],
      ['nothing', (p) => fs.symlinkSync('missing.js', path.join(p, 'gone.js')), "links to something that doesn't exist"],
    ];
    for (const [what, link, reason] of cases) {
      const dir = makeTmpDir();
      writeFiles(dir, { 'tools/stats/index.mjs': STATS, 'tools/stats/lib/util.js': '' });
      link(path.join(dir, 'tools', 'stats'));
      const plugins = await loadPlugins(testCtx(dir), config(['tools/stats']));
      expect(() => copyPlugins(makeTmpDir(), plugins), what).toThrow(
        expect.objectContaining({ error: expect.objectContaining({ code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining(reason) }) }),
      );
    }
    // A plugin folder that holds the app (the project root, say) can't be copied into it.
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.mjs': STATS });
    const plugins = await loadPlugins(testCtx(dir), config(['.']));
    expect(() => copyPlugins(path.join(dir, '.gameshipper', 'app'), plugins)).toThrow(
      expect.objectContaining({ error: expect.objectContaining({ code: 'PLUGIN_LOAD_FAILED', message: expect.stringContaining("couldn't be copied into the app") }) }),
    );
  });
});

describe('runPluginHook', () => {
  it('runs hooks in order with a prefixed log, and reports failures', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'echo.mjs': ECHO,
      'bad.mjs': "export default { name: 'bad', afterPackage() { throw new Error('disk full'); } };",
    });
    const lines: string[] = [];
    const base = { projectDir: dir, appDir: dir, config: config([]), log: (m: string) => lines.push(m), target: 'mac' as const, outDir: '/o', executable: '/o/x' };
    const [echo, bad] = await loadPlugins(testCtx(dir), config(['echo.mjs', 'bad.mjs']));
    await runPluginHook([echo], 'afterPackage', base);
    expect(lines).toEqual(['[plugin echo] packaged mac']);
    await runPluginHook([echo], 'beforePackage', { ...base, targets: ['mac'] });
    await expect(runPluginHook([bad], 'afterPackage', base)).rejects.toMatchObject({
      error: { code: 'PLUGIN_HOOK_FAILED', message: "Plugin bad's afterPackage failed: disk full" },
    });
  });

  it('PLUGIN_HOOK_FAILED when a hook never finishes', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'stuck.mjs': "export default { name: 'stuck', beforePackage() { return new Promise(() => {}); } };" });
    const [stuck] = await loadPlugins(testCtx(dir), config(['stuck.mjs']));
    const hookCtx = { projectDir: dir, appDir: dir, config: config([]), log: () => {}, targets: ['mac' as const] };
    await expect(runPluginHook([stuck], 'beforePackage', hookCtx, { timeoutMs: 50 })).rejects.toMatchObject({
      error: { code: 'PLUGIN_HOOK_FAILED', message: expect.stringContaining("Plugin stuck's beforePackage timed out") },
    });
  });
});
