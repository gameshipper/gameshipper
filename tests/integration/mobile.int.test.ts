import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { listFiles } from '../../src/core/fsutil.js';
import { SHIM_TAG } from '../../src/core/mobile/shim.js';
import { cli, ROOT } from '../helpers/built-cli.js';
import {
  bootSimulator,
  buildForSimulator,
  hasXcode,
  MARKERS_TIMEOUT_MS,
  pickIphone,
  runOnSimulator,
  screenshot,
  shutdownSimulator,
  START_END_MS,
  startUntilWarm,
} from '../helpers/ios-sim.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

const BUNDLE_ID = 'com.gameshipper.spinningcube';
const BRIDGE_OK = 'gameshipper-bridge:{"ok":true}';

/**
 * The Simulator test's time limit, and what its slow steps may take of it at most. They add up to less than the
 * limit: xcodebuild 7 minutes, booting the simulator 3, three starts of the game of 3.5 each (10.5), and a minute to
 * check the last start, shut the simulator down and delete the project. Each step is stopped at its own limit, and no
 * start begins that couldn't be over before the last minute.
 */
const IOS_TEST_LIMIT_MS = 22 * 60_000;
const XCODEBUILD_LIMIT_MS = 7 * 60_000;
const BOOT_LIMIT_MS = 3 * 60_000;
const MAX_STARTS = 3;
/** One start: the wait for the game to report, then the screenshot and closing the app. */
const START_LIMIT_MS = MARKERS_TIMEOUT_MS + START_END_MS;
const WRAP_UP_MS = 60_000;

/** The three.js fixture plus a probe script that reports what the mobile page sees. */
function mobileGame(): string {
  const dir = makeTmpDir('gs-mobile-');
  fs.cpSync(path.join(ROOT, 'fixtures', 'threejs-cdn'), dir, { recursive: true });
  writeFiles(dir, {
    'icon.png': makeSolidPng(1024, 1024, [30, 144, 255, 255]),
    'probe.js': "addEventListener('load', () => console.log(`mobile-probe:steam=${typeof window.steam}:size=${innerWidth}x${innerHeight}`));",
  });
  const html = path.join(dir, 'index.html');
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<body>', '<body>\n  <script src="./probe.js"></script>'));
  const init = cli(['init', '--yes', '--name', 'Spinning Cube', '--bundle-id', BUNDLE_ID], dir);
  expect(init.result.data.config.targets).toEqual(['windows', 'mac', 'linux', 'ios', 'android']);
  return dir;
}

/**
 * Puts failing stand-ins for Apple's and Android's build tools first on PATH and records every call, to prove
 * generating the projects needs none of them (so it works on Windows and Linux too).
 */
function trapBuildTools(dir: string): { env: NodeJS.ProcessEnv; calls: string } {
  const bin = path.join(dir, '.trap-bin');
  const calls = path.join(dir, '.trap-calls.log');
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ['xcodebuild', 'xcrun', 'xcode-select', 'pod', 'swift', 'java', 'gradle']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 1\n`, { mode: 0o755 });
  }
  return { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, calls };
}

describe('iOS and Android projects', () => {
  it.skipIf(process.platform === 'win32')('are generated without Xcode, CocoaPods, Java or Gradle', () => {
    const dir = mobileGame();
    const trap = trapBuildTools(dir);
    const build = cli(['build', '--target', 'ios,android'], dir, trap.env);
    expect(build.result.errors).toEqual([]);
    expect(fs.existsSync(trap.calls) ? fs.readFileSync(trap.calls, 'utf8') : '').toBe('');
    expect(build.code).toBe(0);
    expect(build.result.data.targets.map((t: { target: string; status: string }) => [t.target, t.status])).toEqual([
      ['ios', 'built'],
      ['android', 'built'],
    ]);

    const android = path.join(dir, 'out', 'android');
    const files = new Set(listFiles(android));
    for (const f of ['settings.gradle', 'build.gradle', 'app/build.gradle', 'gradlew', 'gradle/wrapper/gradle-wrapper.jar', 'app/src/main/AndroidManifest.xml']) {
      expect(files.has(f), f).toBe(true);
    }
    expect(readText(android, 'app/src/main/java/com/gameshipper/spinningcube/MainActivity.java')).toContain('package com.gameshipper.spinningcube;');
    expect(readText(android, 'app/build.gradle')).toContain(`applicationId "${BUNDLE_ID}"`);
    const settings = readText(android, 'capacitor.settings.gradle');
    for (const [, rel] of settings.matchAll(/new File\('([^']+)'\)/g)) {
      expect(fs.existsSync(path.join(android, rel, 'build.gradle')), rel).toBe(true);
    }
    const page = readText(android, 'app/src/main/assets/public/index.html');
    expect(page).toContain(SHIM_TAG);
    expect(page).not.toContain('https://unpkg.com');
    // three.js was bundled into the game's own files, which Android packages (its asset filter keeps _ folders).
    const three = [...files].filter((f) => f.startsWith('app/src/main/assets/public/_gameshipper/cdn/unpkg.com/three@0.170.0/'));
    expect(three.length).toBeGreaterThan(0);
    // Committing out/android keeps them, although three.js's files are in a build/ folder, which Android's .gitignore ignores.
    if (spawnSync('git', ['--version']).status === 0) {
      expect(spawnSync('git', ['init', '-q'], { cwd: android }).status).toBe(0);
      for (const f of three) expect(spawnSync('git', ['check-ignore', '-q', f], { cwd: android }).status, f).toBe(1);
      fs.rmSync(path.join(android, '.git'), { recursive: true, force: true });
    }
    expect(readText(android, 'app/src/main/assets/capacitor.plugins.json')).toContain('PreferencesPlugin');
    for (const f of [...files].filter((f) => /\.(gradle|xml|swift|pbxproj)$/.test(f))) {
      expect(readText(android, f).includes('node_modules'), f).toBe(false);
    }
    if (spawnSync('xmllint', ['--version']).status === 0) {
      const xml = [...files].filter((f) => f.endsWith('.xml') && !f.startsWith('capacitor-libs/')).map((f) => path.join(android, f));
      expect(spawnSync('xmllint', ['--noout', ...xml], { encoding: 'utf8' }).stderr).toBe('');
    }
    expect(fs.statSync(path.join(android, 'gradlew')).mode & 0o111).not.toBe(0);
    // No path of this computer's Android SDK, wherever the Capacitor CLI might have found one.
    expect(files.has('local.properties')).toBe(false);
    expect(readText(path.join(dir, 'out', 'ios'), 'App/CapApp-SPM/Package.swift')).not.toContain('node_modules');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it.runIf(hasXcode())(
    'the iOS project builds for the Simulator and runs the game there',
    async (ctx) => {
      const deadline = Date.now() + IOS_TEST_LIMIT_MS - WRAP_UP_MS;
      const dir = mobileGame();
      const build = cli(['build', '--target', 'ios'], dir);
      expect(build.result.errors).toEqual([]);
      const ios = path.join(dir, 'out', 'ios');
      expect(spawnSync('plutil', ['-lint', path.join(ios, 'App', 'App', 'Info.plist')]).status).toBe(0);

      // The first build downloads Capacitor's Swift package (two binary frameworks, about 8 MB) from GitHub.
      const app = buildForSimulator(ios, path.join(dir, '.gameshipper', 'xcode'), XCODEBUILD_LIMIT_MS);
      const device = pickIphone();
      const booted = bootSimulator(device, BOOT_LIMIT_MS);
      // Outside the project, which is removed afterwards (Xcode's build folder alone is about 340 MB); each run replaces it.
      const shot = path.join(os.tmpdir(), 'gameshipper-ios-simulator.png');
      try {
        // A simulator that has just booted is busy for a while. On GitHub's macOS runner the game's first start
        // there took over a minute and drew one frame in its first 1.5 s. So a start that reported everything but
        // drew too few frames is followed by another, three in all at most, and everything below is checked on the
        // last one. A start that never reported, or whose saves didn't work, is checked as it is: it fails here.
        const { out, frames, starts } = await startUntilWarm(
          (budgetMs) => runOnSimulator(device, app, BUNDLE_ID, [BRIDGE_OK, 'mobile-probe:', 'gameshipper-frames:'], () => screenshot(device, shot), budgetMs - START_END_MS),
          { markers: [BRIDGE_OK, 'mobile-probe:', 'gameshipper-frames:'], minFrames: 10, maxStarts: MAX_STARTS, startLimitMs: START_LIMIT_MS, deadline },
        );
        const how = `start ${starts.length}: ${starts.join('; ')}`;
        expect(out, how).toContain(BRIDGE_OK); // saved and loaded through Capacitor Preferences
        expect(out, how).toContain('mobile-probe:steam=undefined');
        const [, w, h] = /size=(\d+)x(\d+)/.exec(out)!.map(Number);
        expect(w).toBeGreaterThan(h); // landscape, laid out at the device's width (not the 980px desktop default)
        expect(w).toBeLessThan(980);
        expect(frames ?? 0, `WebGL frames drawn in the first 1.5 s (${how})`).toBeGreaterThan(10);
        const stats = await sharp(shot).stats();
        expect(stats.channels.slice(0, 3).some((c) => c.max - c.min > 8)).toBe(true); // not a blank frame
        await ctx.annotate(`${device.name} (${device.udid}), ${w}x${h}, ${how}, screenshot: ${shot}`);
      } finally {
        if (booted) shutdownSimulator(device);
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    // xcodebuild, a simulator that boots from cold, and the app's first start on it: minutes each on a hosted runner.
    IOS_TEST_LIMIT_MS,
  );
});
