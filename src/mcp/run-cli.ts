import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree } from '../core/proc.js';
import { fail, gsError, type Result } from '../core/result.js';

/** bin/gameshipper.js: two folders above dist/mcp/ (and src/mcp/ in tests). */
export const CLI_BIN = fileURLToPath(new URL('../../bin/gameshipper.js', import.meta.url));

export interface RunOptions {
  /** The folder the CLI runs in; relative paths in its arguments (--steam-sdk) are relative to it. */
  cwd?: string;
  /** Called with each non-empty line the CLI writes to stderr (its --verbose log). */
  onLine?: (line: string) => void;
  /** Aborting stops the command, which then reports INTERRUPTED. */
  signal?: AbortSignal;
  /** Script to run instead of the real CLI (tests). */
  bin?: string;
}

export type RunCli = (args: string[], opts?: RunOptions) => Promise<Result<unknown>>;

/**
 * How long a stopped command gets to report INTERRUPTED and stop what it started (a game asked to quit gets
 * QUIT_GRACE_MS) before it's killed.
 */
const STOP_GRACE_MS = 10_000;
const TAIL_CHARS = 1500;

const tail = (text: string): string => {
  const t = text.trim();
  return t.length > TAIL_CHARS ? `…${t.slice(-TAIL_CHARS)}` : t;
};

function isResult(value: unknown): value is Result<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ok === 'boolean' && Array.isArray(v.errors) && Array.isArray(v.warnings);
}

/** Commands still running, and how to wait for each to end. */
const running = new Map<ChildProcess, Promise<void>>();

/**
 * Asks a command to stop the way a person's Ctrl+C would: the CLI stops its build or game, records the run and
 * prints INTERRUPTED. It's killed if it hasn't ended STOP_GRACE_MS later. On Windows, where a process can't be
 * asked, its whole process tree is ended at once.
 */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    killTree(child);
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

/** Stops every command still running and resolves once they've all ended (used when the server stops). */
export async function stopAllRuns(): Promise<void> {
  for (const child of running.keys()) stop(child);
  await Promise.all(running.values());
}

/** Runs `gameshipper <args>` in a child process and returns the Result it prints. Never throws. */
export const runCli: RunCli = (args, opts = {}) => {
  if (opts.signal?.aborted) {
    return Promise.resolve(fail(gsError('INTERRUPTED', 'The call was cancelled before it started.', 'Call the tool again when you are ready.')));
  }
  return new Promise((resolve) => {
    const command = args[0] ?? '';
    // No stdin: the CLI sees no terminal, so it never prompts.
    const child = spawn(process.execPath, [opts.bin ?? CLI_BIN, ...args], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let closed!: () => void;
    running.set(child, new Promise<void>((r) => (closed = r)));
    let stdout = '';
    let stderr = '';
    let partial = '';
    let settled = false;
    const onAbort = (): void => stop(child);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: Result<unknown>): void => {
      // A command that failed to start also emits 'close'.
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      running.delete(child);
      closed();
      resolve(result);
    };
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr = (stderr + d).slice(-TAIL_CHARS * 2);
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) opts.onLine?.(line);
    });
    child.on('error', (e) => {
      // Also emitted when a kill fails; only a command that never started ends the call here.
      if (child.pid !== undefined) return;
      finish(
        fail(
          gsError('MCP_CLI_FAILED', `Couldn't start the Gameshipper CLI: ${e.message}`, 'Check the game folder exists, reinstall Gameshipper, then restart the MCP server.'),
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (partial.trim()) opts.onLine?.(partial);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }
      if (isResult(parsed)) {
        finish(parsed);
        return;
      }
      const ended = signal ? `stopped by ${signal}` : `exit code ${code}`;
      finish(
        fail(
          gsError(
            'MCP_CLI_OUTPUT_INVALID',
            `\`gameshipper ${command}\` ended (${ended}) without printing a JSON result. stdout: ${tail(stdout) || '(empty)'} stderr: ${tail(stderr) || '(empty)'}`,
            `Run \`npx gameshipper ${args.join(' ')}\` in a terminal to see what happened, and report it as a Gameshipper bug.`,
          ),
        ),
      );
    });
  });
};
