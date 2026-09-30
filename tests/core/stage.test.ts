import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { runBuildCommand, stageGame } from '../../src/core/prepare/stage.js';
import { GsFailure } from '../../src/core/result.js';
import { testCtx } from '../helpers/ctx.js';
import { canRunTs, noteIfTsTestsSkipped } from '../helpers/node-features.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const cfg = (extra: object = {}) => parseConfig({ name: 'x', version: '1.0.0', ...extra }).data!;

/** Never exits. `&& echo` keeps the shell alive, so the node process is a grandchild of the spawned one. */
const NEVER_EXITS = `node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)" && echo done`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = (file: string): number | null => {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (check()) return true;
  }
  return check();
}

/** Like fs.existsSync, but true for a link even when its target is missing. */
const present = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const killIfAlive = (pid: number | null): void => {
  if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
};

/** Whether the temp folder's disk ignores letter case, as macOS and Windows disks do by default. */
const CASE_INSENSITIVE = (() => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'case'), '');
  return fs.existsSync(path.join(dir, 'CASE'));
})();

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

  it("skips the project's own files only when the game folder is the project folder", async () => {
    const projectOnly = ['out/intro.txt', 'node_modules/lib/index.js', 'gameshipper.json', 'gameshipper.lock', 'CLAUDE.md', 'AGENTS.md', 'package-lock.json', 'yarn.lock'];
    const neverShipped = ['.hidden/x.txt', '.npmrc', '.env', 'steam_appid.txt', 'sub/.DS_Store', 'sub/.env.local'];
    const game = (prefix: string) => Object.fromEntries(['index.html', ...projectOnly, ...neverShipped].map((f) => [`${prefix}${f}`, 'x']));
    for (const [where, extra] of [
      ['game.dir', { game: { dir: 'game' } }],
      ['game.outputDir', { game: { buildCommand: 'true', outputDir: 'game' } }],
    ] as const) {
      const dir = makeTmpDir();
      writeFiles(dir, { ...game('game/'), 'out/mac/old.txt': 'x' });
      const { stageDir } = await stageGame(testCtx(dir), cfg(extra));
      const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
      // A game's own out/ folder (game/out/intro.txt) and the like are part of the game here.
      for (const kept of ['index.html', ...projectOnly]) expect(exists(kept), `${where}: ${kept}`).toBe(true);
      for (const skipped of neverShipped) expect(exists(skipped), `${where}: ${skipped}`).toBe(false);
    }
  });

  it('skips top-level package manager lockfiles but keeps nested ones', async () => {
    const dir = makeTmpDir();
    const lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];
    writeFiles(dir, {
      'index.html': '',
      'package.json': '{}',
      ...Object.fromEntries(lockfiles.map((f) => [f, ''])),
      'data/yarn.lock': 'level data',
    });
    const { stageDir } = await stageGame(testCtx(dir), cfg());
    const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
    for (const skipped of lockfiles) expect(exists(skipped), skipped).toBe(false);
    for (const kept of ['index.html', 'package.json', 'data/yarn.lock']) expect(exists(kept), kept).toBe(true);
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

  it('copies symlinked files and folders as real files', async () => {
    const dir = makeTmpDir();
    const outside = makeTmpDir();
    writeFiles(outside, { 'music.ogg': 'ogg' });
    writeFiles(dir, { 'index.html': '', 'shared/tex.png': 'png', 'lib/real.js': 'x' });
    fs.symlinkSync('shared', path.join(dir, 'assets'));
    fs.symlinkSync('real.js', path.join(dir, 'lib', 'alias.js'));
    fs.symlinkSync(path.join(outside, 'music.ogg'), path.join(dir, 'lib', 'music.ogg'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg());
    expect(warnings).toEqual([]);
    expect(fs.lstatSync(path.join(stageDir, 'assets')).isDirectory()).toBe(true);
    for (const [rel, content] of [
      ['assets/tex.png', 'png'],
      ['lib/alias.js', 'x'],
      ['lib/music.ogg', 'ogg'],
    ]) {
      expect(fs.lstatSync(path.join(stageDir, rel)).isFile(), rel).toBe(true);
      expect(fs.readFileSync(path.join(stageDir, rel), 'utf8'), rel).toBe(content);
    }
  });

  it('skips broken symlinks in subfolders with a BROKEN_SYMLINK warning', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'js/main.js': '' });
    fs.symlinkSync('missing.js', path.join(dir, 'js', 'lib.js'));
    fs.symlinkSync('self', path.join(dir, 'js', 'self'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg());
    expect(present(path.join(stageDir, 'js', 'main.js'))).toBe(true);
    expect(present(path.join(stageDir, 'js', 'lib.js'))).toBe(false);
    expect(present(path.join(stageDir, 'js', 'self'))).toBe(false);
    expect(warnings.map((w) => w.code)).toEqual(['BROKEN_SYMLINK', 'BROKEN_SYMLINK']);
    const messages = warnings.map((w) => w.message).join('\n');
    expect(messages).toContain(path.join('js', 'lib.js'));
    expect(messages).toContain(path.join('js', 'self'));
  });

  it('skips symlinks that loop back to a folder above them', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'a/a.txt': '', 'b/b.txt': '', 'sub/s.txt': '' });
    fs.symlinkSync('..', path.join(dir, 'sub', 'up'));
    fs.symlinkSync('../b', path.join(dir, 'a', 'to-b'));
    fs.symlinkSync('../a', path.join(dir, 'b', 'to-a'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg());
    expect(present(path.join(stageDir, 'sub', 's.txt'))).toBe(true);
    expect(present(path.join(stageDir, 'sub', 'up'))).toBe(false);
    // Each link is followed once; the link back is where the loop is cut.
    expect(fs.readdirSync(path.join(stageDir, 'a', 'to-b'))).toEqual(['b.txt']);
    expect(fs.readdirSync(path.join(stageDir, 'b', 'to-a'))).toEqual(['a.txt']);
    expect(warnings.map((w) => w.code)).toEqual(['BROKEN_SYMLINK', 'BROKEN_SYMLINK', 'BROKEN_SYMLINK']);
    const messages = warnings.map((w) => w.message).join('\n');
    for (const link of [['sub', 'up'], ['a', 'to-b', 'to-a'], ['b', 'to-a', 'to-b']]) expect(messages).toContain(path.join(...link));
    for (const w of warnings) expect(w.fix).toBe('Remove the link, or replace it with a copy of the folder.');
  });

  it('skips links to a folder that holds the stage, which would copy the stage into itself', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'js/main.js': '' });
    fs.symlinkSync('.gameshipper', path.join(dir, 'gs'));
    fs.symlinkSync(path.join('..', '.gameshipper', 'stage'), path.join(dir, 'js', 'stage'));
    fs.symlinkSync('.', path.join(dir, 'here'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg());
    expect(present(path.join(stageDir, 'js', 'main.js'))).toBe(true);
    for (const link of ['gs', 'here', path.join('js', 'stage')]) expect(present(path.join(stageDir, link)), link).toBe(false);
    expect(warnings.map((w) => w.code)).toEqual(['BROKEN_SYMLINK', 'BROKEN_SYMLINK', 'BROKEN_SYMLINK']);
    const messages = warnings.map((w) => w.message).join('\n');
    for (const link of ['gs', 'here', path.join('js', 'stage')]) expect(messages).toContain(link);
    for (const w of warnings) expect(w.fix).toBe('Remove the link, or replace it with a copy of the folder.');
  });

  it('skips links to the stage from a game folder that is not the project root', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'dist/index.html': '' });
    fs.symlinkSync(path.join('..', '.gameshipper'), path.join(dir, 'dist', 'cache'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg({ game: { buildCommand: 'true', outputDir: 'dist' } }));
    expect(present(path.join(stageDir, 'index.html'))).toBe(true);
    expect(present(path.join(stageDir, 'cache'))).toBe(false);
    expect(warnings.map((w) => [w.code, w.message])).toEqual([['BROKEN_SYMLINK', expect.stringContaining(path.join('dist', 'cache'))]]);
  });

  it('never ships a .env file through a link with another name', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', '.env': 'SECRET=1', 'config/.env.production': 'SECRET=1', 'cfg/real.txt': 'ok' });
    fs.symlinkSync(path.join('..', '.env'), path.join(dir, 'cfg', 'settings.txt'));
    fs.symlinkSync(path.join('..', 'config', '.env.production'), path.join(dir, 'cfg', 'prod.txt'));
    fs.symlinkSync('real.txt', path.join(dir, 'cfg', 'alias.txt'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg());
    expect(warnings).toEqual([]);
    expect(present(path.join(stageDir, 'cfg', 'settings.txt'))).toBe(false);
    expect(present(path.join(stageDir, 'cfg', 'prod.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(stageDir, 'cfg', 'alias.txt'), 'utf8')).toBe('ok');
  });

  it.skipIf(process.platform === 'win32')('never ships a top-level dot entry, or a dot folder outside the project, through a link', async () => {
    const dir = makeTmpDir();
    const outside = makeTmpDir();
    writeFiles(outside, { '.aws/credentials': 'key', 'music.ogg': 'ogg' });
    writeFiles(dir, { 'index.html': '', '.npmrc': '//registry.npmjs.org/:_authToken=npm_secret', '.vscode/settings.json': '{}', 'config/.htaccess': 'x' });
    fs.symlinkSync('.npmrc', path.join(dir, 'settings.txt'));
    fs.symlinkSync(path.join('.vscode', 'settings.json'), path.join(dir, 'editor.json'));
    fs.symlinkSync('.vscode', path.join(dir, 'editor'));
    fs.symlinkSync(path.join(outside, '.aws', 'credentials'), path.join(dir, 'creds.txt'));
    // Staged like the files they point to: a nested dot file is game content, and so is a plain file elsewhere.
    fs.symlinkSync(path.join('config', '.htaccess'), path.join(dir, 'htaccess.txt'));
    fs.symlinkSync(path.join(outside, 'music.ogg'), path.join(dir, 'music.ogg'));
    const { stageDir, warnings } = await stageGame(testCtx(dir), cfg());
    expect(warnings).toEqual([]);
    for (const skipped of ['settings.txt', 'editor.json', 'editor', 'creds.txt']) expect(present(path.join(stageDir, skipped)), skipped).toBe(false);
    for (const kept of ['htaccess.txt', 'music.ogg', 'config/.htaccess']) expect(present(path.join(stageDir, kept)), kept).toBe(true);
  });

  it.skipIf(process.platform === 'win32')("never ships the project's dot entries through a link from a game subfolder", async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'dist/index.html': '', '.npmrc': 'token', 'assets/logo.png': 'png' });
    fs.symlinkSync(path.join('..', '.npmrc'), path.join(dir, 'dist', 'token.txt'));
    fs.symlinkSync(path.join('..', 'assets'), path.join(dir, 'dist', 'assets'));
    const { stageDir } = await stageGame(testCtx(dir), cfg({ game: { buildCommand: 'true', outputDir: 'dist' } }));
    expect(present(path.join(stageDir, 'token.txt'))).toBe(false);
    expect(present(path.join(stageDir, 'assets', 'logo.png'))).toBe(true);
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

  describe.skipIf(!CASE_INSENSITIVE)('on a disk that ignores letter case', () => {
    it("knows the game folder is the project folder, whatever case game.dir spells it in, and skips the project's files", async () => {
      const root = makeTmpDir();
      writeFiles(root, { 'Game/index.html': '', 'Game/out/old.exe': '', 'Game/node_modules/x/index.js': '', 'Game/gameshipper.json': '{}' });
      const { stageDir } = await stageGame(testCtx(path.join(root, 'Game')), cfg({ game: { dir: '../game' } }));
      expect(fs.existsSync(path.join(stageDir, 'index.html'))).toBe(true);
      for (const skipped of ['out', 'node_modules', 'gameshipper.json']) expect(fs.existsSync(path.join(stageDir, skipped)), skipped).toBe(false);
    });

    it('GAME_DIR_INVALID when game.outputDir is .gameshipper in other letters', async () => {
      const dir = makeTmpDir();
      writeFiles(dir, { 'index.html': '', '.gameshipper/logs/x.log': '' });
      const run = stageGame(testCtx(dir), cfg({ game: { buildCommand: 'true', outputDir: '.GameShipper' } }));
      await expect(run).rejects.toMatchObject({ error: { code: 'GAME_DIR_INVALID' } });
    });
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

  it('leaves out the store key art and logo unless the game mentions them', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '<link rel="stylesheet" href="css/menu.css"><script src="js/main.js"></script>',
      'css/menu.css': '.title { background: url("../art/title-logo.png") }',
      'js/main.js': 'console.log("hi")',
      'art/key-art.png': 'key art',
      'art/title-logo.png': 'logo',
      'art/sprite.png': 'sprite',
    });
    const { stageDir } = await stageGame(testCtx(dir), cfg({ keyArt: 'art/key-art.png', logo: 'art/title-logo.png' }));
    const exists = (rel: string) => fs.existsSync(path.join(stageDir, rel));
    // The menu shows the logo, so it ships; nothing uses the key art.
    expect([exists('art/key-art.png'), exists('art/title-logo.png'), exists('art/sprite.png')]).toEqual([false, true, true]);

    writeFiles(dir, { 'js/main.js': 'const art = new Image(); art.src = "art/key-art.png";', 'css/menu.css': '' });
    const again = await stageGame(testCtx(dir), cfg({ keyArt: 'art/key-art.png', logo: 'art/title-logo.png' }));
    expect([fs.existsSync(path.join(again.stageDir, 'art/key-art.png')), fs.existsSync(path.join(again.stageDir, 'art/title-logo.png'))]).toEqual([true, false]);
  });

  it('keeps store art an asset manifest (JSON) names', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<html></html>', 'assets/pack.json': '{"images":[{"key":"title","url":"art/logo.png"}]}', 'art/logo.png': 'logo' });
    const { stageDir } = await stageGame(testCtx(dir), cfg({ logo: 'art/logo.png' }));
    expect(fs.existsSync(path.join(stageDir, 'art', 'logo.png'))).toBe(true);
  });

  it('keeps store art the game names in quotes without its extension, as RPG Maker does', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '<script src="js/main.js"></script>',
      'js/main.js': 'const screen = "LogoScreen"; // a name that merely contains the stem',
      'data/System.json': '{"title1Name":"Logo","title2Name":""}',
      'img/titles1/Logo.png': 'logo',
      'img/key art.png': 'key art',
    });
    const art = { keyArt: 'img/key art.png', logo: 'img/titles1/Logo.png' };
    const { stageDir } = await stageGame(testCtx(dir), cfg(art));
    expect(fs.existsSync(path.join(stageDir, 'img/titles1/Logo.png'))).toBe(true);
    expect(fs.existsSync(path.join(stageDir, 'img/key art.png'))).toBe(false);

    // A quoted path ending in the stem counts too, in either kind of quotes, and URL-encoded.
    for (const mention of ["load('titles1/Logo')", 'load(`img/key%20art`)', "load('key art')"]) {
      writeFiles(dir, { 'data/System.json': '{}', 'js/main.js': mention });
      const again = await stageGame(testCtx(dir), cfg(art));
      const kept = ['img/titles1/Logo.png', 'img/key art.png'].filter((f) => fs.existsSync(path.join(again.stageDir, f)));
      expect(kept, mention).toEqual([mention.includes('Logo') ? 'img/titles1/Logo.png' : 'img/key art.png']);
    }
    // Unquoted, or only part of a name: not a mention.
    writeFiles(dir, { 'js/main.js': 'const Logo = 1; const s = "MyLogo"; const t = "Logo2";' });
    const none = await stageGame(testCtx(dir), cfg(art));
    expect(fs.existsSync(path.join(none.stageDir, 'img/titles1/Logo.png'))).toBe(false);
  });

  it('removes a folder that held only the store art', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<html></html>', 'art/store/key-art.png': 'key art', 'art/store/logo.png': 'logo' });
    const { stageDir } = await stageGame(testCtx(dir), cfg({ keyArt: 'art/store/key-art.png', logo: 'art/store/logo.png' }));
    expect(fs.readdirSync(stageDir)).toEqual(['index.html']);
  });

  it("leaves out a build's copy of the key art, but not another file with its name", async () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'public/key-art.png': 'key art',
      'dist/index.html': '<html></html>',
      'dist/key-art.png': 'key art',
      'dist/levels/key-art.png': 'a level picture',
    });
    const { stageDir } = await stageGame(testCtx(dir), cfg({ game: { buildCommand: 'true', outputDir: 'dist' }, keyArt: 'public/key-art.png' }));
    expect(fs.existsSync(path.join(stageDir, 'key-art.png'))).toBe(false);
    expect(fs.existsSync(path.join(stageDir, 'levels', 'key-art.png'))).toBe(true);
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
    const started = Date.now();
    try {
      const run = runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: NEVER_EXITS, outputDir: 'dist' } }), { timeoutMs: 1000 });
      await expect(run).rejects.toMatchObject({
        error: { code: 'BUILD_COMMAND_TIMEOUT', fix: expect.stringContaining('npm run dev') },
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      const pid = readPid(path.join(dir, 'pid.txt'));
      expect(pid).not.toBeNull();
      expect(await waitFor(() => !alive(pid!))).toBe(true);
    } finally {
      killIfAlive(readPid(path.join(dir, 'pid.txt')));
    }
  });

  it.skipIf(process.platform === 'win32')(
    'finishes when the command exits but a background process keeps its output open',
    async () => {
      const dir = makeTmpDir();
      const bgFile = path.join(dir, 'bg.txt');
      const started = Date.now();
      try {
        const command = '(sleep 30 & echo $! > bg.txt) ; echo built';
        await runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: command, outputDir: 'dist' } }), { timeoutMs: 15_000 });
        expect(Date.now() - started).toBeLessThan(10_000);
        const bg = readPid(bgFile);
        expect(bg).not.toBeNull();
        expect(await waitFor(() => !alive(bg!))).toBe(true);
      } finally {
        killIfAlive(readPid(bgFile));
      }
    },
  );

  it('keeps the output tail short when a progress bar redraws one line', async () => {
    const dir = makeTmpDir();
    const command = `node -e "for (let i = 1; i <= 5000; i++) process.stdout.write('step ' + i + ' of 5000 ' + '#'.repeat(20) + '\\r'); process.exitCode = 1"`;
    const error = await runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: command, outputDir: 'dist' } })).catch((e) => e);
    const { message } = (error as GsFailure).error;
    expect(message).toContain('step 5000 of 5000');
    expect(message).toContain('step 4981 of 5000');
    expect(message).not.toContain('step 4980 of 5000');
    expect(message.length).toBeLessThan(command.length + 1500);
  });

  it('caps the output tail at about 4 KB', async () => {
    const dir = makeTmpDir();
    const command = `node -e "process.stdout.write('x'.repeat(100000) + 'END'); process.exitCode = 1"`;
    const error = await runBuildCommand(testCtx(dir), cfg({ game: { buildCommand: command, outputDir: 'dist' } })).catch((e) => e);
    const { message } = (error as GsFailure).error;
    expect(message.endsWith('END')).toBe(true);
    expect(message.length).toBeLessThan(command.length + 4300);
  });

  it('removes its signal and exit handlers when the build finishes', async () => {
    const dir = makeTmpDir();
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const;
    const counts = () => events.map((e) => process.listenerCount(e));
    const before = counts();
    const run = (buildCommand: string, timeoutMs?: number) =>
      runBuildCommand(testCtx(dir), cfg({ game: { buildCommand, outputDir: 'dist' } }), { timeoutMs }).catch(() => undefined);
    try {
      const pending = run(NEVER_EXITS, 3000);
      expect(await waitFor(() => readPid(path.join(dir, 'pid.txt')) !== null)).toBe(true);
      expect(counts()).toEqual(before.map((n) => n + 1));
      await pending;
      expect(counts()).toEqual(before);
      await run('node -e "0"');
      await run('node -e "process.exit(2)"');
      expect(counts()).toEqual(before);
    } finally {
      killIfAlive(readPid(path.join(dir, 'pid.txt')));
    }
  });
});

/** Runs runBuildCommand in its own Node process (type stripping plus a .js -> .ts resolve hook). */
const RUNNER = `
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      try {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      } catch {}
    }
    return nextResolve(specifier, context);
  },
});
const [stageUrl, dir, command, mode] = process.argv.slice(2);
const { runBuildCommand } = await import(stageUrl);
if (mode === 'exit') setInterval(() => existsSync(dir + '/pid.txt') && process.exit(0), 50);
const ctx = { projectDir: dir, cacheDir: dir, logPath: dir + '/build.log', log() {} };
await runBuildCommand(ctx, { game: { buildCommand: command } });
`;

noteIfTsTestsSkipped('the runBuildCommand subprocess tests');

describe.skipIf(process.platform === 'win32' || !canRunTs)('runBuildCommand when Gameshipper itself stops', () => {
  it.each([
    ['is sent SIGTERM', 'signal'],
    ['calls process.exit()', 'exit'],
  ])('stops the build and its children when Gameshipper %s', async (_, mode) => {
    const dir = makeTmpDir();
    const runner = path.join(dir, 'runner.mjs');
    fs.writeFileSync(runner, RUNNER);
    const stageUrl = new URL('../../src/core/prepare/stage.ts', import.meta.url).href;
    const pidFile = path.join(dir, 'pid.txt');
    const gs = spawn(process.execPath, [runner, stageUrl, dir, NEVER_EXITS, mode], { stdio: 'ignore' });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      gs.on('exit', (code, signal) => resolve({ code, signal })),
    );
    try {
      expect(await waitFor(() => readPid(pidFile) !== null, 10_000)).toBe(true);
      const pid = readPid(pidFile)!;
      if (mode === 'signal') gs.kill('SIGTERM');
      expect(await exited).toEqual(mode === 'signal' ? { code: null, signal: 'SIGTERM' } : { code: 0, signal: null });
      expect(await waitFor(() => !alive(pid))).toBe(true);
    } finally {
      gs.kill('SIGKILL');
      killIfAlive(readPid(pidFile));
    }
  });
});
