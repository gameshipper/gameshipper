import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config/load.js';
import { DESKTOP_TARGETS, TARGETS, type Config, type DesktopTarget, type Target } from './config/schema.js';
import { planDesktopJobs } from './desktop/targets.js';
import { ELECTRON_VERSION } from './electron.js';
import { ok, type GsError, type Result } from './result.js';
import { readLastRuns, type LastRun } from './runs.js';
import { GAMESHIPPER_VERSION } from './version.js';

export interface StatusData {
  projectDir: string;
  gameshipperVersion: string;
  electronVersion: string;
  host: { platform: NodeJS.Platform; arch: string };
  config: Config | null;
  buildableHere: Target[];
  notBuildableHere: Array<{ target: Target; reason: GsError }>;
  outputs: Array<{ target: DesktopTarget; dir: string; exists: boolean }>;
  lastRuns: Record<string, LastRun>;
}

/**
 * Succeeds for any existing folder: it is the command an agent runs first to find out what state things are in.
 * Config problems come back as warnings; a valid config with a missing file is still shown.
 */
export function getStatus(projectDir: string, host: NodeJS.Platform = process.platform): Result<StatusData> {
  const loaded = loadConfig(projectDir);
  const plan = planDesktopJobs(TARGETS, host);
  const data: StatusData = {
    projectDir,
    gameshipperVersion: GAMESHIPPER_VERSION,
    electronVersion: ELECTRON_VERSION,
    host: { platform: host, arch: process.arch },
    config: loaded.data ?? null,
    buildableHere: plan.jobs.map((j) => j.target),
    notBuildableHere: plan.skipped.map((s) => ({ target: s.target, reason: s.reason })),
    outputs: DESKTOP_TARGETS.map((target) => {
      const dir = path.join(projectDir, 'out', target);
      return { target, dir, exists: fs.existsSync(dir) };
    }),
    lastRuns: readLastRuns(projectDir),
  };
  return ok(data, loaded.errors);
}
