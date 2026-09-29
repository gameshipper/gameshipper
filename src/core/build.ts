import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeStoreImages, type StoreImagesResult } from './assets/store-images.js';
import { TARGETS, type Config, type Target } from './config/schema.js';
import type { Ctx } from './context.js';
import { assembleApp } from './desktop/assemble.js';
import { makeIcons } from './desktop/icons.js';
import { macAppFor, packageDesktop, type DesktopOutput } from './desktop/package.js';
import { planDesktopJobs, type HostTools } from './desktop/targets.js';
import { buildMobileTargets, MOBILE_TARGETS, type MobileOutput, type MobileTarget } from './mobile/build-mobile.js';
import { mobileConfigError } from './mobile/bundle-id.js';
import { loadPlugins, runPluginHook, type LoadedPlugin, type PluginHookContext } from './plugins.js';
import { bundleCdn } from './prepare/bundle-cdn.js';
import { runBuildCommand, stageGame } from './prepare/stage.js';
import { fail, GsFailure, gsError, ok, type GsError, type Result } from './result.js';
import { finishMacApp, planMacSigning, type MacSigningPlan } from './sign/mac.js';
import { bundleSteam, type SteamBundle } from './steam/bundle.js';
import type { KoffiNativeOptions, NativeTarget } from './steam/natives.js';
import { ensureSteamSdk, findSteamSdk, sdkMissingWarning, steamSdkPaths } from './steam/sdk.js';

export interface TargetResult {
  target: Target;
  status: 'built' | 'failed' | 'skipped';
  output?: DesktopOutput;
  /** ios/android: the generated Xcode or Android Studio project. */
  mobile?: MobileOutput;
  errors: GsError[];
  warnings: GsError[];
}

export interface BuildData {
  targets: TargetResult[];
  outDir: string;
  /** The store images in out/store, made after the desktop targets. */
  store?: StoreImagesResult;
}

export interface PrepareOptions {
  /** Compiled shell (dist/shell in the published package). */
  shellDir: string;
  /** Build exactly what gameshipper.lock records (`--frozen-lock`). */
  frozenLock?: boolean;
  /** `--steam-sdk`: a Steamworks SDK zip or folder, used before steam.sdk and GAMESHIPPER_STEAM_SDK. */
  steamSdk?: string;
  /** Where GAMESHIPPER_STEAM_SDK and the Apple signing variables are read (default process.env; tests pass {}). */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: where koffi's native packages come from (see steam/natives.ts). */
  koffi?: KoffiNativeOptions;
}

export interface BuildOptions extends PrepareOptions {
  only?: Target[];
  host?: NodeJS.Platform;
  /** Injectable for tests; defaults to checking this machine. */
  tools?: HostTools;
  /** Injectable for tests; defaults to the real packager. */
  pack?: typeof packageDesktop;
  /** Injectable for tests; defaults to signing (and notarizing) the Mac app. */
  finishMac?: typeof finishMacApp;
  /** Injectable for tests; defaults to generating the Capacitor projects. */
  mobile?: typeof buildMobileTargets;
}

export interface PreparedApp {
  appDir: string;
  /** The staged game after CDN bundling: the desktop app's game/ folder and the mobile projects' web files. */
  stageDir: string;
  iconBase: string | null;
  warnings: GsError[];
  plugins: LoadedPlugin[];
  steam: SteamBundle;
}

/** Icon problems that stop a build but only earn a warning in `play`, which then uses the default icon. */
const PLAY_ICON_WARNINGS = new Set(['ICON_INVALID', 'ICON_NOT_SQUARE', 'ICON_TOO_SMALL', 'ICON_CONVERT_FAILED']);

/**
 * Shared by build and play: plugins and Steam SDK → build step → stage → bundle CDN files → icons → app folder
 * → Steam support. Throws GsFailure.
 * For `play`, an unusable icon is a warning and the app gets the default icon: it mustn't stop anyone testing the game.
 * `natives` lists every OS/CPU the app will run on (the packaging jobs, or this computer for `play`): Steam support
 * is bundled for each. `mobileOnly`: a build of only iOS and Android, whose warnings shouldn't talk about Electron.
 */
export async function prepareApp(
  ctx: Ctx,
  config: Config,
  opts: PrepareOptions,
  purpose: 'build' | 'play',
  natives: NativeTarget[],
  { mobileOnly = false }: { mobileOnly?: boolean } = {},
): Promise<PreparedApp> {
  // Checked first: a broken plugin or SDK setting should fail before a long game build.
  const plugins = await loadPlugins(ctx, config);
  const sdkOptions = { projectDir: ctx.projectDir, config, env: opts.env ?? process.env, cacheDir: ctx.cacheDir, flagPath: opts.steamSdk };
  const sdkFound = findSteamSdk(sdkOptions);
  await runBuildCommand(ctx, config);
  // Valve's SDK is never game content, even when a setting points inside the game folder.
  const staged = await stageGame(ctx, config, { exclude: steamSdkPaths(sdkOptions, sdkFound) });
  const bundled = await bundleCdn(ctx, staged.stageDir, { frozenLock: opts.frozenLock });
  const warnings = [...plugins.flatMap((p) => p.warnings), ...staged.warnings, ...bundled.warnings];
  let iconBase: string | null = null;
  if (config.icon) {
    const iconPath = path.join(ctx.projectDir, config.icon);
    if (!fs.existsSync(iconPath)) {
      throw new GsFailure('ASSET_MISSING', `icon: ${config.icon} doesn't exist.`, 'Fix the icon path in gameshipper.json or set it to null.');
    }
    try {
      iconBase = makeIcons(iconPath, path.join(ctx.projectDir, '.gameshipper', 'icons'), config.icon);
    } catch (e) {
      if (!(purpose === 'play' && e instanceof GsFailure && PLAY_ICON_WARNINGS.has(e.error.code))) throw e;
      const { code, message, fix } = e.error;
      warnings.push(gsError(code, `${message} Playing with the default icon; \`build\` fails until it's fixed.`, fix));
    }
  } else {
    warnings.push(
      gsError(
        'ICON_MISSING',
        mobileOnly
          ? "No icon set, so the iOS and Android projects keep Capacitor's placeholder icon and splash screen."
          : 'No icon set, so builds use the default Electron icon.',
        'Add a square PNG (1024x1024 or larger) and set "icon" in gameshipper.json.',
      ),
    );
  }
  const appDir = assembleApp(ctx.projectDir, config, {
    stageDir: staged.stageDir,
    shellDir: opts.shellDir,
    iconPng: iconBase ? `${iconBase}.png` : null,
    plugins,
  });
  if (!sdkFound && natives.length) warnings.push(sdkMissingWarning());
  const sdk = sdkFound ? ensureSteamSdk(ctx, sdkFound) : null;
  const steam = await bundleSteam(ctx, appDir, sdk, natives, opts.koffi);
  warnings.push(...steam.warnings);
  return { appDir, stageDir: staged.stageDir, iconBase, warnings, plugins, steam };
}

/** One entry per code and message: iOS and Android often fail for the same reason (BUNDLE_ID_REQUIRED, say). */
function uniqueIssues(issues: GsError[]): GsError[] {
  const seen = new Set<string>();
  return issues.filter((e) => {
    const key = `${e.code}\u0000${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const mobileTargets = wanted.filter((t): t is MobileTarget => (MOBILE_TARGETS as readonly Target[]).includes(t));
  // Before anything is built: the bundle ID and version are config errors (exit 2), like half-set Apple variables.
  const mobileError = mobileTargets.length ? mobileConfigError(config) : null;
  if (mobileError) return fail(mobileError);
  // Planned first: the jobs decide which OSes' Steam files the app needs.
  const plan = planDesktopJobs(wanted, opts.host ?? process.platform, opts.tools);

  let prepared: PreparedApp;
  let hookBase: PluginHookContext;
  let macSigning: MacSigningPlan | null = null;
  try {
    // Before the game build: half-set Apple variables or a missing certificate would otherwise only show after packaging.
    if (plan.jobs.some((j) => j.target === 'mac')) macSigning = await planMacSigning(opts.host ?? process.platform, opts.env ?? process.env);
    const natives = plan.jobs.map((j) => ({ platform: j.platform, arch: j.arch }));
    prepared = await prepareApp(ctx, config, opts, 'build', natives, { mobileOnly: !plan.jobs.length && mobileTargets.length > 0 });
    hookBase = { projectDir: ctx.projectDir, appDir: prepared.appDir, config, log: (m) => ctx.log(m) };
    // May still change the app folder: it runs before any target is packaged. Hooks are for desktop apps only.
    if (plan.jobs.length) await runPluginHook(prepared.plugins, 'beforePackage', { ...hookBase, targets: plan.jobs.map((j) => j.target) });
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error);
    throw e;
  }

  const pack = opts.pack ?? packageDesktop;
  const targets: TargetResult[] = [];
  for (const job of plan.jobs) {
    try {
      const packaged = await pack(ctx, config, prepared.appDir, prepared.iconBase, job);
      // A failing afterPackage fails this target only.
      await runPluginHook(prepared.plugins, 'afterPackage', { ...hookBase, target: job.target, outDir: packaged.dir, executable: packaged.executable });
      let output = packaged;
      // Signing comes last: the hooks may still change the .app, and any change after signing breaks the signature.
      if (job.target === 'mac' && macSigning) {
        const steam = prepared.steam.targets.includes('mac');
        const signed = await (opts.finishMac ?? finishMacApp)(ctx, config, macAppFor(config, packaged.dir), macSigning, { steam });
        output = { ...packaged, mac: { signing: signed.signing, notarized: signed.notarized }, warnings: [...packaged.warnings, ...signed.warnings] };
      }
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
  const iconPng = prepared.iconBase ? `${prepared.iconBase}.png` : null;
  for (const r of await (opts.mobile ?? buildMobileTargets)(ctx, config, mobileTargets, { stageDir: prepared.stageDir, iconPng })) {
    targets.push(
      'output' in r
        ? { target: r.target, status: 'built', mobile: r.output, errors: [], warnings: [] }
        : { target: r.target, status: 'failed', errors: [r.error], warnings: [] },
    );
  }
  for (const s of plan.skipped) {
    targets.push(
      s.fatal
        ? { target: s.target, status: 'failed', errors: [s.reason], warnings: [] }
        : { target: s.target, status: 'skipped', errors: [], warnings: [s.reason] },
    );
  }
  targets.sort((a, b) => TARGETS.indexOf(a.target) - TARGETS.indexOf(b.target));
  // Made on every build, --target or not: it takes about a second, and `check` needs them.
  const store = await makeStoreImages(ctx, config);

  const errors = uniqueIssues([...targets.flatMap((t) => t.errors), ...store.errors]);
  const warnings = uniqueIssues([...prepared.warnings, ...targets.flatMap((t) => t.warnings), ...store.warnings]);
  const data: BuildData = { targets, outDir, store };
  return errors.length ? fail(errors, warnings, data) : ok(data, warnings);
}
