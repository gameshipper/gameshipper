import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSmoke } from '../../src/core/smoke.js';
import { cli, HOST_TARGET, readEvents, ROOT } from '../helpers/built-cli.js';
import { testCtx } from '../helpers/ctx.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const BRIDGE_OK = 'gameshipper-bridge:{"ok":true}';
const THREE_URL = 'https://unpkg.com/three@0.170.0/build/three.module.js';

function freshGame(): string {
  const dir = makeTmpDir('gs-e2e-');
  fs.cpSync(path.join(ROOT, 'fixtures', 'threejs-cdn'), dir, { recursive: true });
  writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
  return dir;
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

    // Deleted now to free the disk space; when a check fails, GAMESHIPPER_KEEP_TMP=1 keeps it for `status --json --dir <dir>`.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it.skipIf(process.platform === 'win32')(
    'cross-builds every desktop target and the mobile projects from this host',
    () => {
      const dir = freshGame();
      expect(cli(['init', '--yes', '--name', 'Spinning Cube', '--bundle-id', 'com.gameshipper.spinningcube'], dir).code).toBe(0);

      const build = cli(['build'], dir);
      expect(build.result.errors).toEqual([]);
      expect(build.code).toBe(0);
      const status = Object.fromEntries(build.result.data.targets.map((t: { target: string; status: string }) => [t.target, t.status]));
      expect(status).toEqual({ windows: 'built', mac: 'built', linux: 'built', ios: 'built', android: 'built' });
      expect(fs.existsSync(path.join(dir, 'out', 'ios', 'App', 'App.xcodeproj'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'out', 'android', 'gradlew'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'out', 'windows', 'Spinning Cube.exe'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'out', 'linux', 'spinning-cube'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'out', 'mac', 'Spinning Cube.app'))).toBe(true);

      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
    // Up to three first-time Electron downloads.
    30 * 60_000,
  );
});
