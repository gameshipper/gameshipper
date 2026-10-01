import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { executableFor } from '../../src/core/desktop/package.js';
import { runPlay } from '../../src/core/play.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const config = parseConfig({ name: 'Moon Game', version: '1.0.0' }).data!;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (check()) return true;
  }
  return check();
}

describe('play --packaged', () => {
  it('PACKAGED_BUILD_MISSING when there is no build for this computer', async () => {
    const r = await runPlay(testCtx(makeTmpDir()), config, { shellDir: makeTmpDir(), packaged: true, smokeSeconds: 1, host: 'linux' });
    expect(r.errors.map((e) => [e.code, e.message, e.fix])).toEqual([
      ['PACKAGED_BUILD_MISSING', "There's no linux build at out/linux/moon-game.", 'Run `npx gameshipper build --target linux` first.'],
    ]);
  });

  it("says to add this computer's target when the config doesn't have it", async () => {
    const windowsOnly = parseConfig({ name: 'Moon Game', version: '1.0.0', targets: ['windows'] }).data!;
    const r = await runPlay(testCtx(makeTmpDir()), windowsOnly, { shellDir: makeTmpDir(), packaged: true, host: 'linux' });
    expect(r.errors[0]).toMatchObject({ code: 'PACKAGED_BUILD_MISSING', fix: 'Add "linux" to "targets" in gameshipper.json, then run `npx gameshipper build --target linux`.' });
  });

  // The stand-in build is a Node script with a shebang, which Windows can't run directly.
  it.skipIf(process.platform === 'win32')('smoke-tests the build in out/<target>, without preparing the game', async () => {
    const dir = makeTmpDir();
    const exe = executableFor(config, 'linux', path.join(dir, 'out', 'linux'));
    writeFiles(dir, {
      [path.relative(dir, exe).split(path.sep).join('/')]: [
        `#!${process.execPath}`,
        "const message = 'packaged:' + process.env.GAMESHIPPER_SMOKE_SECONDS + ' args:' + JSON.stringify(process.argv.slice(2));",
        "const events = [{ kind: 'console', level: 'info', message, source: '', line: 0 }];",
        "require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events }));",
      ].join('\n'),
    });
    fs.chmodSync(exe, 0o755);
    // No index.html: a packaged run never stages the game.
    const r = await runPlay(testCtx(dir), config, { shellDir: makeTmpDir(), packaged: true, smokeSeconds: 2, host: 'linux' });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.data!.appDir).toBe(path.join(dir, 'out', 'linux'));
    // No arguments, on any OS: a build is started the way a player starts it. On Linux its launcher passes --no-sandbox.
    expect(r.data!.smoke!.summary.events[0]).toMatchObject({ message: 'packaged:2 args:[]' });
    expect(fs.existsSync(path.join(dir, '.gameshipper', 'app'))).toBe(false);
  });
});

describe('play --detach', () => {
  it('starts the game and returns its process ID without waiting for it', async () => {
    const dir = makeTmpDir();
    const shellDir = makeTmpDir();
    const marker = path.join(dir, 'game-ran.txt');
    const go = path.join(dir, 'go.txt');
    writeFiles(dir, { 'index.html': '<html></html>' });
    // The game waits for go.txt, so it's still running when runPlay returns however slow the machine is. Then it writes
    // its marker under another name and renames it, so the marker never exists without its contents.
    writeFiles(shellDir, {
      'main.js': [
        "const fs = require('fs');",
        "console.log('detached game says hi');",
        'const waiting = setInterval(() => {',
        `  if (!fs.existsSync(${JSON.stringify(go)})) return;`,
        '  clearInterval(waiting);',
        `  fs.writeFileSync(${JSON.stringify(`${marker}.tmp`)}, process.env.GAMESHIPPER_WINDOWED);`,
        `  fs.renameSync(${JSON.stringify(`${marker}.tmp`)}, ${JSON.stringify(marker)});`,
        '}, 20);',
      ].join('\n'),
    });
    const ctx = testCtx(dir);
    const r = await runPlay(ctx, config, { shellDir, detach: true, electronPath: process.execPath });
    try {
      expect(r.errors).toEqual([]);
      expect(typeof r.data!.pid).toBe('number');
      expect(r.data!.eventsLog!.startsWith(path.join(dir, '.gameshipper', 'logs'))).toBe(true);
      expect(alive(r.data!.pid!)).toBe(true);
      fs.writeFileSync(go, '');
      expect(await waitFor(() => fs.existsSync(marker))).toBe(true);
      expect(fs.readFileSync(marker, 'utf8')).toBe('1');
      // The game's output goes to the run log.
      expect(await waitFor(() => fs.readFileSync(ctx.logPath, 'utf8').includes('detached game says hi'))).toBe(true);
    } finally {
      // A game still waiting for go.txt would wait forever.
      if (r.data?.pid && !fs.existsSync(marker) && alive(r.data.pid)) process.kill(r.data.pid, 'SIGKILL');
    }
  });

  it('the run log shows the command it started as it was started, --no-sandbox included, for a game left running and for one played', async () => {
    for (const host of ['linux', 'darwin'] as const) {
      for (const detach of [true, false]) {
        const dir = makeTmpDir();
        const shellDir = makeTmpDir();
        const argsFile = path.join(dir, 'args.json');
        writeFiles(dir, { 'index.html': '<html></html>' });
        writeFiles(shellDir, { 'main.js': `require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));` });
        const ctx = testCtx(dir);
        const r = await runPlay(ctx, config, { shellDir, detach, electronPath: process.execPath, host });
        expect(r.errors, `${host} ${detach}`).toEqual([]);
        expect(await waitFor(() => fs.existsSync(argsFile))).toBe(true);
        const extra = host === 'linux' ? ['--no-sandbox'] : [];
        expect(await waitFor(() => fs.readFileSync(argsFile, 'utf8') === JSON.stringify(extra)), `${host} ${detach}`).toBe(true);
        const started = [process.execPath, r.data!.appDir, ...extra].join(' ');
        const log = fs.readFileSync(ctx.logPath, 'utf8');
        if (detach) expect(log, host).toContain(`started ${started} as process ${r.data!.pid}; not waiting for it\n`);
        else expect(log, host).toContain(`playing: ${started}\n`);
      }
    }
  });

  it('USAGE, before anything runs, when combined with a timed run', async () => {
    for (const timed of [{ smokeSeconds: 3 }, { screenshotAt: [5] }]) {
      const dir = makeTmpDir();
      const r = await runPlay(testCtx(dir), config, { shellDir: makeTmpDir(), detach: true, electronPath: path.join(dir, 'no-electron'), ...timed });
      expect(r.errors.map((e) => e.code), JSON.stringify(timed)).toEqual(['USAGE']);
      expect(r.errors[0].message).toBe("detach can't be combined with a timed run (smokeSeconds or screenshotAt).");
      expect(fs.existsSync(path.join(dir, '.gameshipper', 'app'))).toBe(false);
    }
  });

  it('LAUNCH_FAILED, with the reason, when the game cannot start', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<html></html>' });
    const r = await runPlay(testCtx(dir), config, { shellDir: makeTmpDir(), detach: true, electronPath: path.join(dir, 'no-electron') });
    expect(r.errors[0].code).toBe('LAUNCH_FAILED');
    expect(r.errors[0].message).toContain('ENOENT');
  });
});
