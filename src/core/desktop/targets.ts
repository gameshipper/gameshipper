import { spawnSync } from 'node:child_process';
import type { DesktopTarget, Target } from '../config/schema.js';
import { gsError, type GsError } from '../result.js';

export type PackagerPlatform = 'win32' | 'darwin' | 'linux';
export type PackagerArch = 'x64' | 'arm64' | 'universal';

export interface DesktopJob {
  target: DesktopTarget;
  platform: PackagerPlatform;
  arch: PackagerArch;
  warnings: GsError[];
}

export interface SkippedTarget {
  target: Target;
  reason: GsError;
  /** true = the target failed (e.g. MAC_BUILD_HOST); false = informational. */
  fatal: boolean;
}

export interface DesktopPlan {
  jobs: DesktopJob[];
  skipped: SkippedTarget[];
}

/** Tools on this machine that change what can be built. */
export interface HostTools {
  /** Apple's `lipo` (Xcode command-line tools), which merging a universal Mac app needs. */
  lipo: boolean;
}

/** Runs a command without output; true when it exits 0. */
export type RunTool = (command: string, args: string[]) => boolean;

const runQuietly: RunTool = (command, args) => spawnSync(command, args, { stdio: 'ignore', timeout: 15_000 }).status === 0;

/**
 * Checks for the tools planDesktopJobs needs. `xcode-select -p` goes first: without the command-line tools,
 * running `xcrun` makes macOS pop up an install dialog.
 */
export function detectHostTools(host: NodeJS.Platform = process.platform, run: RunTool = runQuietly): HostTools {
  if (host !== 'darwin') return { lipo: false };
  return { lipo: run('xcode-select', ['-p']) && run('xcrun', ['--find', 'lipo']) };
}

const ORDER: Target[] = ['windows', 'mac', 'linux', 'ios', 'android'];

function arm64MacJob(warning: GsError): DesktopJob {
  return { target: 'mac', platform: 'darwin', arch: 'arm64', warnings: [warning] };
}

/**
 * `tools` may be a function: it's only called when a Mac app is planned on a Mac, so other plans never
 * run Apple's tools (checking takes two processes).
 */
export function planDesktopJobs(
  targets: readonly Target[],
  host: NodeJS.Platform,
  tools: HostTools | (() => HostTools) = () => detectHostTools(host),
): DesktopPlan {
  const plan: DesktopPlan = { jobs: [], skipped: [] };
  for (const target of ORDER.filter((t) => targets.includes(t))) {
    if (target === 'windows') plan.jobs.push({ target, platform: 'win32', arch: 'x64', warnings: [] });
    else if (target === 'linux') plan.jobs.push({ target, platform: 'linux', arch: 'x64', warnings: [] });
    else if (target === 'mac') {
      if (host === 'darwin' && (typeof tools === 'function' ? tools() : tools).lipo) {
        plan.jobs.push({ target, platform: 'darwin', arch: 'universal', warnings: [] });
      }
      else if (host === 'darwin') {
        plan.jobs.push(
          arm64MacJob(
            gsError(
              'MAC_NOT_UNIVERSAL',
              "This Mac build runs on Apple Silicon only: universal builds need Apple's command-line tools (lipo), which aren't installed.",
              'Run `xcode-select --install`, then build again to include Intel Macs.',
            ),
          ),
        );
      } else if (host === 'win32') {
        plan.skipped.push({
          target,
          fatal: true,
          reason: gsError(
            'MAC_BUILD_HOST',
            "Mac builds can't be made on Windows (Electron's Mac framework needs symlinks).",
            'Build the Mac version on a Mac or Linux machine, or use the GitHub Actions template. Pass --target windows,linux to skip it here.',
          ),
        });
      } else {
        plan.jobs.push(
          arm64MacJob(
            gsError(
              'MAC_NOT_UNIVERSAL',
              "This Mac build runs on Apple Silicon only; universal builds need a Mac.",
              'Build on a Mac (or the GitHub Actions template) to include Intel Macs.',
            ),
          ),
        );
      }
    }
    // ios and android aren't packaged with Electron: runBuild hands them to buildMobileTargets.
  }
  return plan;
}
