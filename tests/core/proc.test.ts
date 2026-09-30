import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { childrenStopped, releaseAfterExit, stopWithGameshipper, waitForSystemCaLoad } from '../../src/core/proc.js';
import { makeTmpDir } from '../helpers/tmp.js';

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

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if (check()) return true;
  }
  return check();
}

describe.skipIf(process.platform === 'win32')('stopWithGameshipper with quitGraceMs (interactive play)', () => {
  /**
   * A game that starts a helper in its process group, then on SIGTERM takes `quitMs` to save and exit
   * (or ignores SIGTERM when `quitMs` is null). Prints "ready" once its SIGTERM handler is in place.
   */
  function game(quitMs: number | null) {
    const dir = makeTmpDir();
    const code = `
      const fs = require('fs');
      const helper = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync('helper.pid', String(helper.pid));
      process.on('SIGTERM', () => {
        ${quitMs === null ? '' : `setTimeout(() => { fs.writeFileSync('saved.txt', 'yes'); process.exit(0); }, ${quitMs});`}
      });
      setInterval(() => {}, 1000);
      console.log('ready');
    `;
    const child = spawn(process.execPath, ['-e', code], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const ready = new Promise<void>((resolve) => child.stdout.on('data', () => resolve()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.on('exit', (code, signal) => resolve({ code, signal })),
    );
    const helperPid = () => Number(fs.readFileSync(path.join(dir, 'helper.pid'), 'utf8'));
    return { dir, child, ready, exited, helperPid };
  }

  it('asks the game to quit and lets it finish saving, then stops what it left behind', async () => {
    const g = game(300);
    const cli = vi.fn();
    process.on('SIGINT', cli);
    const detach = stopWithGameshipper(g.child, { quitGraceMs: 3000 });
    try {
      await g.ready;
      const started = Date.now();
      process.emit('SIGINT', 'SIGINT');
      await childrenStopped();
      expect(await g.exited).toEqual({ code: 0, signal: null });
      expect(fs.readFileSync(path.join(g.dir, 'saved.txt'), 'utf8')).toBe('yes');
      expect(Date.now() - started).toBeLessThan(2500);
      expect(await waitFor(() => !alive(g.helperPid()))).toBe(true);
    } finally {
      process.off('SIGINT', cli);
      detach();
      g.child.kill('SIGKILL');
    }
  });

  it('stops the whole tree once the grace period is over', async () => {
    const g = game(null);
    const cli = vi.fn();
    process.on('SIGINT', cli);
    const detach = stopWithGameshipper(g.child, { quitGraceMs: 300 });
    try {
      await g.ready;
      const started = Date.now();
      process.emit('SIGINT', 'SIGINT');
      await childrenStopped();
      expect(await g.exited).toEqual({ code: null, signal: 'SIGKILL' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      expect(await waitFor(() => !alive(g.helperPid()))).toBe(true);
    } finally {
      process.off('SIGINT', cli);
      detach();
      g.child.kill('SIGKILL');
    }
  });

  it('removes its handlers once the game has stopped', async () => {
    const g = game(0);
    const cli = vi.fn();
    process.on('SIGINT', cli);
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const;
    const counts = () => events.map((e) => process.listenerCount(e));
    const before = counts();
    stopWithGameshipper(g.child, { quitGraceMs: 3000 });
    try {
      await g.ready;
      process.emit('SIGINT', 'SIGINT');
      // Until the game is gone, Gameshipper exiting must still take it down.
      expect(process.listenerCount('exit')).toBe(before[3] + 1);
      await childrenStopped();
      expect(counts()).toEqual(before);
    } finally {
      process.off('SIGINT', cli);
      g.child.kill('SIGKILL');
    }
  });
});

describe('waitForSystemCaLoad', () => {
  it("reads the system certificate store (waiting for Node's own read of it) only when Node reads it at start-up", () => {
    const getCACertificates = vi.fn(() => []);
    const spy = vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) => (id === 'node:tls' ? { getCACertificates } : undefined)) as typeof process.getBuiltinModule);
    const env = { NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA, NODE_OPTIONS: process.env.NODE_OPTIONS };
    try {
      for (const [ca, options, reads] of [
        ['1', '', true],
        ['', '--use-system-ca', true],
        ['', '--max-old-space-size=4096', false],
        ['0', '', false],
      ] as const) {
        getCACertificates.mockClear();
        process.env.NODE_USE_SYSTEM_CA = ca;
        process.env.NODE_OPTIONS = options;
        waitForSystemCaLoad();
        expect(getCACertificates.mock.calls, `${ca} ${options}`).toEqual(reads ? [['system']] : []);
      }
    } finally {
      spy.mockRestore();
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
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
