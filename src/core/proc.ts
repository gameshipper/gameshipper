import { spawnSync, type ChildProcess } from 'node:child_process';

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
 * While `child` runs, stop its whole tree if Gameshipper is stopped (then die of the same signal) or
 * exits. A detached child doesn't get the terminal's Ctrl+C itself. Returns the function that removes
 * these handlers; call it once the child is done.
 */
export function stopWithGameshipper(child: ChildProcess): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    detach();
    killTree(child);
    process.kill(process.pid, signal);
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
