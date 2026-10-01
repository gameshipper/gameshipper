import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
}

export function hasXcode(): boolean {
  return process.platform === 'darwin' && spawnSync('xcodebuild', ['-version']).status === 0;
}

/** An iPhone simulator on the newest installed iOS runtime: one that is already running if there is one. */
export function pickIphone(): SimDevice {
  const list = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { encoding: 'utf8' })) as {
    devices: Record<string, SimDevice[]>;
  };
  const newest = Object.keys(list.devices)
    .filter((r) => r.includes('SimRuntime.iOS'))
    .sort()
    .reverse()[0];
  const iphones = (newest ? list.devices[newest] : []).filter((d) => d.name.startsWith('iPhone'));
  const device = iphones.find((d) => d.state === 'Booted') ?? iphones[0];
  if (!device) throw new Error('No iPhone simulator is installed. Install one in Xcode → Settings → Components.');
  return device;
}

/**
 * Boots the simulator if needed and waits until it's ready, `timeoutMs` at most in all (then it throws). Returns true
 * when this call booted it.
 */
export function bootSimulator(device: SimDevice, timeoutMs: number): boolean {
  const began = Date.now();
  const boot = device.state !== 'Booted';
  if (boot) execFileSync('xcrun', ['simctl', 'boot', device.udid], { timeout: timeoutMs });
  execFileSync('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], { stdio: 'ignore', timeout: Math.max(1000, timeoutMs - (Date.now() - began)) });
  return boot;
}

export function shutdownSimulator(device: SimDevice): void {
  spawnSync('xcrun', ['simctl', 'shutdown', device.udid], { stdio: 'ignore' });
}

/**
 * Builds out/ios for the Simulator without code signing and returns the .app path.
 * `-packageAuthorizationProvider netrc` stops SwiftPM from looking up github.com credentials in the keychain,
 * which waits forever when nobody can answer a keychain prompt (as in an agent's session). An xcodebuild still
 * running after `timeoutMs` is stopped, and this throws.
 */
export function buildForSimulator(iosDir: string, derivedData: string, timeoutMs: number): string {
  const r = spawnSync(
    'xcodebuild',
    [
      '-project', path.join(iosDir, 'App', 'App.xcodeproj'),
      '-scheme', 'App',
      '-configuration', 'Debug',
      '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', derivedData,
      '-packageAuthorizationProvider', 'netrc',
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' },
  );
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`xcodebuild was still running after ${Math.round(timeoutMs / 60_000)} minutes.`);
  if (r.status !== 0) throw new Error(`xcodebuild failed:\n${`${r.stdout}\n${r.stderr}`.split('\n').slice(-40).join('\n')}`);
  return path.join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
}

/**
 * How long a launched app gets to print every marker. A simulator that has just booted is slow: on GitHub's macOS
 * runner the app took 43 seconds to start, and its page hadn't loaded 17 seconds later. On a warm simulator the
 * markers are there within seconds, and the wait ends with them.
 */
export const MARKERS_TIMEOUT_MS = 3 * 60_000;
/** How long taking the screenshot, and closing the app, may each take once a start is over. */
const END_STEP_TIMEOUT_MS = 15_000;
/** How long a start may take to end after its wait: the screenshot and closing the app (runOnSimulator). */
export const START_END_MS = 2 * END_STEP_TIMEOUT_MS;

/**
 * Installs and launches the app, collecting its console (Capacitor prints `⚡️  [log] - …` lines in Debug
 * builds) until every marker has appeared or the timeout passes; installing counts towards the timeout. `onReady`
 * runs while the app is still open (to take a screenshot, say); the app is closed afterwards. Both of those are
 * given START_END_MS at most.
 */
export async function runOnSimulator(
  device: SimDevice,
  appPath: string,
  bundleId: string,
  markers: string[],
  onReady: () => void,
  timeoutMs = MARKERS_TIMEOUT_MS,
): Promise<string> {
  const began = Date.now();
  execFileSync('xcrun', ['simctl', 'install', device.udid, appPath], { timeout: timeoutMs });
  const left = Math.max(1000, timeoutMs - (Date.now() - began));
  return new Promise((resolve) => {
    const child = spawn('xcrun', ['simctl', 'launch', '--console-pty', '--terminate-running-process', device.udid, bundleId]);
    let out = '';
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        onReady();
      } finally {
        child.kill();
        spawnSync('xcrun', ['simctl', 'terminate', device.udid, bundleId], { timeout: END_STEP_TIMEOUT_MS });
        resolve(out);
      }
    };
    const timer = setTimeout(finish, left);
    const onData = (d: Buffer): void => {
      out += d.toString();
      // A moment longer, so the game draws a few frames before the screenshot.
      if (markers.every((m) => out.includes(m))) setTimeout(finish, 2_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

export function screenshot(device: SimDevice, file: string): void {
  execFileSync('xcrun', ['simctl', 'io', device.udid, 'screenshot', file], { stdio: 'ignore', timeout: END_STEP_TIMEOUT_MS });
}

/** What the game logs once it has drawn for 1.5 seconds: how many frames. */
const FRAMES = /gameshipper-frames:(\d+)/;

export interface WarmStart {
  /** The console output of the last start: the one to check. */
  out: string;
  /** The frames the last start reported, or null when it never reported them. */
  frames: number | null;
  /** How each start went, in order, for the test's messages. */
  starts: string[];
}

export interface WarmStartOptions {
  /** What a start that reported everything has printed: every one of these. */
  markers: string[];
  /** A start that drew more frames than this drew them at speed. */
  minFrames: number;
  /** How many times the game is started at most. */
  maxStarts: number;
  /** How long one start may take in all: `start` gets this, and must be over by then. */
  startLimitMs: number;
  /** When every start must be over (as Date.now() counts): no start begins that could still be running then. */
  deadline: number;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * Starts the game until a start draws its frames at speed, `maxStarts` times at most, and returns the last start.
 * A simulator that has just booted is busy for a while: on GitHub's macOS runner the game's first start there took
 * over a minute and drew one frame in its first 1.5 s.
 *
 * Only a start that reported everything (every marker is in its output) and drew too few frames is followed by
 * another. A start that never reported, or that lacks a marker, is returned at once: starting again could hide a
 * game that fails the first time it is launched. `start` gets how long it may take; a start that couldn't be over
 * by `deadline` never begins, so the starts can't take the test past its own time limit.
 */
export async function startUntilWarm(start: (timeoutMs: number) => Promise<string>, o: WarmStartOptions): Promise<WarmStart> {
  const now = o.now ?? Date.now;
  const starts: string[] = [];
  let out = '';
  let frames: number | null = null;
  for (;;) {
    if (o.deadline - now() < o.startLimitMs) {
      starts.push('no time left for another start');
      break;
    }
    const began = now();
    out = await start(o.startLimitMs);
    const seconds = Math.round((now() - began) / 1000);
    const reported = FRAMES.exec(out);
    frames = reported ? Number(reported[1]) : null;
    const missing = o.markers.filter((marker) => !out.includes(marker));
    if (missing.length) {
      starts.push(`gave up after ${seconds} s without ${missing.join(', ')}`);
      break;
    }
    starts.push(`${frames ?? 'no'} frames, reported after ${seconds} s`);
    if (frames === null || frames > o.minFrames || starts.length >= o.maxStarts) break;
  }
  return { out, frames, starts };
}
