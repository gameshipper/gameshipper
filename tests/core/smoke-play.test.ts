import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { runPlay } from '../../src/core/play.js';
import { runSmoke, summaryToIssues } from '../../src/core/smoke.js';
import { LOAD_TIMEOUT_DESCRIPTION, type DiagEvent, type DiagSummary } from '../../src/shell/diagnostics.js';
import { testCtx } from '../helpers/ctx.js';
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
    expect(warnings.map((w) => w.code)).toEqual([
      'GAME_CONSOLE_WARNING',
      'GAME_NAVIGATION_BLOCKED',
      'GAME_NAVIGATION_BLOCKED',
      'GAME_USES_INTERNET',
    ]);
    expect(warnings[1].message).toBe('The game tried to leave its window for https://store.steampowered.com/app/480 (opens outside the game).');
    expect(warnings[1].fix).toContain('window.open');
    expect(warnings[2].message).toContain('(blocked)');
    expect(warnings[3].message).toContain('failed: net::ERR_INTERNET_DISCONNECTED');
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
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING']);
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
    expect(r.errors[0].message).toContain('exit code 4');
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
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING']);
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
    expect(r.warnings.map((w) => w.code)).toEqual(['ICON_MISSING']);
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
