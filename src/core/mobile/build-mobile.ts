import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { errorDetails, GsFailure, gsError, type GsError } from '../result.js';
import { checkBundleId } from './bundle-id.js';
import { runCapacitor } from './capacitor.js';
import { writeAndroidImages, writeIosImages } from './images.js';
import { configureAndroid } from './native-android.js';
import { configureIos, readDevelopmentTeam } from './native-ios.js';
import { vendorAndroid, vendorIos } from './vendor.js';
import { prepareMobileWorkspace } from './workspace.js';

export const MOBILE_TARGETS = ['ios', 'android'] as const;
export type MobileTarget = (typeof MOBILE_TARGETS)[number];

export interface MobileOutput {
  target: MobileTarget;
  /** out/ios or out/android */
  dir: string;
  /** What to open: out/ios/App/App.xcodeproj in Xcode, out/android in Android Studio. */
  project: string;
}

export type MobileTargetResult = { target: MobileTarget; output: MobileOutput } | { target: MobileTarget; error: GsError };

export interface MobileInput {
  /** The staged game after CDN bundling (.gameshipper/stage). */
  stageDir: string;
  /** Square PNG, at least 1024x1024; null keeps Capacitor's placeholder icon and splash. */
  iconPng: string | null;
}

async function generateTarget(ctx: Ctx, config: Config, workDir: string, target: MobileTarget, iconPng: string | null): Promise<MobileOutput> {
  const platformDir = path.join(workDir, target);
  const outDir = path.join(ctx.projectDir, 'out', target);
  fs.rmSync(platformDir, { recursive: true, force: true });
  await runCapacitor(ctx, workDir, ['add', target]);
  if (target === 'ios') {
    configureIos(platformDir, config, readDevelopmentTeam(outDir));
    vendorIos(platformDir);
    if (iconPng) await writeIosImages(platformDir, iconPng);
  } else {
    configureAndroid(platformDir, config);
    vendorAndroid(platformDir);
    if (iconPng) await writeAndroidImages(platformDir, iconPng);
  }
  try {
    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.renameSync(platformDir, outDir);
  } catch (e) {
    throw new GsFailure(
      'MOBILE_GENERATE_FAILED',
      `Couldn't replace out/${target}: ${e instanceof Error ? e.message : String(e)}`,
      'Close Xcode or Android Studio if they have the project open (they can lock its files), then build again.',
    );
  }
  ctx.log(`generated the ${target} project → ${outDir}`);
  return { target, dir: outDir, project: target === 'ios' ? path.join(outDir, 'App', 'App.xcodeproj') : outDir };
}

/** A GsFailure's own error; anything else (a Gameshipper bug, a disk problem) as MOBILE_GENERATE_FAILED, stack logged. */
function mobileError(ctx: Ctx, what: string, e: unknown): GsError {
  if (e instanceof GsFailure) return e.error;
  ctx.log(errorDetails(e));
  return gsError(
    'MOBILE_GENERATE_FAILED',
    `${what} failed: ${e instanceof Error ? e.message : String(e)}`,
    `Check the disk has space and the project folder can be written, then build again. If it keeps failing, re-run with --verbose and report the log (${ctx.logPath}).`,
  );
}

/**
 * Spec §7.3 step 7: generates out/ios (an Xcode project) and out/android (an Android Studio project) from the
 * staged game. Works on any OS: nothing here needs Xcode, CocoaPods or the Android SDK. Each target succeeds or
 * fails on its own, whatever the error: a mobile problem never costs the desktop builds their result.
 */
export async function buildMobileTargets(ctx: Ctx, config: Config, targets: readonly MobileTarget[], input: MobileInput): Promise<MobileTargetResult[]> {
  if (!targets.length) return [];
  const idError = checkBundleId(config);
  if (idError) return targets.map((target) => ({ target, error: idError }));
  let workDir: string;
  try {
    workDir = prepareMobileWorkspace(ctx, config, input.stageDir);
  } catch (e) {
    const error = mobileError(ctx, "Preparing the iOS and Android projects' web files", e);
    ctx.log(`preparing the mobile workspace failed: ${error.message}`);
    return targets.map((target) => ({ target, error }));
  }
  const results: MobileTargetResult[] = [];
  for (const target of targets) {
    try {
      results.push({ target, output: await generateTarget(ctx, config, workDir, target, input.iconPng) });
    } catch (e) {
      const error = mobileError(ctx, `Generating the ${target === 'ios' ? 'iOS' : 'Android'} project`, e);
      ctx.log(`generating the ${target} project failed: ${error.message}`);
      results.push({ target, error });
    }
  }
  return results;
}
