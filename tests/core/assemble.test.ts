import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { assembleApp } from '../../src/core/desktop/assemble.js';
import { loadPlugins } from '../../src/core/plugins.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

describe('assembleApp', () => {
  it('combines shell, runtime config, icon and staged game', () => {
    const root = makeTmpDir();
    const shellDir = path.join(root, 'shell');
    const stageDir = path.join(root, 'stage');
    writeFiles(shellDir, { 'main.js': '//main', 'main.js.map': '{}', 'package.json': '{"type":"commonjs"}' });
    writeFiles(stageDir, { 'index.html': '<html></html>', 'js/game.js': '' });
    writeFiles(root, { 'icon.png': 'png' });
    const config = parseConfig({ name: 'Moon Game', version: '2.1.0', window: { width: 800 } }).data!;

    const appDir = assembleApp(root, config, { shellDir, stageDir, iconPng: path.join(root, 'icon.png') });

    expect(appDir).toBe(path.join(root, '.gameshipper', 'app'));
    expect(JSON.parse(readText(appDir, 'package.json'))).toEqual({
      name: 'moon-game',
      productName: 'Moon Game',
      version: '2.1.0',
      main: 'shell/main.js',
      private: true,
    });
    expect(JSON.parse(readText(appDir, 'shell/config.json'))).toEqual({
      name: 'Moon Game',
      entry: 'index.html',
      window: { width: 800, height: 720, fullscreen: true, resizable: true },
      steamAppId: 480,
      steamOverlay: 'auto',
      plugins: [],
    });
    expect(readText(appDir, 'shell/main.js')).toBe('//main');
    expect(fs.existsSync(path.join(appDir, 'shell/main.js.map'))).toBe(false);
    expect(readText(appDir, 'shell/icon.png')).toBe('png');
    expect(fs.existsSync(path.join(appDir, 'game/js/game.js'))).toBe(true);
  });

  it('uses a file-safe productName, which Electron names the save folder after', () => {
    const root = makeTmpDir();
    writeFiles(root, { 'shell/main.js': '', 'stage/index.html': '' });
    const config = parseConfig({ name: 'Moon: Rising', version: '1.0.0' }).data!;
    const appDir = assembleApp(root, config, { shellDir: path.join(root, 'shell'), stageDir: path.join(root, 'stage'), iconPng: null });
    expect(JSON.parse(readText(appDir, 'package.json'))).toMatchObject({ name: 'moon-rising', productName: 'Moon- Rising' });
    expect(JSON.parse(readText(appDir, 'shell/config.json')).name).toBe('Moon: Rising');
  });

  it('works without an icon and clears the previous app folder', () => {
    const root = makeTmpDir();
    writeFiles(root, { 'shell/main.js': '', 'stage/index.html': '', '.gameshipper/app/stale.txt': '' });
    const config = parseConfig({ name: 'x', version: '1.0.0' }).data!;
    const appDir = assembleApp(root, config, { shellDir: path.join(root, 'shell'), stageDir: path.join(root, 'stage'), iconPng: null });
    expect(fs.existsSync(path.join(appDir, 'stale.txt'))).toBe(false);
    expect(fs.existsSync(path.join(appDir, 'shell/icon.png'))).toBe(false);
  });
});

describe('assembleApp with Steam settings and plugins', () => {
  it('writes the overlay mode and the plugin manifest, and copies the plugins', async () => {
    const root = makeTmpDir();
    writeFiles(root, { 'shell/main.js': '', 'stage/index.html': '', 'echo.mjs': "export default { name: 'echo', main: { shout: async (s) => s } };" });
    const config = parseConfig({ name: 'x', version: '1.0.0', steam: { overlay: 'repaint' }, plugins: ['echo.mjs'] }).data!;
    const plugins = await loadPlugins(testCtx(root), config);
    const appDir = assembleApp(root, config, { shellDir: path.join(root, 'shell'), stageDir: path.join(root, 'stage'), iconPng: null, plugins });
    expect(JSON.parse(readText(appDir, 'shell/config.json'))).toMatchObject({
      steamOverlay: 'repaint',
      plugins: [{ name: 'echo', entry: 'plugins/echo/echo.mjs', functions: ['shout'] }],
    });
    expect(fs.existsSync(path.join(appDir, 'plugins/echo/echo.mjs'))).toBe(true);
  });
});
