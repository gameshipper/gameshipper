import { execFile, spawnSync, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

/** Signals that stop Gameshipper; child processes it started are stopped with it. */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_MAX_CHARS = 4096;
/** Enough of a child's output to hold its last lines without buffering a whole log. */
export const OUTPUT_BUFFER_CHARS = 64 * 1024;

export type ToolRunner = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

/** Runs a short-lived tool (codesign, stapler) and returns its exit code and combined output; never throws. */
export const runTool: ToolRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });

/** The last lines of a command's output, short enough for an error message. */
export function outputTail(output: string): string {
  // Progress bars redraw one line with \r, so treat it as a line break too.
  const tail = output.trimEnd().split(/\r?\n|\r/).slice(-OUTPUT_TAIL_LINES).join('\n');
  return tail.length > OUTPUT_TAIL_MAX_CHARS ? `…${tail.slice(-OUTPUT_TAIL_MAX_CHARS)}` : tail;
}

/**
 * Stop a child process and everything it started (e.g. the node process behind `npm run dev`, or
 * Electron's helper processes). On POSIX the child must have been spawned `detached`, so it leads
 * its own process group.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Synchronous, because this also runs from signal and 'exit' handlers.
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (result.error) child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * For a child that has exited while something it started still holds its output open (a build command's
 * background process, Electron's helpers): let go of the output and, on POSIX, stop the rest of its process
 * group. On Windows the tree can only be found through the child's PID, which may already belong to an
 * unrelated program, so nothing is killed there.
 */
export function releaseAfterExit(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') killTree(child);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** How long an interactive game gets to quit on Ctrl+C (finishing its saves) before it's killed. */
export const QUIT_GRACE_MS = 3000;

/** Children asked to quit that haven't stopped yet. */
const quitting = new Set<Promise<void>>();

/**
 * Resolves once every child asked to quit (see StopOptions.quitGraceMs) has exited or been killed. The CLI
 * waits for this before it exits, since exiting kills whatever is still running.
 */
export function childrenStopped(): Promise<void> {
  return Promise.all(quitting).then(() => undefined);
}

export interface StopOptions {
  /**
   * On a signal, first ask the child to quit (SIGTERM to it alone: Electron then closes its windows and
   * finishes pending writes), and kill its tree only once it has exited or this many milliseconds have
   * passed. Without it, or on Windows, the tree is killed at once.
   */
  quitGraceMs?: number;
}

/**
 * While `child` runs, stop its whole tree if Gameshipper is stopped or exits. A detached child doesn't
 * get the terminal's Ctrl+C itself. After stopping the child, Gameshipper dies of the same signal,
 * unless something else listens for it (the CLI does, to report the interrupted run and pick the exit
 * code). Returns the function that removes these handlers; call it once the child is done.
 */
export function stopWithGameshipper(child: ChildProcess, opts: StopOptions = {}): () => void {
  const reraise = (signal: NodeJS.Signals): void => {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(128 + (os.constants.signals[signal] ?? 0));
    }
  };
  /** Sends SIGTERM, then kills the tree when the child exits (its helpers) or the grace period ends. */
  const askToQuit = (graceMs: number): Promise<void> => {
    const stopped = new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        child.off('exit', finish);
        process.off('exit', onExit);
        killTree(child);
        resolve();
      };
      const timer = setTimeout(finish, graceMs);
      child.on('exit', finish);
      child.kill('SIGTERM');
    });
    quitting.add(stopped);
    void stopped.then(() => quitting.delete(stopped));
    return stopped;
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    for (const s of STOP_SIGNALS) process.off(s, onSignal);
    const running = child.exitCode === null && child.signalCode === null;
    // Until a quitting child is gone, the exit handler stays: Gameshipper exiting still kills it.
    const quit = opts.quitGraceMs !== undefined && process.platform !== 'win32' && running ? askToQuit(opts.quitGraceMs) : null;
    if (!quit) {
      process.off('exit', onExit);
      killTree(child);
    }
    if (process.listenerCount(signal) > 0) return;
    if (quit) void quit.then(() => reraise(signal));
    else reraise(signal);
  };
  const onExit = (): void => killTree(child);
  const detach = (): void => {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
    process.off('exit', onExit);
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  process.on('exit', onExit);
  return detach;
}
