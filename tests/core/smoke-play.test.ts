import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { electronArgs, runPlay } from '../../src/core/play.js';
import { eventsLogPath, runSmoke, summaryToIssues, truncateSummary } from '../../src/core/smoke.js';
import { LOAD_TIMEOUT_DESCRIPTION, type DiagEvent, type DiagSummary } from '../../src/shell/diagnostics.js';
import { testCtx } from '../helpers/ctx.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

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

const killIfAlive = (pid: number | null): void => {
  if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
};

describe('summaryToIssues', () => {
  it('turns diagnostics into errors and warnings with fixes', () => {
    const summary: DiagSummary = {
      droppedInfo: 0,
      events: [
        { kind: 'console', level: 'info', message: 'hello', source: '', line: 0 },
        { kind: 'console', level: 'error', message: 'Uncaught TypeError: a is undefined', source: 'app://game/main.js', line: 12 },
        { kind: 'console', level: 'error', message: 'Uncaught TypeError: a is undefined', source: 'app://game/main.js', line: 12 },
        { kind: 'missing-file', url: 'app://game/assets/Player.png' },
        { kind: 'missing-file', url: 'app://game/favicon.ico' },
        { kind: 'case-mismatch', url: 'app://game/assets/Player.png', actual: 'assets/player.png' },
        { kind: 'remote-request', url: 'https://api.example.com/score', status: 200, error: null },
        { kind: 'crashed', reason: 'oom' },
      ],
    };
    const { errors, warnings } = summaryToIssues(summary);
    expect(errors.map((e) => e.code)).toEqual(['GAME_CONSOLE_ERROR', 'GAME_FILE_MISSING', 'GAME_CRASHED']);
    expect(errors[0].message).toBe('Uncaught TypeError: a is undefined (main.js:12)');
    expect(errors[1].message).toContain('assets/Player.png');
    expect(errors[1].fix).toContain('assets/player.png');
    expect(warnings.map((w) => w.code)).toEqual(['GAME_PATH_CASE', 'GAME_USES_INTERNET']);
    expect(warnings[0].fix).toContain('Steam Deck');
    expect(warnings[0].fix).toContain('every');
  });

  it('handles every event kind the shell records', () => {
    const events: DiagEvent[] = [
      { kind: 'console', level: 'warning', message: 'deprecated API', source: '', line: 0 },
      { kind: 'console', level: 'debug', message: 'frame 1', source: '', line: 0 },
      { kind: 'load-failed', url: 'app://game/index.html', code: -6, description: 'ERR_FILE_NOT_FOUND' },
      { kind: 'blocked-navigation', url: 'https://store.steampowered.com/app/480', action: 'opened-externally' },
      { kind: 'blocked-navigation', url: 'file:///etc/passwd', action: 'blocked' },
      { kind: 'remote-request', url: 'https://cdn.example.com/x.js', status: null, error: 'net::ERR_INTERNET_DISCONNECTED' },
    ];
    const { errors, warnings } = summaryToIssues({ droppedInfo: 0, events });
    expect(errors.map((e) => e.code)).toEqual(['GAME_LOAD_FAILED']);
    expect(errors[0].message).toContain('ERR_FILE_NOT_FOUND');
    expect(errors[0].fix).toContain('game.entry');
    expect(warnings.map((w) => w.code)).toEqual(['GAME_CONSOLE_WARNING', 'GAME_NAVIGATION_BLOCKED', 'GAME_USES_INTERNET']);
    expect(warnings[1].message).toBe('The game tried to leave its window for file:///etc/passwd (blocked).');
    expect(warnings[1].fix).toContain('steam:');
    // Electron can't tell which frame opened a window, so an embedded site blocks the game's own new windows too.
    expect(warnings[1].fix).toContain("even the game's own window.open() and target=\"_blank\" links are blocked");
    expect(warnings[2].message).toContain('failed: net::ERR_INTERNET_DISCONNECTED');
  });

  it('a link the game opened in the browser is no issue; only blocked ones are', () => {
    const opened: DiagEvent[] = [
      { kind: 'blocked-navigation', url: 'https://store.steampowered.com/app/480', action: 'opened-externally' },
      { kind: 'blocked-navigation', url: 'mailto:help@example.com', action: 'opened-externally' },
    ];
    expect(summaryToIssues({ droppedInfo: 0, events: opened })).toEqual({ errors: [], warnings: [] });
    const blocked: DiagEvent = { kind: 'blocked-navigation', url: 'about:blank', action: 'blocked' };
    expect(summaryToIssues({ droppedInfo: 0, events: [...opened, blocked] }).warnings.map((w) => [w.code, w.message])).toEqual([
      ['GAME_NAVIGATION_BLOCKED', 'The game tried to leave its window for about:blank (blocked).'],
    ]);
  });

  it("says when the shell's backstop found the page never finished loading", () => {
    const events: DiagEvent[] = [{ kind: 'load-failed', url: 'app://game/index.html', code: 0, description: LOAD_TIMEOUT_DESCRIPTION }];
    expect(summaryToIssues({ droppedInfo: 0, events }, { seconds: 3 }).errors).toEqual([
      {
        code: 'GAME_LOAD_FAILED',
        message: "The game's page never finished loading within 33 seconds.",
        fix: 'Something the page waits for never arrived: check the events log for requests that never completed, or a script that never returns.',
      },
    ]);
    expect(summaryToIssues({ droppedInfo: 0, events }).errors[0].message).toBe("The game's page never finished loading.");
  });

  it("says when a missing file is store art the build left out", () => {
    const events: DiagEvent[] = [
      { kind: 'missing-file', url: 'app://game/img/titles1/Logo.png' },
      { kind: 'missing-file', url: 'app://game/img/key%20art.png?v=2' },
      { kind: 'missing-file', url: 'app://game/img/other.png' },
    ];
    const { errors } = summaryToIssues({ droppedInfo: 0, events }, { storeArt: ['Logo.png', 'key art.png'] });
    expect(errors.map((e) => e.code)).toEqual(['GAME_FILE_MISSING', 'GAME_FILE_MISSING', 'GAME_FILE_MISSING']);
    for (const e of errors.slice(0, 2)) {
      expect(e.fix).toBe(
        "This file was left out of the build because it's your store art; if the game shows it, mention its name in the game's code or set it apart from keyArt/logo.",
      );
    }
    expect(errors[2].fix).toContain('spelling');
    expect(summaryToIssues({ droppedInfo: 0, events }).errors[0].fix).toContain('spelling');
  });

  it('ignores event kinds from a newer shell instead of failing', () => {
    const events = [{ kind: 'from-the-future', detail: 1 }] as unknown as DiagEvent[];
    expect(summaryToIssues({ droppedInfo: 0, events })).toEqual({ errors: [], warnings: [] });
  });
});

function project(fakeMain: string) {
  const dir = makeTmpDir();
  const shellDir = makeTmpDir();
  writeFiles(dir, { 'index.html': '<html></html>' });
  writeFiles(shellDir, { 'main.js': fakeMain });
  return { dir, shellDir };
}
const config = parseConfig({ name: 'x', version: '1.0.0' }).data!;

describe('runPlay --smoke', () => {
  it('reports problems found while the game ran', async () => {
    const { dir, shellDir } = project(`
      const summary = { droppedInfo: 0, events: [{ kind: 'console', level: 'error', message: 'boom', source: 'app://game/main.js', line: 1 }] };
      require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify(summary));
    `);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['GAME_CONSOLE_ERROR']);
    expect(r.data!.smoke!.summary.events).toHaveLength(1);
    expect(r.data!.smoke!.eventsLog.startsWith(path.join(dir, '.gameshipper', 'logs'))).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STEAM_SDK_MISSING']);
  });

  it('points a missing file at the store art it left out', async () => {
    const { dir, shellDir } = project(`
      const summary = { droppedInfo: 0, events: [{ kind: 'missing-file', url: 'app://game/art/Logo.png' }] };
      require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify(summary));
    `);
    writeFiles(dir, { 'art/Logo.png': 'logo' });
    const r = await runPlay(testCtx(dir), parseConfig({ name: 'x', version: '1.0.0', logo: 'art/Logo.png' }).data!, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.errors).toEqual([expect.objectContaining({ code: 'GAME_FILE_MISSING', fix: expect.stringContaining('store art') })]);
  });

  it('passes the smoke settings to the game process', async () => {
    const { dir, shellDir } = project(`
      const env = process.env;
      const events = [{ kind: 'console', level: 'info', message: [env.GAMESHIPPER_SMOKE_SECONDS, env.GAMESHIPPER_WINDOWED, env.GAMESHIPPER_USER_DATA].join('|'), source: '', line: 0 }];
      require('fs').writeFileSync(env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events }));
    `);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 7, electronPath: process.execPath });
    expect(r.ok).toBe(true);
    const first = r.data!.smoke!.summary.events[0];
    expect(first).toMatchObject({ message: `7|1|${path.join(dir, '.gameshipper', 'play-data')}` });
  });

  it('SMOKE_NO_RESULT when the game never reports back', async () => {
    const { dir, shellDir } = project('process.exitCode = 4;');
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.errors[0].code).toBe('SMOKE_NO_RESULT');
    expect(r.errors[0].message).toBe("The game didn't report back (exit code 4).");
  });

  it('SMOKE_NO_RESULT quotes the last lines the game printed: why it stopped before it could report', async () => {
    const { dir, shellDir } = project(`console.error('FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!'); process.exitCode = 4;`);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([
      ['SMOKE_NO_RESULT', "The game didn't report back (exit code 4). Last lines of its output:\nFATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!"],
    ]);
  });

  it('starts Electron without Chromium\'s sandbox on Linux, on its command line, where Chromium reads it in time', async () => {
    expect(electronArgs('/game/app', 'linux')).toEqual(['/game/app', '--no-sandbox']);
    for (const platform of ['darwin', 'win32'] as const) expect(electronArgs('/game/app', platform)).toEqual(['/game/app']);
    const { dir, shellDir } = project(`
      const events = [{ kind: 'console', level: 'info', message: JSON.stringify(process.argv.slice(2)), source: '', line: 0 }];
      require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events }));
    `);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.data!.smoke!.summary.events[0]).toMatchObject({ message: JSON.stringify(process.platform === 'linux' ? ['--no-sandbox'] : []) });
  });

  it('reports a page that never finished loading against the smoke duration', async () => {
    const { dir, shellDir } = project(`
      const events = [{ kind: 'load-failed', url: 'app://game/index.html', code: 0, description: ${JSON.stringify(LOAD_TIMEOUT_DESCRIPTION)} }];
      require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events }));
    `);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 2, electronPath: process.execPath });
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([['GAME_LOAD_FAILED', "The game's page never finished loading within 32 seconds."]]);
  });

  it('SMOKE_NO_RESULT when the report is not valid JSON', async () => {
    const { dir, shellDir } = project(`require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, '{"events": [');`);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.errors[0].code).toBe('SMOKE_NO_RESULT');
  });

  it('LAUNCH_FAILED when Electron is missing', async () => {
    const { dir, shellDir } = project('');
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: path.join(dir, 'no-electron') });
    expect(r.errors[0].code).toBe('LAUNCH_FAILED');
    expect(r.errors[0].fix).toBe('Reinstall Gameshipper (e.g. `npx gameshipper@latest`), or check the build exists.');
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STEAM_SDK_MISSING']);
  });

  it('an unusable icon is only a warning: the game runs with the default icon', async () => {
    const { dir, shellDir } = project(`require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));`);
    writeFiles(dir, { 'small.png': makeSolidPng(512, 512), 'wide.png': makeSolidPng(2048, 1024), 'fake.png': 'GIF89a' });
    for (const [icon, code] of [
      ['small.png', 'ICON_TOO_SMALL'],
      ['wide.png', 'ICON_NOT_SQUARE'],
      ['fake.png', 'ICON_INVALID'],
    ]) {
      const withIcon = parseConfig({ name: 'x', version: '1.0.0', icon }).data!;
      const r = await runPlay(testCtx(dir), withIcon, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
      expect([r.ok, r.errors]).toEqual([true, []]);
      expect(r.warnings).toEqual([
        { code, message: expect.stringMatching(new RegExp(`^${icon.replace('.', '\\.')} .+ Playing with the default icon; \`build\` fails until it's fixed\.$`)), fix: expect.stringContaining('gameshipper.json') },
        expect.objectContaining({ code: 'STEAM_SDK_MISSING' }),
      ]);
      expect(fs.existsSync(path.join(r.data!.appDir, 'shell', 'icon.png'))).toBe(false);
    }
  });

  it('frozenLock reaches CDN bundling', async () => {
    const { dir, shellDir } = project('');
    writeFiles(dir, { 'index.html': '<script src="https://cdn.example.invalid/lib.js"></script>' });
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, frozenLock: true, electronPath: process.execPath });
    expect(r.errors[0].code).toBe('CDN_NOT_LOCKED');
  });
});

describe('runPlay', () => {
  it('runs the game until it closes, with an events log and no smoke settings', async () => {
    const { dir, shellDir } = project(`
      const env = process.env;
      require('fs').writeFileSync(require('path').join(env.GAMESHIPPER_USER_DATA, '..', 'env.json'), JSON.stringify(env));
    `);
    fs.mkdirSync(path.join(dir, '.gameshipper', 'play-data'), { recursive: true });
    const r = await runPlay(testCtx(dir), config, { shellDir, fullscreen: true, electronPath: process.execPath });
    expect(r.ok).toBe(true);
    expect(r.data!.eventsLog!.startsWith(path.join(dir, '.gameshipper', 'logs'))).toBe(true);
    const env = JSON.parse(fs.readFileSync(path.join(dir, '.gameshipper', 'env.json'), 'utf8')) as Record<string, string>;
    expect(env.GAMESHIPPER_LOG).toBe(r.data!.eventsLog);
    expect(env.GAMESHIPPER_WINDOWED).toBe('');
    expect(env.GAMESHIPPER_SMOKE_SECONDS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('runPlay on Ctrl+C', () => {
  /**
   * A game that says when it's running, and on SIGTERM takes a moment to save before it quits. It quits by letting its
   * event loop run out, never with process.exit(): it inherits NODE_USE_SYSTEM_CA=1, and on a busy machine Node 24.7
   * can still be reading the system certificates then, which crashes it (SIGSEGV) instead of exiting with code 0.
   */
  const SAVES_ON_QUIT = `
    const fs = require('fs');
    const path = require('path');
    const dir = process.env.GAMESHIPPER_USER_DATA;
    const running = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(path.join(dir, 'saved.txt'), 'yes'); clearInterval(running); }, 200));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'running.txt'), '');
  `;

  async function interrupt(smokeSeconds?: number) {
    const { dir, shellDir } = project(SAVES_ON_QUIT);
    const userData = path.join(dir, '.gameshipper', 'play-data');
    const cli = vi.fn(); // stands in for the CLI's own handler, which decides how Gameshipper exits
    process.on('SIGINT', cli);
    try {
      const playing = runPlay(testCtx(dir), config, { shellDir, smokeSeconds, electronPath: process.execPath });
      expect(await waitFor(() => fs.existsSync(path.join(userData, 'running.txt')), 20_000)).toBe(true);
      process.emit('SIGINT', 'SIGINT');
      return { result: await playing, saved: fs.existsSync(path.join(userData, 'saved.txt')) };
    } finally {
      process.off('SIGINT', cli);
    }
  }

  it('asks an interactive game to quit, so it can finish saving', async () => {
    const { result, saved } = await interrupt();
    expect(result.ok).toBe(true);
    expect(saved).toBe(true);
  });

  it('stops a smoke run at once', async () => {
    const { result, saved } = await interrupt(30);
    expect(result.errors.map((e) => e.code)).toEqual(['SMOKE_NO_RESULT']);
    expect(result.errors[0].message).toContain('SIGKILL');
    expect(saved).toBe(false);
  });
});

describe('runPlay onGameStarted', () => {
  it('reports the data and warnings of an interactive run once its game is running', async () => {
    const { dir, shellDir } = project('');
    const started = vi.fn();
    const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath, onGameStarted: started });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(r.data, r.warnings);
  });

  it('is not called when the game never starts, or for a smoke run', async () => {
    const started = vi.fn();
    const missing = project('');
    fs.rmSync(path.join(missing.dir, 'index.html'));
    expect((await runPlay(testCtx(missing.dir), config, { shellDir: missing.shellDir, electronPath: process.execPath, onGameStarted: started })).errors[0].code).toBe('ENTRY_MISSING');
    const smoke = project(`require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));`);
    await runPlay(testCtx(smoke.dir), config, { shellDir: smoke.shellDir, smokeSeconds: 1, electronPath: process.execPath, onGameStarted: started });
    expect(started).not.toHaveBeenCalled();
  });
});

describe('runPlay when the game dies', () => {
  it('GAME_EXITED when the game quits with an error, with the last lines of its output', async () => {
    const { dir, shellDir } = project(`console.log('starting'); console.error('Error: save file corrupt'); process.exitCode = 1;`);
    const ctx = testCtx(dir);
    const r = await runPlay(ctx, config, { shellDir, electronPath: process.execPath });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['GAME_EXITED']);
    expect(r.errors[0].message).toContain('exit code 1');
    expect(r.errors[0].message).toContain('starting');
    expect(r.errors[0].message).toContain('Error: save file corrupt');
    expect(r.errors[0].fix).toContain(ctx.logPath);
    expect(r.errors[0].fix).toContain('npx gameshipper play --smoke --json');
    expect(r.data!.eventsLog!.startsWith(path.join(dir, '.gameshipper', 'logs'))).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING', 'STEAM_SDK_MISSING']);
  });

  it('GAME_EXITED keeps only the last 20 lines of output', async () => {
    const { dir, shellDir } = project(`for (let i = 1; i <= 30; i++) console.log('line ' + i); process.exitCode = 2;`);
    const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath });
    const { message } = r.errors[0];
    expect(message).toContain('exit code 2');
    expect(message).toMatch(/^line 30$/m);
    expect(message).toMatch(/^line 11$/m);
    expect(message).not.toMatch(/^line 10$/m);
  });

  it.skipIf(process.platform === 'win32')('GAME_EXITED when something else kills the game', async () => {
    const { dir, shellDir } = project(`process.kill(process.pid, 'SIGTERM');`);
    const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath });
    expect(r.errors.map((e) => e.code)).toEqual(['GAME_EXITED']);
    expect(r.errors[0].message).toContain('SIGTERM');
  });
});

describe('runSmoke', () => {
  /** A fake game that starts a helper sharing its output (like Electron's GPU process), then never exits. */
  const HANGS = (writeSummary: boolean) => `
    const fs = require('fs');
    const path = require('path');
    const helper = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync(path.join(process.env.GAMESHIPPER_USER_DATA, 'helper.pid'), String(helper.pid));
    ${writeSummary ? "fs.writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [{ kind: 'console', level: 'info', message: 'started', source: '', line: 0 }] }));" : ''}
    setInterval(() => {}, 1000);
  `;

  function hangingGame(writeSummary: boolean) {
    const dir = makeTmpDir();
    const userDataDir = makeTmpDir();
    writeFiles(dir, { 'game.js': HANGS(writeSummary) });
    return { dir, userDataDir, pidFile: path.join(userDataDir, 'helper.pid') };
  }

  it('stops a game that never exits, with everything it started, and reports SMOKE_TIMEOUT', async () => {
    const { dir, userDataDir, pidFile } = hangingGame(false);
    const started = Date.now();
    try {
      const r = await runSmoke(testCtx(dir), {
        command: process.execPath,
        args: [path.join(dir, 'game.js')],
        seconds: 1,
        userDataDir,
        windowed: true,
        timeoutMs: 1000,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.code)).toEqual(['SMOKE_NO_RESULT', 'SMOKE_TIMEOUT']);
      expect(r.errors[1].message).toContain('1 second');
      const pid = readPid(pidFile);
      expect(pid).not.toBeNull();
      expect(await waitFor(() => !alive(pid!))).toBe(true);
    } finally {
      killIfAlive(readPid(pidFile));
    }
  });

  it('still reports the summary when a game that wrote one never exits', async () => {
    const { dir, userDataDir, pidFile } = hangingGame(true);
    try {
      const r = await runSmoke(testCtx(dir), {
        command: process.execPath,
        args: [path.join(dir, 'game.js')],
        seconds: 1,
        userDataDir,
        windowed: true,
        timeoutMs: 1000,
      });
      expect(r.errors.map((e) => e.code)).toEqual(['SMOKE_TIMEOUT']);
      expect(r.data!.summary.events).toHaveLength(1);
      expect(r.data!.exitCode).toBeNull();
    } finally {
      killIfAlive(readPid(pidFile));
    }
  });

  it('finishes when the game exits but a helper process keeps its output open', async () => {
    const dir = makeTmpDir();
    const userDataDir = makeTmpDir();
    const pidFile = path.join(userDataDir, 'helper.pid');
    writeFiles(dir, {
      'game.js': `
        const fs = require('fs');
        const helper = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
        fs.writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));
        helper.unref();
        process.exitCode = 0;
      `,
    });
    const started = Date.now();
    try {
      const r = await runSmoke(testCtx(dir), { command: process.execPath, args: [path.join(dir, 'game.js')], seconds: 1, userDataDir, windowed: true });
      expect(r.ok).toBe(true);
      expect(r.data!.exitCode).toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
      const pid = readPid(pidFile);
      expect(await waitFor(() => !alive(pid!))).toBe(true);
    } finally {
      killIfAlive(readPid(pidFile));
    }
  });

  it('removes its signal and exit handlers when the game is done', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'game.js': 'process.exitCode = 0;' });
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const;
    const counts = () => events.map((e) => process.listenerCount(e));
    const before = counts();
    await runSmoke(testCtx(dir), { command: process.execPath, args: [path.join(dir, 'game.js')], seconds: 1, userDataDir: makeTmpDir(), windowed: true });
    expect(counts()).toEqual(before);
  });
});

describe('bounded smoke output for noisy games', () => {
  const consoleError = (i: number): DiagEvent => ({ kind: 'console', level: 'error', message: `error ${i}`, source: 'app://game/main.js', line: i });

  it('reports at most 10 issues per code, then one issue counting the rest', () => {
    const events: DiagEvent[] = Array.from({ length: 20_000 }, (_, i) => consoleError(i));
    const { errors } = summaryToIssues({ droppedInfo: 0, events }, { eventsLog: '/p/events.jsonl' });
    expect(errors).toHaveLength(11);
    expect(errors.slice(0, 10).map((e) => e.message)).toEqual(Array.from({ length: 10 }, (_, i) => `error ${i} (main.js:${i})`));
    expect(errors[10]).toEqual({
      code: 'GAME_CONSOLE_ERROR',
      message: '…and 19990 more like this (see the events log)',
      fix: 'Every one is listed in /p/events.jsonl.',
    });
  });

  it('caps each code on its own and keeps the count next to its code', () => {
    const events: DiagEvent[] = [];
    for (let i = 0; i < 5000; i++) {
      events.push(
        consoleError(i),
        { kind: 'missing-file', url: `app://game/img/${i}.png` },
        { kind: 'remote-request', url: `https://cdn.example.com/${i}.js`, status: 200, error: null },
        { kind: 'console', level: 'warning', message: `warning ${i}`, source: '', line: 0 },
      );
    }
    const { errors, warnings } = summaryToIssues({ droppedInfo: 0, events });
    const shape = (list: { code: string; message: string }[]) => list.map((e) => (e.message.startsWith('…and') ? `${e.code} +` : e.code));
    // Issues keep the order the game hit them in; each count follows the last issue with its code.
    const pairs = (a: string, b: string) => [...Array.from({ length: 9 }, () => [a, b]).flat(), a, `${a} +`, b, `${b} +`];
    expect(shape(errors)).toEqual(pairs('GAME_CONSOLE_ERROR', 'GAME_FILE_MISSING'));
    expect(shape(warnings)).toEqual(pairs('GAME_USES_INTERNET', 'GAME_CONSOLE_WARNING'));
    const more = errors.find((e) => e.message.startsWith('…and'))!;
    expect(more).toEqual({ code: 'GAME_CONSOLE_ERROR', message: '…and 4990 more like this (see the events log)', fix: 'Every one is listed in the events log.' });
  });

  it('keeps the first 100 events in the result, with counts, and the full detail on disk', async () => {
    const { dir, shellDir } = project(`
      const events = [];
      for (let i = 0; i < 20000; i++) events.push({ kind: 'console', level: 'error', message: 'error ' + i + ' ' + 'x'.repeat(100), source: 'app://game/main.js', line: i });
      require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 7, events }));
    `);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    const smoke = r.data!.smoke!;
    expect(smoke.summary.events).toHaveLength(100);
    expect(smoke.summary.events[0]).toMatchObject({ message: expect.stringMatching(/^error 0 /) });
    expect(smoke.summary.truncatedEvents).toBe(19_900);
    expect(smoke.summary.droppedInfo).toBe(7);
    expect(fs.existsSync(smoke.eventsLog)).toBe(true);
    expect(r.errors).toHaveLength(11);
    expect(r.errors[10].fix).toBe(`Every one is listed in ${smoke.eventsLog}.`);
    expect(JSON.stringify(r).length).toBeLessThan(40_000);
  });

  it('reports truncatedEvents 0 when nothing was left out', async () => {
    const { dir, shellDir } = project(`require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));`);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.data!.smoke!.summary).toEqual({ events: [], droppedInfo: 0, truncatedEvents: 0 });
  });
});

describe('long messages', () => {
  const more = (n: number) => `… (${n} more characters; see the events log)`;

  it('cuts any message or URL over 2,000 characters in the issues', () => {
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const longUrl = `app://game/${'a'.repeat(3000)}.png`;
    const events: DiagEvent[] = [
      { kind: 'console', level: 'error', message: huge, source: 'app://game/main.js', line: 1 },
      { kind: 'missing-file', url: longUrl },
      { kind: 'console', level: 'warning', message: 'y'.repeat(2000), source: '', line: 0 },
    ];
    const { errors, warnings } = summaryToIssues({ droppedInfo: 0, events });
    expect(errors[0].message).toBe(`${'x'.repeat(2000)}${more(huge.length - 2000)} (main.js:1)`);
    expect(errors[1].message).toContain(more(longUrl.length - 2000));
    expect(errors[1].message.length).toBeLessThan(2200);
    expect(warnings[0].message).toBe('y'.repeat(2000)); // exactly the limit: kept whole
  });

  it('cuts them in the events a smoke result keeps too, leaving other events as they were', () => {
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const short: DiagEvent = { kind: 'missing-file', url: 'app://game/a.png' };
    const kept = truncateSummary({ droppedInfo: 0, events: [{ kind: 'console', level: 'error', message: huge, source: '', line: 0 }, short] });
    expect(kept.events[0]).toEqual({ kind: 'console', level: 'error', message: `${'x'.repeat(2000)}${more(huge.length - 2000)}`, source: '', line: 0 });
    expect(kept.events[1]).toBe(short);
    expect(JSON.stringify(kept).length).toBeLessThan(3000);
  });

  it('keeps a smoke result small when the game logs a 5 MB error', async () => {
    const { dir, shellDir } = project(`
      const events = [{ kind: 'console', level: 'error', message: 'x'.repeat(5 * 1024 * 1024), source: 'app://game/main.js', line: 1 }];
      require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events }));
    `);
    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(r.errors.map((e) => e.code)).toEqual(['GAME_CONSOLE_ERROR']);
    expect(JSON.stringify(r).length).toBeLessThan(10_000);
  });
});

describe('smoke summaries', () => {
  const WRITES_SUMMARY = `require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));`;

  it('each run writes its own summary next to its events log, with the same timestamp', async () => {
    const { dir, shellDir } = project(WRITES_SUMMARY);
    const first = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    const second = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });
    const logs = path.join(dir, '.gameshipper', 'logs');
    const stamp = (eventsLog: string) => /events-(.+)\.jsonl$/.exec(eventsLog)![1];
    const expected = [first, second].map((r) => `smoke-${stamp(r.data!.smoke!.eventsLog)}.json`);
    expect(new Set(expected).size).toBe(2);
    expect(fs.readdirSync(logs).filter((f) => f.startsWith('smoke-')).sort()).toEqual(expected.sort());
    expect(fs.readdirSync(path.join(dir, '.gameshipper')).filter((f) => f.startsWith('smoke'))).toEqual([]);
  });

  it('keeps the newest 20 summaries and 20 events logs, and nothing else is touched', async () => {
    const { dir, shellDir } = project(WRITES_SUMMARY);
    const logs = path.join(dir, '.gameshipper', 'logs');
    const old = (i: number) => `2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z`;
    const files: Record<string, string> = { 'play-2020-01-01T00-00-00-000Z.log': '', 'notes.txt': '' };
    for (let i = 0; i < 25; i++) {
      files[`events-${old(i)}.jsonl`] = '';
      files[`smoke-${old(i)}.json`] = '{}';
    }
    writeFiles(logs, files);

    const r = await runPlay(testCtx(dir), config, { shellDir, smokeSeconds: 1, electronPath: process.execPath });

    const left = fs.readdirSync(logs).sort();
    const kept = (prefix: string) => left.filter((f) => f.startsWith(prefix));
    // The 19 newest older ones, plus this run's.
    const newest19 = (prefix: string, ext: string) => Array.from({ length: 19 }, (_, i) => `${prefix}${old(i + 6)}${ext}`);
    expect(kept('events-')).toEqual([...newest19('events-', '.jsonl'), path.basename(r.data!.smoke!.eventsLog)]);
    expect(kept('smoke-')).toEqual([...newest19('smoke-', '.json'), path.basename(r.data!.smoke!.eventsLog).replace(/^events-(.+)\.jsonl$/, 'smoke-$1.json')]);
    expect(left).toContain('play-2020-01-01T00-00-00-000Z.log');
    expect(left).toContain('notes.txt');
  });

  it('interactive play prunes old events logs too', () => {
    const dir = makeTmpDir();
    const logs = path.join(dir, '.gameshipper', 'logs');
    writeFiles(logs, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`events-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z.jsonl`, ''])));
    eventsLogPath(dir);
    expect(fs.readdirSync(logs).filter((f) => f.startsWith('events-'))).toHaveLength(20);
  });
});

describe('events log', () => {
  it('exists from the start of every run, even when the game records nothing', async () => {
    const smoke = project(`require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));`);
    const s = await runPlay(testCtx(smoke.dir), config, { shellDir: smoke.shellDir, smokeSeconds: 1, electronPath: process.execPath });
    expect(fs.readFileSync(s.data!.smoke!.eventsLog, 'utf8')).toBe('');

    const play = project('');
    const p = await runPlay(testCtx(play.dir), config, { shellDir: play.shellDir, electronPath: process.execPath });
    expect(fs.existsSync(p.data!.eventsLog!)).toBe(true);

    // A game that never reports back still leaves the log its errors point at.
    const silent = project('process.exitCode = 4;');
    const n = await runPlay(testCtx(silent.dir), config, { shellDir: silent.shellDir, smokeSeconds: 1, electronPath: process.execPath });
    const logPath = /Details: (\S+\.jsonl) and/.exec(n.errors[0].fix!)![1];
    expect(fs.existsSync(logPath)).toBe(true);
  });
});
