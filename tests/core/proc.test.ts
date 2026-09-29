import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { releaseAfterExit, stopWithGameshipper } from '../../src/core/proc.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('stopWithGameshipper', () => {
  it('stops the child on a signal but leaves exiting to another listener of that signal', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    const cli = vi.fn();
    process.on('SIGINT', cli);
    const before = process.listenerCount('SIGINT');
    const detach = stopWithGameshipper(child);
    try {
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      // Delivers the event to the listeners without a real signal.
      process.emit('SIGINT', 'SIGINT');
      expect(await exited).toBe('SIGKILL');
      expect(alive(child.pid!)).toBe(false);
      expect(process.listenerCount('SIGINT')).toBe(before);
      // Re-raising would deliver a real SIGINT to this process, reaching `cli` a second time.
      await new Promise((r) => setTimeout(r, 300));
      expect(cli).toHaveBeenCalledTimes(1);
    } finally {
      process.off('SIGINT', cli);
      detach();
      child.kill('SIGKILL');
    }
  });
});

describe('releaseAfterExit', () => {
  const sleeper = () =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });

  it("on Windows only lets go of the output: the exited game's PID may already belong to another process", async () => {
    const child = sleeper();
    try {
      releaseAfterExit(child, 'win32');
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      // Nothing was killed: taskkill /T on a reused PID would stop an unrelated program.
      await new Promise((r) => setTimeout(r, 300));
      expect(child.exitCode).toBeNull();
      expect(alive(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it.skipIf(process.platform === 'win32')('elsewhere also stops the rest of the process group', async () => {
    const child = sleeper();
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    try {
      releaseAfterExit(child, 'linux');
      expect(child.stdout.destroyed).toBe(true);
      expect(await exited).toBe('SIGKILL');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
