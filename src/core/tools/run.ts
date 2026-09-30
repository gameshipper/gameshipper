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

/** Secrets Gameshipper holds for one destination or for signing; no tool gets another's. */
const SECRETS = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'BUTLER_API_KEY']);
const SECRET_PREFIXES = ['GAMESHIPPER_NOTARY_', 'GAMESHIPPER_MAC_'];

/**
 * `env` without the secrets Gameshipper holds for others: the GitHub token, butler's API key and the Apple signing
 * variables. `keep` names those the tool itself needs. Names are compared ignoring case, as Windows does.
 */
export function withoutSecrets(env: NodeJS.ProcessEnv, keep: string[] = []): NodeJS.ProcessEnv {
  const kept = new Set(keep.map((name) => name.toUpperCase()));
  const secret = (name: string) => SECRETS.has(name) || SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));
  return Object.fromEntries(Object.entries(env).filter(([name]) => kept.has(name.toUpperCase()) || !secret(name.toUpperCase())));
}

/** An executable, or a .js/.mjs/.cjs script that this Node runs (how tests plug in their fakes). */
export function toolCommand(file: string, env: NodeJS.ProcessEnv): ToolCommand {
  return /\.[cm]?js$/i.test(file) ? { command: process.execPath, args: [file], env } : { command: file, args: [], env };
}

export interface ExternalRunOptions {
  timeoutMs: number;
  /**
   * Every line the tool prints, stdout and stderr, e.g. for the run log (which --verbose and MCP progress show). A line
   * longer than OUTPUT_BUFFER_CHARS is cut there.
   */
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
 * How much of a line's earlier output `stopOn` sees again with each new write, so a prompt split across writes is
 * still found: far longer than any prompt it looks for. Only new output is searched otherwise, so a tool that prints
 * a huge line without a line break costs linear time.
 */
const STOP_ON_OVERLAP = 1024;

/**
 * Splits a tool's output into lines as it arrives. A line is kept up to OUTPUT_BUFFER_CHARS; the rest is only
 * counted, and the line says how much was left out.
 */
class LineSplitter {
  private head = '';
  private dropped = 0;
  /** The end of the line so far, for `stopOn`. */
  tail = '';

  /** Adds output that has no line break in it. */
  add(text: string): void {
    const room = OUTPUT_BUFFER_CHARS - this.head.length;
    if (text.length <= room) this.head += text;
    else {
      this.head += text.slice(0, room);
      this.dropped += text.length - room;
    }
    this.tail = (this.tail + text).slice(-STOP_ON_OVERLAP);
  }

  get empty(): boolean {
    return !this.head;
  }

  /** The line, then starts the next one. */
  take(): string {
    const line = this.dropped ? `${this.head}… (${this.dropped} more characters)` : this.head;
    this.head = '';
    this.dropped = 0;
    this.tail = '';
    return line;
  }
}

/**
 * Runs a tool with no stdin (so it can never wait for input) and captures its output. On macOS and Linux it leads its
 * own process group, so stopping it also stops what it started: steamcmd.sh runs the real steamcmd as its child. If
 * Gameshipper is stopped meanwhile (Ctrl+C, or the MCP server cancelling the call), the tool's whole tree is stopped
 * and the CLI reports INTERRUPTED. Never rejects.
 */
export function runExternal(tool: ToolCommand, args: string[], opts: ExternalRunOptions): Promise<ExternalRun> {
  return new Promise((resolve) => {
    let output = '';
    const line = new LineSplitter();
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
    /** Looks for `stopOn` in the new part of the line, and the end of what came before it on that line. */
    const check = (before: string, text: string): void => {
      if (!opts.stopOn || stoppedOn !== null) return;
      const seen = before + text;
      if (opts.stopOn.test(seen)) {
        stoppedOn = seen.trim().slice(-STOP_ON_OVERLAP);
        killTree(child);
      }
    };
    const onData = (text: string): void => {
      output = (output + text).slice(-OUTPUT_BUFFER_CHARS);
      // Progress lines redraw themselves with \r.
      const parts = text.split(/\r?\n|\r/);
      for (const [i, part] of parts.entries()) {
        // A prompt has no line break after it, so the last part is checked too.
        check(line.tail, part);
        line.add(part);
        if (i < parts.length - 1) {
          const done = line.take();
          opts.onLine?.(done);
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      detach();
      if (!line.empty) {
        const last = line.take();
        opts.onLine?.(last);
      }
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
