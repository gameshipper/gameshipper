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

/** Boots the simulator if needed and waits until it's ready. Returns true when this call booted it. */
export function bootSimulator(device: SimDevice): boolean {
  const boot = device.state !== 'Booted';
  if (boot) execFileSync('xcrun', ['simctl', 'boot', device.udid]);
  execFileSync('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], { stdio: 'ignore' });
  return boot;
}

export function shutdownSimulator(device: SimDevice): void {
  spawnSync('xcrun', ['simctl', 'shutdown', device.udid], { stdio: 'ignore' });
}

/**
 * Builds out/ios for the Simulator without code signing and returns the .app path.
 * `-packageAuthorizationProvider netrc` stops SwiftPM from looking up github.com credentials in the keychain,
 * which waits forever when nobody can answer a keychain prompt (as in an agent's session).
 */
export function buildForSimulator(iosDir: string, derivedData: string): string {
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
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`xcodebuild failed:\n${`${r.stdout}\n${r.stderr}`.split('\n').slice(-40).join('\n')}`);
  return path.join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
}

/**
 * How long a launched app gets to print every marker. A simulator that has just booted is slow: on GitHub's macOS
 * runner the app took 43 seconds to start, and its page hadn't loaded 17 seconds later. On a warm simulator the
 * markers are there within seconds, and the wait ends with them.
 */
const MARKERS_TIMEOUT_MS = 3 * 60_000;

/**
 * Installs and launches the app, collecting its console (Capacitor prints `⚡️  [log] - …` lines in Debug
 * builds) until every marker has appeared or the timeout passes. `onReady` runs while the app is still open
 * (to take a screenshot, say); the app is closed afterwards.
 */
export async function runOnSimulator(
  device: SimDevice,
  appPath: string,
  bundleId: string,
  markers: string[],
  onReady: () => void,
  timeoutMs = MARKERS_TIMEOUT_MS,
): Promise<string> {
  execFileSync('xcrun', ['simctl', 'install', device.udid, appPath]);
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
        spawnSync('xcrun', ['simctl', 'terminate', device.udid, bundleId]);
        resolve(out);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
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
  execFileSync('xcrun', ['simctl', 'io', device.udid, 'screenshot', file], { stdio: 'ignore' });
}
