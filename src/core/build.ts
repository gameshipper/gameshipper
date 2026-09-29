import * as fs from 'node:fs';
import * as path from 'node:path';
import { TARGETS, type Config, type Target } from './config/schema.js';
import type { Ctx } from './context.js';
import { assembleApp } from './desktop/assemble.js';
import { makeIcons } from './desktop/icons.js';
import { packageDesktop, type DesktopOutput } from './desktop/package.js';
import { planDesktopJobs, type HostTools } from './desktop/targets.js';
import { bundleCdn } from './prepare/bundle-cdn.js';
import { runBuildCommand, stageGame } from './prepare/stage.js';
import { fail, GsFailure, gsError, ok, type GsError, type Result } from './result.js';

export interface TargetResult {
  target: Target;
  status: 'built' | 'failed' | 'skipped';
  output?: DesktopOutput;
  errors: GsError[];
  warnings: GsError[];
}

export interface BuildData {
  targets: TargetResult[];
  outDir: string;
}

export interface PrepareOptions {
  /** Compiled shell (dist/shell in the published package). */
  shellDir: string;
  /** Build exactly what gameshipper.lock records (`--frozen-lock`). */
  frozenLock?: boolean;
}

export interface BuildOptions extends PrepareOptions {
  only?: Target[];
  host?: NodeJS.Platform;
  /** Injectable for tests; defaults to checking this machine. */
  tools?: HostTools;
  /** Injectable for tests; defaults to the real packager. */
  pack?: typeof packageDesktop;
}

export interface PreparedApp {
  appDir: string;
  iconBase: string | null;
  warnings: GsError[];
}

/** Shared by build and play: build step → stage → bundle CDN files → icons → app folder. Throws GsFailure. */
export async function prepareApp(ctx: Ctx, config: Config, opts: PrepareOptions): Promise<PreparedApp> {
  await runBuildCommand(ctx, config);
  const staged = await stageGame(ctx, config);
  const bundled = await bundleCdn(ctx, staged.stageDir, { frozenLock: opts.frozenLock });
  const warnings = [...staged.warnings, ...bundled.warnings];
  let iconBase: string | null = null;
  if (config.icon) {
    const iconPath = path.join(ctx.projectDir, config.icon);
    if (!fs.existsSync(iconPath)) {
      throw new GsFailure('ASSET_MISSING', `icon: ${config.icon} doesn't exist.`, 'Fix the icon path in gameshipper.json or set it to null.');
    }
    iconBase = makeIcons(iconPath, path.join(ctx.projectDir, '.gameshipper', 'icons'));
  } else {
    warnings.push(
      gsError('ICON_MISSING', 'No icon set, so builds use the default Electron icon.', 'Add a square PNG (1024x1024 or larger) and set "icon" in gameshipper.json.'),
    );
  }
  const appDir = assembleApp(ctx.projectDir, config, { stageDir: staged.stageDir, shellDir: opts.shellDir, iconPng: iconBase ? `${iconBase}.png` : null });
  return { appDir, iconBase, warnings };
}

/** Packages every wanted target. One target failing never stops the others. */
export async function runBuild(ctx: Ctx, config: Config, opts: BuildOptions): Promise<Result<BuildData>> {
  const outDir = path.join(ctx.projectDir, 'out');
  if (opts.only) {
    const unknown = opts.only.filter((t) => !config.targets.includes(t));
    if (unknown.length) {
      return fail(
        gsError(
          'TARGET_NOT_CONFIGURED',
          `${unknown.join(', ')} isn't in "targets" in gameshipper.json.`,
          `Add it to "targets", or pick from: ${config.targets.join(', ')}.`,
        ),
      );
    }
  }
  const wanted = opts.only ? config.targets.filter((t) => opts.only?.includes(t)) : config.targets;

  let prepared: PreparedApp;
  try {
    prepared = await prepareApp(ctx, config, opts);
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error);
    throw e;
  }

  const plan = planDesktopJobs(wanted, opts.host ?? process.platform, opts.tools);
  const pack = opts.pack ?? packageDesktop;
  const targets: TargetResult[] = [];
  for (const job of plan.jobs) {
    try {
      const output = await pack(ctx, config, prepared.appDir, prepared.iconBase, job);
      targets.push({ target: job.target, status: 'built', output, errors: [], warnings: output.warnings });
    } catch (e) {
      const error =
        e instanceof GsFailure
          ? e.error
          : gsError('PACKAGE_FAILED', `Packaging ${job.target} failed: ${e instanceof Error ? e.message : String(e)}`, `See ${ctx.logPath}.`);
      ctx.log(`packaging ${job.target} failed: ${error.message}`);
      targets.push({ target: job.target, status: 'failed', errors: [error], warnings: job.warnings });
    }
  }
  for (const s of plan.skipped) {
    targets.push(
      s.fatal
        ? { target: s.target, status: 'failed', errors: [s.reason], warnings: [] }
        : { target: s.target, status: 'skipped', errors: [], warnings: [s.reason] },
    );
  }
  targets.sort((a, b) => TARGETS.indexOf(a.target) - TARGETS.indexOf(b.target));

  const errors = targets.flatMap((t) => t.errors);
  const warnings = [...prepared.warnings, ...targets.flatMap((t) => t.warnings)];
  const data: BuildData = { targets, outDir };
  return errors.length ? fail(errors, warnings, data) : ok(data, warnings);
}
