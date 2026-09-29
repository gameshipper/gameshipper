import { spawnSync, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

/** Signals that stop Gameshipper; child processes it started are stopped with it. */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_MAX_CHARS = 4096;
/** Enough of a child's output to hold its last lines without buffering a whole log. */
export const OUTPUT_BUFFER_CHARS = 64 * 1024;

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

/**
 * While `child` runs, stop its whole tree if Gameshipper is stopped or exits. A detached child doesn't
 * get the terminal's Ctrl+C itself. After stopping the child, Gameshipper dies of the same signal,
 * unless something else listens for it (the CLI does, to report the interrupted run and pick the exit
 * code). Returns the function that removes these handlers; call it once the child is done.
 */
export function stopWithGameshipper(child: ChildProcess): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    detach();
    killTree(child);
    if (process.listenerCount(signal) > 0) return;
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(128 + (os.constants.signals[signal] ?? 0));
    }
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
