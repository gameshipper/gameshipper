import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ok } from '../../src/core/result.js';
import { saveLastRun } from '../../src/core/runs.js';
import { canRunTs, noteIfTsTestsSkipped } from '../helpers/node-features.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

/** These run the real CLI in its own process: signals and process-level errors can't be tested in-process. */

const RUNNER = fileURLToPath(new URL('../helpers/run-cli.mjs', import.meta.url));
const SLEEPS = `node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)"`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = (dir: string): number | null => {
  try {
    const pid = Number(readText(dir, 'pid.txt'));
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

/** A game whose build command never finishes, after an earlier build that succeeded. */
function sleepingBuild(): string {
  const dir = makeTmpDir();
  writeFiles(dir, { 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0', game: { buildCommand: SLEEPS, outputDir: 'dist' } }) });
  saveLastRun(dir, 'build', ok({}));
  return dir;
}

/**
 * `slow-load` announces "loading" on stderr, then takes 3 s to load the CLI, as a slow disk might.
 * `busy-load` loads it, announces "loading", then blocks for 1.5 s, as synchronous module loading does.
 */
function startCli(
  args: string[],
  failure: 'none' | 'rejection' | 'exception' | 'slow-load' | 'busy-load' = 'none',
  env: NodeJS.ProcessEnv = {},
) {
  const child = spawn(process.execPath, [RUNNER, failure, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

noteIfTsTestsSkipped('the CLI process tests');

/**
 * A stand-in for Electron (the runner uses it when GS_TEST_ELECTRON is set): it says when it's running,
 * and on SIGTERM takes a moment to save before it quits.
 */
function fakeElectron(): string {
  const file = path.join(makeTmpDir(), 'electron');
  fs.writeFileSync(
    file,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = process.env.GAMESHIPPER_USER_DATA;
fs.mkdirSync(dir, { recursive: true });
process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(path.join(dir, 'saved.txt'), 'yes'); process.exit(0); }, 200));
fs.writeFileSync(path.join(dir, 'running.txt'), '');
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function playableGame(game: object = {}): string {
  const dir = makeTmpDir();
  writeFiles(dir, { 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0', game }), 'index.html': '<html></html>' });
  return dir;
}

/** The newest run log of `command` in the project, or '' if there is none yet. */
function runLog(dir: string, command: string): string {
  const logs = path.join(dir, '.gameshipper', 'logs');
  const file = fs.existsSync(logs) ? fs.readdirSync(logs).filter((f) => f.startsWith(`${command}-`)).sort().pop() : undefined;
  return file ? readText(logs, file) : '';
}

describe.skipIf(process.platform === 'win32' || !canRunTs)('the CLI process', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s during a build prints one INTERRUPTED Result, exits %i, stops the build and records the run', async (signal, code) => {
    const dir = sleepingBuild();
    const cli = startCli(['build', '--json', '--dir', dir]);
    try {
      expect(await waitFor(() => readPid(dir) !== null, 20_000)).toBe(true);
      cli.child.kill(signal);
      expect(await cli.closed).toEqual({ code, signal: null });
      // Exactly one JSON document on stdout.
      const result = JSON.parse(cli.stdout());
      expect(result).toMatchObject({
        ok: false,
        errors: [{ code: 'INTERRUPTED', message: `Stopped by ${signal} before finishing.`, fix: "Run the command again when you're ready." }],
      });
      expect(result.logPath).toMatch(/build-.+\.log$/);
      expect(await waitFor(() => !alive(readPid(dir)!))).toBe(true);
      expect(JSON.parse(readText(dir, '.gameshipper/last/build.json'))).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }] });
    } finally {
      cli.child.kill('SIGKILL');
      const pid = readPid(dir);
      if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('tells a person at a terminal that the run was interrupted', async () => {
    const dir = sleepingBuild();
    const cli = startCli(['build', '--dir', dir]);
    try {
      expect(await waitFor(() => readPid(dir) !== null, 20_000)).toBe(true);
      cli.child.kill('SIGINT');
      expect((await cli.closed).code).toBe(130);
      const lines = cli.stdout().trimEnd().split('\n');
      expect(lines[0]).toBe('✗ INTERRUPTED: Stopped by SIGINT before finishing.');
      expect(lines.at(-1)).toMatch(/^Log: .+build-.+\.log$/);
    } finally {
      cli.child.kill('SIGKILL');
      const pid = readPid(dir);
      if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('Ctrl+C during interactive play lets the game quit, records an ok play with PLAY_STOPPED, and exits 130', async () => {
    const dir = playableGame();
    const cli = startCli(['play', '--json', '--dir', dir], 'none', { GS_TEST_ELECTRON: fakeElectron() });
    const playData = path.join(dir, '.gameshipper', 'play-data');
    try {
      expect(await waitFor(() => fs.existsSync(path.join(playData, 'running.txt')), 20_000)).toBe(true);
      cli.child.kill('SIGINT');
      expect(await cli.closed).toEqual({ code: 130, signal: null });
      const result = JSON.parse(cli.stdout());
      // What the run found before the game started stays in the result.
      expect(result).toMatchObject({
        ok: true,
        errors: [],
        warnings: [{ code: 'ICON_MISSING' }, { code: 'STEAM_SDK_MISSING' }, { code: 'PLAY_STOPPED', message: 'Stopped by Ctrl+C.' }],
        data: { appDir: path.join(dir, '.gameshipper', 'app'), eventsLog: expect.stringMatching(/events-.+\.jsonl$/) },
      });
      expect(result.warnings).toHaveLength(3);
      expect(fs.existsSync(result.data.eventsLog)).toBe(true);
      expect(result.logPath).toMatch(/play-.+\.log$/);
      // The game finished saving before Gameshipper exited.
      expect(readText(playData, 'saved.txt')).toBe('yes');
      expect(JSON.parse(readText(dir, '.gameshipper/last/play.json'))).toMatchObject({ ok: true });
    } finally {
      cli.child.kill('SIGKILL');
    }
  });

  it("Ctrl+C before an interactive game starts (during its build step) is an INTERRUPTED failure", async () => {
    const dir = playableGame({ buildCommand: 'sleep 30', outputDir: '.' });
    const cli = startCli(['play', '--json', '--dir', dir], 'none', { GS_TEST_ELECTRON: fakeElectron() });
    try {
      expect(await waitFor(() => runLog(dir, 'play').includes('running build command: sleep 30'), 20_000)).toBe(true);
      cli.child.kill('SIGINT');
      expect(await cli.closed).toEqual({ code: 130, signal: null });
      expect(JSON.parse(cli.stdout())).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }], warnings: [] });
      expect(JSON.parse(readText(dir, '.gameshipper/last/play.json'))).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }] });
    } finally {
      cli.child.kill('SIGKILL');
    }
  });

  it('Ctrl+C during a smoke run is still an INTERRUPTED failure', async () => {
    const dir = playableGame();
    const cli = startCli(['play', '--smoke', '--seconds', '30', '--json', '--dir', dir], 'none', { GS_TEST_ELECTRON: fakeElectron() });
    try {
      expect(await waitFor(() => fs.existsSync(path.join(dir, '.gameshipper', 'play-data', 'running.txt')), 20_000)).toBe(true);
      cli.child.kill('SIGINT');
      expect(await cli.closed).toEqual({ code: 130, signal: null });
      expect(JSON.parse(cli.stdout())).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }] });
      expect(JSON.parse(readText(dir, '.gameshipper/last/play.json'))).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }] });
    } finally {
      cli.child.kill('SIGKILL');
    }
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s while the CLI is still loading prints an INTERRUPTED Result and exits %i', async (signal, code) => {
    const cli = startCli(['status', '--json', '--dir', makeTmpDir()], 'slow-load');
    const started = Date.now();
    try {
      expect(await waitFor(() => cli.stderr().includes('loading'), 10_000)).toBe(true);
      cli.child.kill(signal);
      expect(await cli.closed).toEqual({ code, signal: null });
      expect(Date.now() - started).toBeLessThan(3000); // before the CLI finished loading
      expect(JSON.parse(cli.stdout())).toEqual({
        ok: false,
        errors: [{ code: 'INTERRUPTED', message: `Stopped by ${signal} before finishing.`, fix: "Run the command again when you're ready." }],
        warnings: [],
      });
    } finally {
      cli.child.kill('SIGKILL');
    }
  });

  it('a signal that arrives while loading blocks the process is handed to the CLI, not dropped', async () => {
    const cli = startCli(['status', '--json', '--dir', makeTmpDir()], 'busy-load');
    try {
      expect(await waitFor(() => cli.stderr().includes('loading'), 10_000)).toBe(true);
      cli.child.kill('SIGINT');
      expect(await cli.closed).toEqual({ code: 130, signal: null });
      expect(JSON.parse(cli.stdout())).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }] });
    } finally {
      cli.child.kill('SIGKILL');
    }
  });

  it('says so in one line to a person when stopped while loading', async () => {
    const cli = startCli(['status', '--dir', makeTmpDir()], 'slow-load');
    try {
      expect(await waitFor(() => cli.stderr().includes('loading'), 10_000)).toBe(true);
      cli.child.kill('SIGINT');
      expect((await cli.closed).code).toBe(130);
      expect(cli.stdout()).toBe("✗ INTERRUPTED: Stopped by SIGINT before finishing. Run the command again when you're ready.\n");
    } finally {
      cli.child.kill('SIGKILL');
    }
  });

  it.each(['rejection', 'exception'] as const)('an unhandled async %s prints one INTERNAL_ERROR Result and exits 1', async (failure) => {
    const dir = sleepingBuild();
    const cli = startCli(['build', '--json', '--dir', dir], failure);
    try {
      expect(await cli.closed).toEqual({ code: 1, signal: null });
      const result = JSON.parse(cli.stdout());
      expect(result).toMatchObject({ ok: false, errors: [{ code: 'INTERNAL_ERROR', message: 'Unexpected error: async boom' }] });
      expect(readText(path.dirname(result.logPath), path.basename(result.logPath))).toMatch(/Error: async boom\n\s+at /);
      expect(await waitFor(() => !alive(readPid(dir)!))).toBe(true);
      expect(JSON.parse(readText(dir, '.gameshipper/last/build.json'))).toMatchObject({ ok: false, errors: [{ code: 'INTERNAL_ERROR' }] });
    } finally {
      cli.child.kill('SIGKILL');
      const pid = readPid(dir);
      if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});

describe.skipIf(process.platform === 'win32' || !canRunTs)('check in the CLI process', () => {
  it('Ctrl+C during a check prints INTERRUPTED, stops the game and records the run', async () => {
    const dir = makeTmpDir();
    const target = process.platform === 'darwin' ? 'mac' : 'linux';
    const exe = target === 'mac' ? 'out/mac/x.app/Contents/MacOS/x' : 'out/linux/x';
    // A stand-in for the packaged game: it says it's running (its pid, in its save folder), then never ends.
    const game = `#!${process.execPath}
const fs = require('fs');
const dir = process.env.GAMESHIPPER_USER_DATA;
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(require('path').join(dir, 'pid.txt'), String(process.pid));
setInterval(() => {}, 1000);
`;
    writeFiles(dir, { 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0', targets: [target] }), 'index.html': '', [exe]: game });
    fs.chmodSync(path.join(dir, exe), 0o755);
    const saves = path.join(dir, '.gameshipper', 'check', 'data');
    const cli = startCli(['check', '--json', '--dir', dir]);
    try {
      expect(await waitFor(() => readPid(saves) !== null, 20_000)).toBe(true);
      cli.child.kill('SIGINT');
      expect(await cli.closed).toEqual({ code: 130, signal: null });
      const result = JSON.parse(cli.stdout());
      expect(result).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }] });
      expect(result.logPath).toMatch(/check-.+\.log$/);
      expect(await waitFor(() => !alive(readPid(saves)!))).toBe(true);
      expect(JSON.parse(readText(dir, '.gameshipper/last/check.json'))).toMatchObject({ ok: false, errors: [{ code: 'INTERRUPTED' }] });
    } finally {
      cli.child.kill('SIGKILL');
      const pid = readPid(saves);
      if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
