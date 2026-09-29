import { spawn } from 'node:child_process';
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

function startCli(args: string[], failure: 'none' | 'rejection' | 'exception' = 'none') {
  const child = spawn(process.execPath, [RUNNER, failure, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
        errors: [{ code: 'INTERRUPTED', message: `Stopped by ${signal} before finishing.`, fix: 'Run the command again; nothing was published.' }],
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
