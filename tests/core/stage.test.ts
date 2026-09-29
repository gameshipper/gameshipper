import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { runBuildCommand, stageGame } from '../../src/core/prepare/stage.js';
import { GsFailure } from '../../src/core/result.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const cfg = (extra: object = {}) => parseConfig({ name: 'x', version: '1.0.0', ...extra }).data!;

describe('stageGame', () => {
  it('copies the game and skips tool/project files', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '<html></html>',
      'js/main.js': '',
      'levels/out/level1.json': '{}',
      'out/old.exe': '',
      '.git/HEAD': '',
      'node_modules/x/index.js': '',
      'steam_appid.txt': '480',
      'gameshipper.json': '{}',
      'sub/.DS_Store': '',
    });
    const { stageDir } = await stageGame(testCtx(dir), cfg());
    expect(stageDir).toBe(path.join(dir, '.gameshipper', 'stage'));
    const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
    expect(exists('index.html')).toBe(true);
    expect(exists('js/main.js')).toBe(true);
    expect(exists('levels/out/level1.json')).toBe(true);
    for (const skipped of ['out', '.git', 'node_modules', 'steam_appid.txt', 'gameshipper.json', 'sub/.DS_Store']) {
      expect(exists(skipped), skipped).toBe(false);
    }
  });

  it('replaces a previous stage completely', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', '.gameshipper/stage/stale.js': '' });
    const { stageDir } = await stageGame(testCtx(dir), cfg());
    expect(fs.existsSync(path.join(stageDir, 'stale.js'))).toBe(false);
  });

  it('warns when the game loads files from node_modules', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<script type="module" src="./node_modules/three/build/three.module.js"></script>' });
    const { warnings } = await stageGame(testCtx(dir), cfg());
    expect(warnings[0].code).toBe('NODE_MODULES_REFERENCED');
  });

  it('stages outputDir when a build command is configured', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'dist/index.html': '<html>built</html>', 'src/app.ts': '' });
    const { stageDir } = await stageGame(testCtx(dir), cfg({ game: { buildCommand: 'true', outputDir: 'dist' } }));
    expect(fs.readFileSync(path.join(stageDir, 'index.html'), 'utf8')).toContain('built');
    expect(fs.existsSync(path.join(stageDir, 'src'))).toBe(false);
  });

  it('ENTRY_MISSING when the staged entry is absent', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'dist/other.html': '' });
    await expect(stageGame(testCtx(dir), cfg({ game: { buildCommand: 'true', outputDir: 'dist' } }))).rejects.toMatchObject({
      error: { code: 'ENTRY_MISSING' },
    });
  });
});

describe('runBuildCommand', () => {
  it('runs the command in the project folder', async () => {
    const dir = makeTmpDir();
    const command = `node -e "require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/index.html','ok')"`;
    await runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: command, outputDir: 'dist' } }));
    expect(fs.readFileSync(path.join(dir, 'dist/index.html'), 'utf8')).toBe('ok');
  });

  it('BUILD_COMMAND_FAILED on a non-zero exit', async () => {
    const dir = makeTmpDir();
    const run = runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: 'node -e "process.exit(3)"', outputDir: 'dist' } }));
    await expect(run).rejects.toBeInstanceOf(GsFailure);
    await expect(run).rejects.toMatchObject({ error: { code: 'BUILD_COMMAND_FAILED' } });
  });
});
