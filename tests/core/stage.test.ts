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

  it('never ships .env files or top-level tooling files', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '',
      '.env': 'SECRET=1',
      '.env.local': 'SECRET=1',
      'config/.env': 'SECRET=1',
      'config/.env.production': 'SECRET=1',
      'config/.htaccess': '',
      'config/environment.js': '',
      '.claude/settings.json': '{}',
      '.vscode/settings.json': '{}',
      '.github/workflows/ci.yml': '',
      '.prettierrc': '{}',
      'CLAUDE.md': '',
      'AGENTS.md': '',
    });
    const { stageDir } = await stageGame(testCtx(dir), cfg());
    const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
    for (const kept of ['index.html', 'config/.htaccess', 'config/environment.js']) expect(exists(kept), kept).toBe(true);
    for (const skipped of [
      '.env',
      '.env.local',
      'config/.env',
      'config/.env.production',
      '.claude',
      '.vscode',
      '.github',
      '.prettierrc',
      'CLAUDE.md',
      'AGENTS.md',
    ]) {
      expect(exists(skipped), skipped).toBe(false);
    }
  });

  it('skips a broken top-level symlink with a BROKEN_SYMLINK warning', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    fs.symlinkSync('missing.js', path.join(dir, 'lib.js'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg());
    expect(fs.existsSync(path.join(stageDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(stageDir, 'lib.js'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'BROKEN_SYMLINK', fix: 'Remove the link or point it at a real file.' });
    expect(warnings[0].message).toContain('lib.js');
  });

  it('GAME_DIR_INVALID when game.dir is a file', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    const run = stageGame(testCtx(dir), cfg({ game: { dir: 'index.html' } }));
    await expect(run).rejects.toBeInstanceOf(GsFailure);
    await expect(run).rejects.toMatchObject({ error: { code: 'GAME_DIR_INVALID', fix: expect.stringContaining('game.dir') } });
  });

  it('GAME_DIR_INVALID when game.dir contains the project', async () => {
    const root = makeTmpDir();
    writeFiles(root, { 'index.html': '', 'project/gameshipper.json': '{}' });
    const run = stageGame(testCtx(path.join(root, 'project')), cfg({ game: { dir: '..' } }));
    await expect(run).rejects.toMatchObject({ error: { code: 'GAME_DIR_INVALID', fix: expect.stringContaining('game.dir') } });
  });

  it('GAME_DIR_INVALID when game.outputDir contains or is inside .gameshipper', async () => {
    const root = makeTmpDir();
    writeFiles(root, { 'index.html': '', 'project/gameshipper.json': '{}' });
    const project = path.join(root, 'project');
    for (const outputDir of ['..', '.gameshipper']) {
      const run = stageGame(testCtx(project), cfg({ game: { buildCommand: 'true', outputDir } }));
      await expect(run, outputDir).rejects.toMatchObject({
        error: { code: 'GAME_DIR_INVALID', fix: expect.stringContaining('game.outputDir') },
      });
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

  it('BUILD_COMMAND_FAILED includes the last 20 lines of output', async () => {
    const dir = makeTmpDir();
    const command = `node -e "for (let i = 1; i <= 30; i++) console.log('line ' + i); process.exit(3)"`;
    const error = await runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: command, outputDir: 'dist' } })).catch((e) => e);
    expect(error).toBeInstanceOf(GsFailure);
    const { message } = (error as GsFailure).error;
    for (let i = 11; i <= 30; i++) expect(message).toMatch(new RegExp(`\\bline ${i}\\b`));
    for (let i = 1; i <= 10; i++) expect(message).not.toMatch(new RegExp(`\\bline ${i}\\b`));
  });

  it('BUILD_COMMAND_FAILED includes stderr output', async () => {
    const dir = makeTmpDir();
    // Built at runtime so the command text itself doesn't contain the expected output.
    const command = `node -e "console.error(['Cannot', 'find', 'module', 'vite'].join(' ')); process.exit(1)"`;
    await expect(runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: command, outputDir: 'dist' } }))).rejects.toMatchObject({
      error: { code: 'BUILD_COMMAND_FAILED', message: expect.stringContaining('Cannot find module vite') },
    });
  });

  it('BUILD_COMMAND_TIMEOUT stops a command that never exits, including its child processes', async () => {
    const dir = makeTmpDir();
    // `&& echo` keeps the shell alive, so the node process is a grandchild of the spawned one.
    const command = `node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)" && echo done`;
    const started = Date.now();
    const run = runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: command, outputDir: 'dist' } }), { timeoutMs: 1000 });
    await expect(run).rejects.toMatchObject({
      error: { code: 'BUILD_COMMAND_TIMEOUT', fix: expect.stringContaining('npm run dev') },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  });
});
