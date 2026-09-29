import * as fs from 'node:fs';
import * as path from 'node:path';
import { DECK_SIZE } from '../../shell/capture.js';
import { frameInfo, type FrameInfo } from '../assets/inspect.js';
import type { Config, DesktopTarget } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { fail, GsFailure, ok, type GsError, type Result } from '../result.js';
import { readLoggedEvents, runSmoke, type SmokeData } from '../smoke.js';
import { launchChecks } from './launch.js';
import { inspectMacSigning, type MacSigning } from './mac-signing.js';
import { appIdCheck, buildsCheck, findBuilds, iconCheck, macAppPath, macSigningCheck, steamAppIdCheck } from './review.js';
import { appAsarPath, scanBuildCode } from './scan.js';
import { aiDisclosureCheck, screenshotsCheck, storeImagesCheck, trailerCheck } from './store.js';
import { checkIssues, countStatuses, type CheckReport } from './types.js';

/** How long `check` runs the game with the network blocked (spec §9: about 15 s). */
export const DEFAULT_CHECK_SECONDS = 15;

export interface CheckOptions {
  seconds?: number;
  host?: NodeJS.Platform;
  /** Injectable for tests. */
  smoke?: typeof runSmoke;
  /** Injectable for tests. */
  macSigning?: (appPath: string) => Promise<MacSigning>;
}

export function hostTarget(host: NodeJS.Platform): DesktopTarget | null {
  if (host === 'darwin') return 'mac';
  if (host === 'win32') return 'windows';
  if (host === 'linux') return 'linux';
  return null;
}

/** .gameshipper/check: this run's report, last frame and throwaway saves. */
export function checkDirFor(projectDir: string): string {
  return path.join(projectDir, '.gameshipper', 'check');
}

/**
 * The readiness report (spec §9): launches the build for this computer once, offline and at Steam Deck size, then
 * adds the review and store checks. Never builds anything itself.
 */
export async function runCheck(ctx: Ctx, config: Config, opts: CheckOptions = {}): Promise<Result<CheckReport>> {
  const seconds = opts.seconds ?? DEFAULT_CHECK_SECONDS;
  const hostOs = opts.host ?? process.platform;
  const host = hostTarget(hostOs);
  const checkDir = checkDirFor(ctx.projectDir);
  fs.rmSync(checkDir, { recursive: true, force: true });
  fs.mkdirSync(checkDir, { recursive: true });

  const builds = findBuilds(ctx.projectDir, config);
  const hostBuild = builds.find((b) => b.target === host && b.built) ?? null;
  let smoke: Result<SmokeData> | null = null;
  let launchError: GsError | null = null;
  if (hostBuild) {
    ctx.log(`check: running ${hostBuild.executable} for ${seconds} s, offline, at ${DECK_SIZE.width}x${DECK_SIZE.height}`);
    try {
      smoke = await (opts.smoke ?? runSmoke)(ctx, {
        command: hostBuild.executable,
        args: [],
        seconds,
        userDataDir: path.join(checkDir, 'data'),
        windowed: true,
        capture: { offline: true, viewport: DECK_SIZE, probeDir: checkDir },
      });
      if (!smoke.data) {
        launchError = smoke.errors[0] ?? null;
        smoke = null;
      }
    } catch (e) {
      if (!(e instanceof GsFailure)) throw e;
      launchError = e.error;
    }
  }

  const probe = smoke?.data?.summary.probe ?? null;
  let frame: FrameInfo | null = null;
  if (probe?.frame) {
    try {
      frame = await frameInfo(probe.frame);
    } catch (e) {
      ctx.log(`check: couldn't read ${probe.frame}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // The summary keeps only the first events; the events log has every blocked request.
  const blocked = smoke?.data ? readLoggedEvents(smoke.data.eventsLog, ['blocked-request']).map((e) => e.url) : [];
  const scanned = hostBuild ?? builds.find((b) => b.built) ?? null;
  const scan = scanned ? scanBuildCode(appAsarPath(scanned.target, scanned.executable, scanned.dir)) : null;
  const macBuild = builds.find((b) => b.target === 'mac' && b.built);
  const signing = macBuild && hostOs === 'darwin' ? await (opts.macSigning ?? inspectMacSigning)(macAppPath(macBuild.executable)) : null;

  const checks = [
    ...launchChecks({
      host,
      hostTargeted: builds.some((b) => b.target === host),
      launched: hostBuild ? path.relative(ctx.projectDir, hostBuild.executable) : null,
      seconds,
      smoke,
      launchError,
      blocked,
      frame,
      scan,
      otherBuilt: builds.filter((b) => b.built && b.target !== host).map((b) => b.target),
    }),
    buildsCheck(builds),
    steamAppIdCheck(ctx.projectDir),
    macSigningCheck(config, builds, hostOs, signing),
    iconCheck(config),
    appIdCheck(config),
    await storeImagesCheck(ctx.projectDir, config),
    await screenshotsCheck(ctx.projectDir),
    trailerCheck(),
    aiDisclosureCheck(),
  ];

  const report: CheckReport = {
    host,
    launched: hostBuild
      ? { target: hostBuild.target, executable: hostBuild.executable, seconds, exitCode: smoke?.data?.exitCode ?? null, eventsLog: smoke?.data?.eventsLog ?? null }
      : null,
    checks,
    counts: countStatuses(checks),
    deckScreenshot: frame && probe?.frame ? probe.frame : null,
    reportFile: path.join(checkDir, 'report.json'),
  };
  fs.writeFileSync(report.reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const errors = checkIssues(checks, 'fail');
  const warnings = checkIssues(checks, 'warn');
  return errors.length ? fail(errors, warnings, report) : ok(report, warnings);
}
