import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linuxLauncherScript } from '../../src/core/desktop/linux-launcher.js';
import { killTree, outputTail, releaseAfterExit } from '../../src/core/proc.js';
import { runSmoke, summaryToIssues } from '../../src/core/smoke.js';
import type { DiagSummary } from '../../src/shell/diagnostics.js';
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

/** How long a game started by hand may run before the test stops it. */
const BY_HAND_TIMEOUT_MS = 90_000;
/** After the game exits, how long to wait for its helper processes to let go of its output. */
const BY_HAND_CLOSE_GRACE_MS = 2000;

interface ByHand {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** The last lines the game printed. */
  output: string;
  eventsLog: string;
  /** What the game reported when it quit, or null when it never did. */
  summary: DiagSummary | null;
  dataDir: string;
  /**
   * Linux: every program the process the test started was while it ran, in order, each with its command line. A build
   * starts as the shell that runs its launcher and becomes the game.
   */
  procs: Array<{ exe: string; commandLine: string }>;
}

/**
 * Starts `command` the way a player's double-click or Steam's launch option does: the file itself with no
 * arguments, and not through Gameshipper's own launch code. Only the environment differs from a player's: it makes
 * this a smoke run, so the game reports what it did and quits after `seconds`.
 */
function startByHand(command: string, cwd: string, seconds = 3): Promise<ByHand> {
  const work = makeTmpDir('gs-by-hand-');
  const eventsLog = path.join(work, 'events.jsonl');
  const summaryFile = path.join(work, 'smoke.json');
  const dataDir = path.join(work, 'data');
  fs.writeFileSync(eventsLog, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GAMESHIPPER_LOG: eventsLog,
    GAMESHIPPER_USER_DATA: dataDir,
    GAMESHIPPER_WINDOWED: '1',
    GAMESHIPPER_SMOKE_SECONDS: String(seconds),
    GAMESHIPPER_SMOKE_OUT: summaryFile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let output = '';
    const onData = (text: string): void => {
      output = (output + text).slice(-64 * 1024);
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);

    // On Linux, /proc says which program the process the test started is at the moment, and with which command line.
    const procs: ByHand['procs'] = [];
    const watch =
      process.platform === 'linux'
        ? setInterval(() => {
            try {
              const exe = fs.readlinkSync(`/proc/${child.pid}/exe`);
              // Chromium may rewrite its command line as one string; either way its parts end up separated.
              const commandLine = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
              const last = procs.at(-1);
              if (commandLine && (last?.exe !== exe || last.commandLine !== commandLine)) procs.push({ exe, commandLine });
            } catch {
              // Not started yet, or already gone.
            }
          }, 20)
        : undefined;

    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(watch);
      let summary: DiagSummary | null = null;
      try {
        summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as DiagSummary;
      } catch {
        // The game never reported.
      }
      resolve({ ...exit, timedOut, output: outputTail(output), eventsLog, summary, dataDir, procs });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      settle();
    }, BY_HAND_TIMEOUT_MS);
    child.on('error', (e) => {
      if (child.pid !== undefined) return;
      clearTimeout(timer);
      clearInterval(watch);
      reject(e);
    });
    child.on('exit', (code, signal) => {
      // Its process ID may now go to another program.
      clearInterval(watch);
      if (settled) return;
      exit = { code, signal };
      // Electron's helper processes can hold the game's output open after it has exited.
      grace = setTimeout(() => {
        releaseAfterExit(child);
        settle();
      }, BY_HAND_CLOSE_GRACE_MS);
    });
    child.on('close', settle);
  });
}

/** The game ran and quit by itself: it reported no problems, drew frames, saved through the bridge and exited with code 0. */
function expectRanCleanly(run: ByHand, how: string): void {
  const ended = run.timedOut ? 'stopped by the test after its time limit' : run.signal ? `stopped by ${run.signal}` : `exit code ${run.code}`;
  expect(run.summary, `${how}: the game never reported (${ended}). Last lines of its output:\n${run.output}`).not.toBeNull();
  const { errors, warnings } = summaryToIssues(run.summary!);
  expect(errors, how).toEqual([]);
  expect(warnings, how).toEqual([]);
  expect([run.code, run.signal, run.timedOut], how).toEqual([0, null, false]);
  checkGameRan(run.eventsLog, how);
  expect(JSON.parse(fs.readFileSync(path.join(run.dataDir, 'saves', 'smoke.json'), 'utf8')), how).toEqual({ ok: true });
}

describe('end to end on this computer', () => {
  const linux = process.platform === 'linux';
  /** Set by the first test: the game and its build for this computer, which the next tests start by hand. */
  let built: { dir: string; executable: string } | undefined;

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

    built = { dir, executable: output.executable };
  });

  // The next three start a build by hand, not through Gameshipper: a double-click, a terminal, Steam's launch option.

  it('started with no arguments at all, from another folder, the build runs and quits cleanly', async () => {
    expect(built, 'the first test builds the game').toBeDefined();
    const run = await startByHand(built!.executable, makeTmpDir('gs-elsewhere-'));
    expectRanCleanly(run, 'started by hand with no arguments');
    if (!linux) return;
    // The launcher handed its own process to the game (exec): the process the test started became the Electron binary,
    // so stopping it stops the game, and the exit code above was the game's. The game got --no-sandbox, once.
    const binary = path.join(fs.realpathSync(path.join(built!.dir, 'out', 'linux')), 'spinning-cube-bin');
    const asGame = run.procs.filter((p) => p.exe === binary);
    expect(asGame.length, `the process never became ${binary}: ${JSON.stringify(run.procs)}`).toBeGreaterThan(0);
    expect(run.procs.at(-1)!.exe).toBe(binary);
    for (const p of asGame) expect(p.commandLine.match(/--no-sandbox/g), p.commandLine).toHaveLength(1);
  });

  it.runIf(linux)('the Linux build still runs from a folder with spaces in its name, started through a link from yet another folder', async () => {
    expect(built, 'the first test builds the game').toBeDefined();
    // As Steam installs it ("steamapps/common/Spinning Cube") and as a player links it from ~/bin or a desktop.
    const installed = path.join(makeTmpDir('gs steam library '), 'steamapps', 'common', 'Spinning Cube');
    fs.cpSync(path.join(built!.dir, 'out', 'linux'), installed, { recursive: true, verbatimSymlinks: true });
    const bin = path.join(makeTmpDir('gs home '), 'my bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(installed, 'spinning-cube'), path.join(bin, 'play cube'));
    const run = await startByHand(path.join(bin, 'play cube'), bin);
    expectRanCleanly(run, 'started through a link, from a folder with spaces');
    fs.rmSync(installed, { recursive: true, force: true, maxRetries: 3 });
  });

  // The control for the two above: what they would have seen before the build had a launcher, when its own name was
  // the Electron binary's. Where Chromium's sandbox can start, the binary runs by itself and this machine can't tell a
  // build with a launcher from one without: the test then says so instead of passing.
  it.runIf(linux)("without its launcher's --no-sandbox the binary stops before any of the game's code runs, where Chromium's sandbox can't start", async (ctx) => {
    expect(built, 'the first test builds the game').toBeDefined();
    const run = await startByHand(path.join(built!.dir, 'out', 'linux', 'spinning-cube-bin'), makeTmpDir('gs-elsewhere-'));
    if (run.summary) ctx.skip("Chromium's sandbox starts on this machine, so the binary runs without --no-sandbox too: a build without its launcher would pass here");
    const ended = run.timedOut ? 'the test stopped it after its time limit' : run.signal ? `stopped by ${run.signal}` : `exit code ${run.code}`;
    console.info(`The Electron binary started without --no-sandbox: ${ended}. Last lines of its output:\n${run.output}`);
    expect(run.timedOut, run.output).toBe(false);
    expect([run.code, run.signal]).not.toEqual([0, null]);
    // Chromium's own reason, and it came before the shell's first line ran: the shell logs Steam's state as it loads.
    expect(run.output).toMatch(/sandbox/i);
    expect(fs.readFileSync(run.eventsLog, 'utf8')).toBe('');
  });

  it.skipIf(process.platform === 'win32')(
    'cross-builds every desktop target and the mobile projects from this host',
    () => {
      // The first test's build has been started every way it is going to be: deleted now to free the disk space. When
      // a check fails, GAMESHIPPER_KEEP_TMP=1 keeps it for `status --json --dir <dir>`.
      if (built) fs.rmSync(built.dir, { recursive: true, force: true, maxRetries: 3 });
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
      expect(fs.existsSync(path.join(dir, 'out', 'mac', 'Spinning Cube.app'))).toBe(true);
      // The Linux build's own name is its launcher's; the Electron binary is next to it. Both are executable.
      const linuxOut = path.join(dir, 'out', 'linux');
      expect(fs.readFileSync(path.join(linuxOut, 'spinning-cube'), 'utf8')).toBe(linuxLauncherScript('spinning-cube'));
      expect(fs.readFileSync(path.join(linuxOut, 'spinning-cube-bin')).subarray(0, 4)).toEqual(Buffer.from('\x7fELF', 'latin1'));
      for (const file of ['spinning-cube', 'spinning-cube-bin']) expect(fs.statSync(path.join(linuxOut, file)).mode & 0o111, file).toBe(0o111);

      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
    // Up to three first-time Electron downloads.
    30 * 60_000,
  );
});
