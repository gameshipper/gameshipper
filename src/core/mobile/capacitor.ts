import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Ctx } from '../context.js';
import { killTree, OUTPUT_BUFFER_CHARS, outputTail, stopWithGameshipper } from '../proc.js';
import { GsFailure } from '../result.js';

const require = createRequire(import.meta.url);

/** Packages copied into the mobile workspace's node_modules (their native code ends up in out/ios and out/android). */
export const NATIVE_PACKAGES = ['@capacitor/core', '@capacitor/ios', '@capacitor/android', '@capacitor/preferences'] as const;

export function packageDir(name: string): string {
  return path.dirname(require.resolve(`${name}/package.json`));
}

export function packageVersion(name: string): string {
  return (require(`${name}/package.json`) as { version: string }).version;
}

/** The Capacitor version every mobile project uses; pinned exactly in package.json. */
export const CAPACITOR_VERSION = packageVersion('@capacitor/core');

/** `cap add` takes well under a second; anything close to this is stuck. */
const CAPACITOR_TIMEOUT_MS = 2 * 60_000;

function failed(message: string, fix: string): GsFailure {
  return new GsFailure('MOBILE_GENERATE_FAILED', message, fix);
}

/**
 * An empty folder in workDir that the Capacitor CLI gets as its home folder. In the real one it looks for the
 * Android SDK where Android Studio installs it on a Mac (~/Library/Android/sdk). When that exists, `cap add android`
 * writes its path into the project's local.properties and runs ./gradlew, which downloads Gradle and the Android
 * build tools: minutes on the network, for a project that is generated offline and holds no path from this computer.
 */
function emptyHome(workDir: string): string {
  const home = path.join(workDir, 'home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Runs Gameshipper's own copy of the Capacitor CLI in workDir, logging its output to the run log. Piped output
 * and CI=1 keep it non-interactive, which also keeps its telemetry off and its settings file unwritten. Its home
 * folder (HOME, or USERPROFILE on Windows) is an empty one, so it never runs Gradle (see emptyHome); the folder is
 * deleted again when the CLI is done, however it ended.
 * Throws MOBILE_GENERATE_FAILED.
 */
export async function runCapacitor(ctx: Ctx, workDir: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  const home = emptyHome(workDir);
  try {
    await runCapacitorWithHome(ctx, workDir, home, args, opts);
  } finally {
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      // Still in use (Windows, a CLI that was just stopped): the next run empties it before it starts.
      ctx.log(`couldn't delete ${home}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function runCapacitorWithHome(ctx: Ctx, workDir: string, home: string, args: string[], opts: { timeoutMs?: number }): Promise<void> {
  const cli = path.join(packageDir('@capacitor/cli'), 'bin', 'capacitor');
  const shown = `cap ${args.join(' ')}`;
  ctx.log(`${shown} (in ${workDir})`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: workDir,
      env: { ...process.env, CI: '1', HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let output = '';
    const onData = (text: string): void => {
      for (const line of text.split('\n')) if (line.trim()) ctx.log(`[capacitor] ${line.trimEnd()}`);
      output = (output + text).slice(-OUTPUT_BUFFER_CHARS);
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    const detach = stopWithGameshipper(child);
    const timer = setTimeout(() => {
      killTree(child);
      reject(failed(`\`${shown}\` was still running after ${CAPACITOR_TIMEOUT_MS / 1000} seconds.`, `Build again; the Capacitor output is in ${ctx.logPath}.`));
    }, opts.timeoutMs ?? CAPACITOR_TIMEOUT_MS);
    const done = (): void => {
      clearTimeout(timer);
      detach();
    };
    child.on('error', (e) => {
      done();
      reject(failed(`Couldn't run the Capacitor CLI: ${e.message}`, 'Reinstall Gameshipper (`npx gameshipper@latest`), then build again.'));
    });
    child.on('close', (code) => {
      done();
      if (code === 0) resolve();
      else reject(failed(`\`${shown}\` failed (exit code ${code}): ${outputTail(output)}`, `The full Capacitor output is in ${ctx.logPath}.`));
    });
  });
}
