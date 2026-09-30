import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Integration tests run the built CLI (`npm run build`), the way an agent does. */

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'gameshipper.js');
/** The desktop target this computer builds natively. */
export const HOST_TARGET = ({ darwin: 'mac', win32: 'windows', linux: 'linux' } as const)[process.platform as 'darwin' | 'win32' | 'linux'];
/** A fresh Electron download for each OS can take minutes; a single CLI call gets this long. */
const CLI_TIMEOUT_MS = 14 * 60_000;

/** Runs the built CLI with --json: one JSON Result on stdout. `env` adds to (or overrides) this process's environment. */
export function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): { code: number | null; result: any } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (r.error) throw new Error(`gameshipper ${args.join(' ')} didn't finish in ${cwd}: ${r.error.message}\n${r.stderr}`);
  let result: any;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    throw new Error(`gameshipper ${args.join(' ')} printed non-JSON output in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  }
  return { code: r.status, result };
}

/**
 * Like `cli`, but without blocking this process: a fake server the test runs (a fake GitHub API) must keep answering
 * while the CLI talks to it.
 */
export function cliAsync(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; result: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--json'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve({ code, result: JSON.parse(stdout) });
      } catch {
        reject(new Error(`gameshipper ${args.join(' ')} printed non-JSON output in ${cwd}:\n${stdout}\n${stderr}`));
      }
    });
  });
}

export interface LoggedEvent {
  kind: string;
  level?: string;
  message?: string;
  url?: string;
  action?: string;
}

/**
 * Every diagnostic event of a run, from its events log (JSON lines). A result's `summary.events` holds only
 * the first 100.
 */
export function readEvents(eventsLog: string): LoggedEvent[] {
  return fs
    .readFileSync(eventsLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LoggedEvent);
}
