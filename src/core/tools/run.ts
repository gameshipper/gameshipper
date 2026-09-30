import { spawn } from 'node:child_process';
import { killTree, OUTPUT_BUFFER_CHARS, releaseAfterExit, stopWithGameshipper } from '../proc.js';

/** How to start an external tool: SteamCMD, butler, or a test's stand-in for one. */
export interface ToolCommand {
  command: string;
  /** Arguments that always come first (the script, when `command` is Node). */
  args: string[];
  /** The tool's whole environment. */
  env: NodeJS.ProcessEnv;
}

/** An executable, or a .js/.mjs/.cjs script that this Node runs (how tests plug in their fakes). */
export function toolCommand(file: string, env: NodeJS.ProcessEnv): ToolCommand {
  return /\.[cm]?js$/i.test(file) ? { command: process.execPath, args: [file], env } : { command: file, args: [], env };
}

export interface ExternalRunOptions {
  timeoutMs: number;
  /** Every line the tool prints, stdout and stderr, e.g. for the run log (which --verbose and MCP progress show). */
  onLine?: (line: string) => void;
  /** Stop the tool as soon as its output matches, even mid-line: a prompt nobody is there to answer. */
  stopOn?: RegExp;
}

export interface ExternalRun {
  /** null when the tool couldn't start, timed out, was stopped by `stopOn`, or was killed by a signal. */
  exitCode: number | null;
  /** The end of what it printed (stdout and stderr as they came), at most OUTPUT_BUFFER_CHARS. */
  output: string;
  timedOut: boolean;
  /** The output that matched `stopOn`, when the tool was stopped for it. */
  stoppedOn: string | null;
  /** Why the tool couldn't start (ENOENT, EACCES), when it didn't. */
  spawnError: string | null;
}

/** How long a tool that has exited may keep its output open (something it started still holds it) before it's released. */
const CLOSE_GRACE_MS = 2000;

/**
 * Runs a tool with no stdin (so it can never wait for input) and captures its output. On macOS and Linux it leads its
 * own process group, so stopping it also stops what it started: steamcmd.sh runs the real steamcmd as its child. If
 * Gameshipper is stopped meanwhile (Ctrl+C, or the MCP server cancelling the call), the tool's whole tree is stopped
 * and the CLI reports INTERRUPTED. Never rejects.
 */
export function runExternal(tool: ToolCommand, args: string[], opts: ExternalRunOptions): Promise<ExternalRun> {
  return new Promise((resolve) => {
    let output = '';
    let partial = '';
    let timedOut = false;
    let stoppedOn: string | null = null;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const child = spawn(tool.command, [...tool.args, ...args], {
      env: tool.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const detach = stopWithGameshipper(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    const check = (text: string): void => {
      if (opts.stopOn && stoppedOn === null && opts.stopOn.test(text)) {
        stoppedOn = text.trim();
        killTree(child);
      }
    };
    const onData = (text: string): void => {
      output = (output + text).slice(-OUTPUT_BUFFER_CHARS);
      // Progress lines redraw themselves with \r.
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        opts.onLine?.(line);
        check(line);
      }
      // A prompt has no newline after it.
      if (partial) check(partial);
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      detach();
      if (partial) opts.onLine?.(partial);
      const stopped = timedOut || stoppedOn !== null;
      resolve({ exitCode: stopped ? null : exitCode, output, timedOut, stoppedOn, spawnError });
    };
    // Also emitted when a kill fails; only a tool that never started ends the run here.
    child.on('error', (e) => {
      if (child.pid === undefined) finish(null, e.message);
    });
    child.on('exit', (code) => {
      if (settled) return;
      graceTimer = setTimeout(() => {
        releaseAfterExit(child);
        finish(code, null);
      }, CLOSE_GRACE_MS);
    });
    child.on('close', (code) => finish(code, null));
  });
}

/**
 * Gives the tool the terminal (stdin, stdout and stderr are the person's), so it can ask for a password or a Steam
 * Guard code itself; Gameshipper never sees what is typed. Only for a person at a terminal: the CLI decides. Resolves
 * with the exit code, 127 if the tool couldn't start.
 */
export function handOff(tool: ToolCommand, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    // Not detached: it must be in the terminal's foreground to read from it, so Ctrl+C reaches it as well.
    const child = spawn(tool.command, [...tool.args, ...args], { env: tool.env, stdio: 'inherit' });
    const detach = stopWithGameshipper(child);
    child.on('error', () => {
      if (child.pid !== undefined) return;
      detach();
      resolve(127);
    });
    child.on('close', (code) => {
      detach();
      resolve(code ?? 1);
    });
  });
}

export type HandOff = typeof handOff;
