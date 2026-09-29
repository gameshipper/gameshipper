import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { CAPACITOR_VERSION, runCapacitor } from '../../../src/core/mobile/capacitor.js';
import { SHIM_TAG } from '../../../src/core/mobile/shim.js';
import { capacitorConfig, mobileWorkDir, prepareMobileWorkspace } from '../../../src/core/mobile/workspace.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeTmpDir, readText, writeFiles } from '../../helpers/tmp.js';

const config = (extra: object = {}) =>
  parseConfig({ name: 'Moon Game', version: '1.2.3', mobile: { bundleId: 'com.jane.moongame' }, ...extra }).data!;

function staged(files: Record<string, string> = { 'index.html': '<!DOCTYPE html><html><head><title>Moon</title></head><body></body></html>', 'js/game.js': '' }) {
  const dir = makeTmpDir();
  const stageDir = path.join(dir, '.gameshipper', 'stage');
  writeFiles(stageDir, files);
  return { dir, stageDir };
}

describe('capacitorConfig', () => {
  it('sets the app identity and game-friendly defaults', () => {
    expect(capacitorConfig(config())).toEqual({
      appId: 'com.jane.moongame',
      appName: 'Moon Game',
      webDir: 'www',
      backgroundColor: '#000000',
      ios: { scrollEnabled: false, contentInset: 'never' },
      plugins: { SystemBars: { hidden: true } },
    });
  });

  it('starts at the configured entry when it is not index.html', () => {
    expect(capacitorConfig(config({ game: { entry: 'play/game.html' } })).server).toEqual({ appStartPath: 'play/game.html' });
  });
});

describe('prepareMobileWorkspace', () => {
  it('writes a Capacitor project with the staged game and the saves shim', () => {
    const { dir, stageDir } = staged();
    const work = prepareMobileWorkspace(testCtx(dir), config(), stageDir);
    expect(work).toBe(mobileWorkDir(dir));
    expect(readText(work, 'www/index.html')).toContain(`${SHIM_TAG}<title>Moon</title>`);
    expect(readText(work, 'www/_gameshipper/mobile.js')).toContain('gameshipper.saves.');
    expect(fs.existsSync(path.join(work, 'www/js/game.js'))).toBe(true);
    expect(JSON.parse(readText(work, 'package.json')).dependencies).toEqual({
      '@capacitor/core': CAPACITOR_VERSION,
      '@capacitor/ios': CAPACITOR_VERSION,
      '@capacitor/android': CAPACITOR_VERSION,
      '@capacitor/preferences': '8.0.1',
    });
    for (const p of ['core', 'ios', 'android', 'preferences']) {
      expect(fs.existsSync(path.join(work, 'node_modules/@capacitor', p, 'package.json'))).toBe(true);
    }
    // The desktop builds are made from the same stage: it's never changed.
    expect(readText(stageDir, 'index.html')).not.toContain(SHIM_TAG);
  });

  it('gives a game whose entry is another page the index.html Capacitor requires', () => {
    const { dir, stageDir } = staged({ 'play/game.html': '<html><head></head><body></body></html>' });
    const work = prepareMobileWorkspace(testCtx(dir), config({ game: { entry: 'play/game.html' } }), stageDir);
    expect(readText(work, 'www/play/game.html')).toContain(SHIM_TAG);
    expect(readText(work, 'www/index.html')).toContain('location.replace("play/game.html")');
  });

  it('puts the saves script in every page of the game, not only the entry page', () => {
    const page = (title: string) => `<!DOCTYPE html><html><head><title>${title}</title></head><body></body></html>`;
    const { dir, stageDir } = staged({
      'index.html': page('Menu'),
      'levels/two.html': page('Two'),
      'credits.HTM': page('Credits'),
      '_gameshipper/cdn/example.com/lib/demo.html': page('Bundled'),
    });
    const work = prepareMobileWorkspace(testCtx(dir), config(), stageDir);
    for (const [file, title] of [['index.html', 'Menu'], ['levels/two.html', 'Two'], ['credits.HTM', 'Credits']]) {
      expect(readText(work, `www/${file}`), file).toContain(`${SHIM_TAG}<title>${title}</title>`);
    }
    // Files bundled from CDNs are left as they were downloaded.
    expect(readText(work, 'www/_gameshipper/cdn/example.com/lib/demo.html')).not.toContain(SHIM_TAG);
  });

  it('runs the bundled Capacitor CLI without touching the network', async () => {
    const { dir, stageDir } = staged();
    const ctx = testCtx(dir);
    const work = prepareMobileWorkspace(ctx, config(), stageDir);
    await runCapacitor(ctx, work, ['add', 'android']);
    expect(readText(work, 'android/app/src/main/assets/public/index.html')).toContain(SHIM_TAG);
    expect(readText(work, 'android/app/src/main/assets/capacitor.plugins.json')).toContain('PreferencesPlugin');
    expect(fs.readFileSync(ctx.logPath, 'utf8')).toContain('[capacitor]');
  });

  it('MOBILE_GENERATE_FAILED with the end of the CLI output when it fails', async () => {
    const { dir, stageDir } = staged();
    const ctx = testCtx(dir);
    const work = prepareMobileWorkspace(ctx, config(), stageDir);
    fs.writeFileSync(path.join(work, 'capacitor.config.json'), '{"appName":"x","webDir":"www"}');
    const run = runCapacitor(ctx, work, ['add', 'android']);
    await expect(run).rejects.toMatchObject({ error: { code: 'MOBILE_GENERATE_FAILED', message: expect.stringContaining('appId') } });
  });
});
