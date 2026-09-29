import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runSmoke } from '../../src/core/smoke.js';
import { testCtx } from '../helpers/ctx.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'gameshipper.js');
const HOST_TARGET = ({ darwin: 'mac', win32: 'windows', linux: 'linux' } as const)[process.platform as 'darwin' | 'win32' | 'linux'];
const BRIDGE_OK = 'gameshipper-bridge:{"ok":true}';
const THREE_URL = 'https://unpkg.com/three@0.170.0/build/three.module.js';
/** A fresh Electron download for each OS can take minutes; a single CLI call gets this long. */
const CLI_TIMEOUT_MS = 14 * 60_000;

/** Runs the built CLI the way an agent does: --json, one JSON Result on stdout. */
function cli(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gameshipper ${args.join(' ')} didn't finish in ${cwd}: ${r.error.message}\n${r.stderr}`);
  let result: any;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    throw new Error(`gameshipper ${args.join(' ')} printed non-JSON output in ${cwd}:\n${r.stdout}\n${r.stderr}`);
  }
  return { code: r.status, result };
}

function freshGame(): string {
  const dir = makeTmpDir('gs-e2e-');
  fs.cpSync(path.join(ROOT, 'fixtures', 'threejs-cdn'), dir, { recursive: true });
  writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
  return dir;
}

interface LoggedEvent {
  kind: string;
  level?: string;
  message?: string;
  url?: string;
}

/**
 * Every diagnostic event of a run, from its events log (JSON lines). A result's `summary.events` holds only
 * the first 100, so what the game logged is checked here.
 */
function readEvents(eventsLog: string): LoggedEvent[] {
  return fs
    .readFileSync(eventsLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LoggedEvent);
}

/**
 * What a smoke run's events log shows the fixture did: saved and loaded through the preload bridge, drew
 * frames with WebGL, and loaded nothing from the internet. Returns how many frames it drew in 1.5 s.
 */
function checkGameRan(eventsLog: string, run: string): number {
  const events = readEvents(eventsLog);
  const messages = events.filter((e) => e.kind === 'console').map((e) => e.message ?? '');
  expect(messages, `${run}: ${eventsLog}`).toContain(BRIDGE_OK);
  expect(events.filter((e) => e.kind === 'remote-request'), `${run}: ${eventsLog}`).toEqual([]);
  const logged = messages.map((m) => /^gameshipper-frames:(\d+)$/.exec(m)).find((m) => m !== null);
  expect(logged, `${run} never logged its frame count: ${eventsLog}`).toBeDefined();
  const frames = Number(logged![1]);
  // A WebGL context that failed to start draws nothing.
  expect(frames, `${run} frames drawn in 1.5 s`).toBeGreaterThan(10);
  console.info(`${run}: ${frames} frames drawn in the first 1.5 s`);
  return frames;
}

describe('end to end on this computer', () => {
  it('init → play --smoke → build → launch the packaged app like Steam would', async () => {
    const dir = freshGame();

    const init = cli(['init', '--yes', '--name', 'Spinning Cube'], dir);
    expect(init.result.errors).toEqual([]);
    expect(init.code).toBe(0);
    expect(init.result.data.config.icon).toBe('icon.png');

    const play = cli(['play', '--smoke', '--seconds', '3'], dir);
    expect(play.result.errors).toEqual([]);
    expect(play.code).toBe(0);
    // A clean run: no console errors or warnings, missing files, internet use or crashes.
    expect(play.result.warnings.filter((w: { code: string }) => w.code.startsWith('GAME_'))).toEqual([]);
    checkGameRan(play.result.data.smoke.eventsLog, 'dev shell (play --smoke)');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.gameshipper', 'play-data', 'saves', 'smoke.json'), 'utf8'))).toEqual({ ok: true });
    // three.js came from unpkg and is now pinned, so builds work offline and stay identical.
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'gameshipper.lock'), 'utf8'));
    expect(Object.keys(lock.files)).toContain(THREE_URL);

    const build = cli(['build', '--target', HOST_TARGET], dir);
    expect(build.result.errors).toEqual([]);
    expect(build.code).toBe(0);
    const output = build.result.data.targets.find((t: { target: string }) => t.target === HOST_TARGET).output;
    expect(fs.existsSync(output.executable)).toBe(true);

    // The CLI only plays the dev shell, so the packaged app is launched through the same smoke runner.
    const userDataDir = path.join(dir, '.gameshipper', 'int-data');
    const smoke = await runSmoke(testCtx(dir), { command: output.executable, args: [], seconds: 3, userDataDir, windowed: true });
    expect(smoke.errors).toEqual([]);
    expect(smoke.warnings).toEqual([]);
    expect(smoke.data!.exitCode).toBe(0);
    checkGameRan(smoke.data!.eventsLog, 'packaged app');
    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'saves', 'smoke.json'), 'utf8'))).toEqual({ ok: true });

    const status = cli(['status'], dir);
    expect(status.code).toBe(0);
    expect(status.result.data.outputs.find((o: { target: string }) => o.target === HOST_TARGET).exists).toBe(true);
    const lastRuns = status.result.data.lastRuns as Record<string, { ok: boolean }>;
    expect(Object.keys(lastRuns).sort()).toEqual(['build', 'init', 'play']);
    expect(Object.values(lastRuns).every((r) => r.ok)).toBe(true);

    // Kept when a check fails, for debugging with `status --json --dir <dir>`.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it.skipIf(process.platform === 'win32')(
    'cross-builds every desktop target from this host',
    () => {
      const dir = freshGame();
      expect(cli(['init', '--yes', '--name', 'Spinning Cube'], dir).code).toBe(0);

      const build = cli(['build'], dir);
      expect(build.result.errors).toEqual([]);
      expect(build.code).toBe(0);
      const status = Object.fromEntries(build.result.data.targets.map((t: { target: string; status: string }) => [t.target, t.status]));
      expect(status).toEqual({ windows: 'built', mac: 'built', linux: 'built' });
      expect(fs.existsSync(path.join(dir, 'out', 'windows', 'Spinning Cube.exe'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'out', 'linux', 'spinning-cube'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'out', 'mac', 'Spinning Cube.app'))).toBe(true);

      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
    // Up to three first-time Electron downloads.
    30 * 60_000,
  );
});
