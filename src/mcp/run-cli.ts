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
  /** How long a stopped command gets before it's killed with everything it started (default STOP_GRACE_MS; tests). */
  stopGraceMs?: number;
}

export type RunCli = (args: string[], opts?: RunOptions) => Promise<Result<unknown>>;

/**
 * How long a stopped command gets to report INTERRUPTED and stop what it started (a game asked to quit gets
 * QUIT_GRACE_MS) before it's killed.
 */
const STOP_GRACE_MS = 10_000;
const TAIL_CHARS = 1500;
/**
 * The most of the CLI's stdout kept, from its end: the Result comes last, and a plugin that prints to stdout can
 * print anything before it.
 */
const MAX_STDOUT_CHARS = 5 * 1024 * 1024;

const tail = (text: string): string => {
  const t = text.trim();
  return t.length > TAIL_CHARS ? `…${t.slice(-TAIL_CHARS)}` : t;
};

const head = (text: string): string => {
  const t = text.trim();
  return t.length > TAIL_CHARS ? `${t.slice(0, TAIL_CHARS)}…` : t;
};

function isResult(value: unknown): value is Result<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ok === 'boolean' && Array.isArray(v.errors) && Array.isArray(v.warnings);
}

function parsed(text: string): Result<unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isResult(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Result in the CLI's stdout: all of it, or else the last top-level JSON object in it. The CLI prints its Result
 * last, but a plugin (or a library it uses) can write to stdout before that.
 */
export function resultIn(stdout: string): Result<unknown> | undefined {
  const whole = parsed(stdout);
  if (whole) return whole;
  const end = stdout.lastIndexOf('}') + 1;
  // Only the Result's own opening brace starts text that parses up to its closing one.
  for (let start = stdout.indexOf('{'); start !== -1 && start < end; start = stdout.indexOf('{', start + 1)) {
    const result = parsed(stdout.slice(start, end));
    if (result) return result;
  }
  return undefined;
}

/** Commands still running, and how to wait for each to end. */
const running = new Map<ChildProcess, Promise<void>>();

/**
 * Asks a command to stop the way a person's Ctrl+C would: the CLI stops its build or game, records the run and
 * prints INTERRUPTED. If it hasn't ended `graceMs` later (stuck in a blocking call, such as Electron's first
 * download), its whole process group is killed, so nothing it started is left running. On Windows, where a
 * process can't be asked, its whole process tree is ended at once.
 */
function stop(child: ChildProcess, graceMs = STOP_GRACE_MS): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    killTree(child);
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => killTree(child), graceMs);
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
    // No stdin: the CLI sees no terminal, so it never prompts. On POSIX it leads its own process group, so
    // stopping it can also stop what it started (stop above).
    const child = spawn(process.execPath, [opts.bin ?? CLI_BIN, ...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let closed!: () => void;
    running.set(child, new Promise<void>((r) => (closed = r)));
    let stdout = '';
    let stdoutHead = '';
    let stderr = '';
    let partial = '';
    let settled = false;
    const onAbort = (): void => stop(child, opts.stopGraceMs);
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
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdoutHead.length < TAIL_CHARS) stdoutHead += d.slice(0, TAIL_CHARS - stdoutHead.length);
      stdout += d;
      // Cut back only now and then: slicing on every chunk would copy the whole buffer each time.
      if (stdout.length > 2 * MAX_STDOUT_CHARS) stdout = stdout.slice(-MAX_STDOUT_CHARS);
    });
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
      const result = resultIn(stdout.length > MAX_STDOUT_CHARS ? stdout.slice(-MAX_STDOUT_CHARS) : stdout);
      if (result) {
        finish(result);
        return;
      }
      const ended = signal ? `stopped by ${signal}` : `exit code ${code}`;
      if (opts.signal?.aborted) {
        finish(
          fail(
            gsError(
              'INTERRUPTED',
              `The call was cancelled, and \`gameshipper ${command}\` didn't stop in time, so it was killed with everything it started (${ended}).`,
              'Call the tool again when you are ready.',
            ),
          ),
        );
        return;
      }
      const what = stdoutHead.trim()
        ? `printed something besides its result (${ended}), so the result couldn't be read. Its output began: ${head(stdoutHead)}`
        : `ended without printing a result (${ended}).`;
      finish(
        fail(
          gsError(
            'MCP_CLI_OUTPUT_INVALID',
            `\`gameshipper ${command}\` ${what} stderr: ${tail(stderr) || '(empty)'}`,
            `Run \`npx gameshipper ${args.join(' ')}\` in a terminal to see what it prints. A plugin must log with console.error, not console.log, which writes to stdout; otherwise report it as a Gameshipper bug.`,
          ),
        ),
      );
    });
  });
};
