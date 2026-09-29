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
  /** true = the target failed; false = informational (e.g. not supported yet). */
  fatal: boolean;
}

export interface DesktopPlan {
  jobs: DesktopJob[];
  skipped: SkippedTarget[];
}

const ORDER: Target[] = ['windows', 'mac', 'linux', 'ios', 'android'];

export function planDesktopJobs(targets: readonly Target[], host: NodeJS.Platform): DesktopPlan {
  const plan: DesktopPlan = { jobs: [], skipped: [] };
  for (const target of ORDER.filter((t) => targets.includes(t))) {
    if (target === 'windows') plan.jobs.push({ target, platform: 'win32', arch: 'x64', warnings: [] });
    else if (target === 'linux') plan.jobs.push({ target, platform: 'linux', arch: 'x64', warnings: [] });
    else if (target === 'mac') {
      if (host === 'darwin') plan.jobs.push({ target, platform: 'darwin', arch: 'universal', warnings: [] });
      else if (host === 'win32') {
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
        plan.jobs.push({
          target,
          platform: 'darwin',
          arch: 'arm64',
          warnings: [
            gsError(
              'MAC_NOT_UNIVERSAL',
              "This Mac build runs on Apple Silicon only; universal builds need a Mac.",
              'Build on a Mac (or the GitHub Actions template) to include Intel Macs.',
            ),
          ],
        });
      }
    } else {
      plan.skipped.push({
        target,
        fatal: false,
        reason: gsError('TARGET_NOT_YET_SUPPORTED', `${target} builds aren't available in this version yet.`, `Remove "${target}" from targets, or ignore this warning.`),
      });
    }
  }
  return plan;
}
