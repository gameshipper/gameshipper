import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
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
});
