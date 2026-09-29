import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheRoot } from './cache.js';
import { loadConfig } from './config/load.js';
import { TARGETS, type Config, type DesktopTarget, type Target } from './config/schema.js';
import { planDesktopJobs } from './desktop/targets.js';
import { ELECTRON_VERSION } from './electron.js';
import { MOBILE_TARGETS } from './mobile/build-mobile.js';
import { GsFailure, ok, type GsError, type Result } from './result.js';
import { readLastRuns, type LastRun } from './runs.js';
import { findSteamSdk, sdkMissingWarning, type SdkSourceKind } from './steam/sdk.js';
import { GAMESHIPPER_VERSION } from './version.js';

export interface StatusData {
  projectDir: string;
  gameshipperVersion: string;
  electronVersion: string;
  host: { platform: NodeJS.Platform; arch: string };
  config: Config | null;
  buildableHere: Target[];
  notBuildableHere: Array<{ target: Target; reason: GsError }>;
  outputs: Array<{ target: Target; dir: string; exists: boolean }>;
  lastRuns: Record<string, LastRun>;
  /** The Steamworks SDK builds would use, or null: then builds have no Steam features. */
  steamSdk: { source: SdkSourceKind; path: string; version: string | null; targets: DesktopTarget[] } | null;
}

/** The SDK builds would find. Its problems are warnings like the config's: `status` always answers. */
function steamSdkStatus(projectDir: string, config: Config | null, env: NodeJS.ProcessEnv, warnings: GsError[]): StatusData['steamSdk'] {
  try {
    const found = findSteamSdk({ projectDir, config, env, cacheDir: cacheRoot(env) });
    // A folder that isn't a project has nothing to build, so a missing SDK isn't worth a warning there.
    if (!found && config) warnings.push(sdkMissingWarning());
    return found && { source: found.kind, path: found.path, version: found.version, targets: found.targets };
  } catch (e) {
    if (!(e instanceof GsFailure)) throw e;
    warnings.push(e.error);
    return null;
  }
}

/**
 * Succeeds for any existing folder: it is the command an agent runs first to find out what state things are in.
 * Config problems come back as warnings; a valid config with a missing file is still shown.
 */
export function getStatus(projectDir: string, host: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Result<StatusData> {
  const loaded = loadConfig(projectDir);
  const warnings = [...loaded.errors];
  const plan = planDesktopJobs(TARGETS, host);
  const data: StatusData = {
    projectDir,
    gameshipperVersion: GAMESHIPPER_VERSION,
    electronVersion: ELECTRON_VERSION,
    host: { platform: host, arch: process.arch },
    config: loaded.data ?? null,
    // Xcode and Android Studio projects are generated on any OS.
    buildableHere: TARGETS.filter((t) => plan.jobs.some((j) => j.target === t) || (MOBILE_TARGETS as readonly Target[]).includes(t)),
    notBuildableHere: plan.skipped.map((s) => ({ target: s.target, reason: s.reason })),
    outputs: TARGETS.map((target) => {
      const dir = path.join(projectDir, 'out', target);
      return { target, dir, exists: fs.existsSync(dir) };
    }),
    lastRuns: readLastRuns(projectDir),
    steamSdk: steamSdkStatus(projectDir, loaded.data ?? null, env, warnings),
  };
  return ok(data, warnings);
}
