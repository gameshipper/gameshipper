import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { packager, type Options } from '@electron/packager';
import type { Config, DesktopTarget } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { ELECTRON_VERSION } from '../electron.js';
import { defaultBundleId, fileSafeName, slugify } from '../names.js';
import { GsFailure, gsError, type GsError } from '../result.js';
import { packageIgnore } from '../steam/natives.js';
import type { DesktopJob, PackagerPlatform } from './targets.js';

const run = promisify(execFile);

/**
 * Native files must be real files on disk: koffi and the overlay helper (.node) and Steam's library
 * (.dll/.dylib/.so) are unpacked to app.asar.unpacked.
 */
export const ASAR_UNPACK = '*.{node,dll,dylib,so}';

export interface DesktopOutput {
  target: DesktopTarget;
  /** out/<target> */
  dir: string;
  /** The file to launch: .exe, Linux binary, or the binary inside the .app bundle. */
  executable: string;
  warnings: GsError[];
}

/**
 * @param tmpDir packager's scratch folder. It deletes `<tmpDir>/electron-packager` when it starts,
 * so each project gets its own instead of the shared OS temp folder (two builds would corrupt each other).
 */
export function packagerOptions(
  config: Config,
  appDir: string,
  packDir: string,
  tmpDir: string,
  iconBase: string | null,
  job: DesktopJob,
): Options {
  return {
    dir: appDir,
    out: packDir,
    tmpdir: tmpDir,
    platform: job.platform,
    arch: job.arch,
    electronVersion: ELECTRON_VERSION,
    name: config.name,
    executableName: job.platform === 'linux' ? slugify(config.name) : config.name,
    appVersion: config.version,
    appBundleId: config.mobile.bundleId ?? defaultBundleId(config.name),
    icon: iconBase ?? undefined,
    asar: { unpack: ASAR_UNPACK },
    // koffi's and the overlay helper's per-arch .node files are the same in both halves of a universal Mac
    // build; @electron/universal must keep them as they are instead of stopping.
    osxUniversal: { x64ArchFiles: '*.node' },
    overwrite: true,
    prune: false,
    quiet: true,
    // Info.plist would otherwise file the game under Developer Tools.
    appCategoryType: 'public.app-category.games',
    // Without this, the Windows .exe's copyright still names Electron's authors.
    appCopyright: `Copyright © ${new Date().getFullYear()} ${config.name}`,
    // The app folder is already exactly what should ship (staging filtered it). Packager's default
    // ignore list would silently drop game files such as .obj 3D models. The one thing left out is
    // other OSes' Steam files: the app folder holds them for every target being built.
    ignore: packageIgnore(job),
    win32metadata: { ProductName: config.name, FileDescription: config.name, CompanyName: config.name },
  };
}

export function executableFor(config: Config, target: DesktopTarget, dir: string): string {
  if (target === 'windows') return path.join(dir, `${fileSafeName(config.name)}.exe`);
  if (target === 'linux') return path.join(dir, slugify(config.name));
  const name = fileSafeName(config.name);
  return path.join(dir, `${name}.app`, 'Contents', 'MacOS', name);
}

/**
 * Packager writes <Name>-<platform>-<arch> into the pack folder; a successful run moves it to out/<target>.
 * Clears what failed runs, other arches or an earlier game name left there, so they don't pile up.
 */
export function removeStalePackOutput(packDir: string, platform: PackagerPlatform): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(packDir);
  } catch {
    return;
  }
  const suffix = new RegExp(`-${platform}-[a-z0-9]+$`);
  for (const entry of entries) {
    // Retries ride out a file Windows briefly keeps busy (an antivirus scan, the indexer).
    if (suffix.test(entry)) fs.rmSync(path.join(packDir, entry), { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Errors that mean a file is in use (Windows reports EBUSY or EPERM), read-only or not ours to change. */
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function packageFailed(ctx: Ctx, job: DesktopJob, e: unknown): GsFailure {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const fix =
    code !== undefined && LOCKED_CODES.has(code)
      ? "A file Gameshipper has to replace is in use or read-only. Close the game if it's running from out/, and any window or terminal open in out/ or .gameshipper/pack, then build again."
      : `Re-run with --verbose. If Electron couldn't be downloaded, check your connection; the full log is ${ctx.logPath}.`;
  return new GsFailure('PACKAGE_FAILED', `Packaging ${job.target} failed: ${e instanceof Error ? e.message : String(e)}`, fix);
}

export async function packageDesktop(
  ctx: Ctx,
  config: Config,
  appDir: string,
  iconBase: string | null,
  job: DesktopJob,
): Promise<DesktopOutput> {
  const packDir = path.join(ctx.projectDir, '.gameshipper', 'pack');
  const tmpDir = path.join(ctx.projectDir, '.gameshipper', 'packager-tmp');
  ctx.log(`packaging ${job.target} (${job.platform}/${job.arch}) with Electron ${ELECTRON_VERSION}`);
  let produced: string[];
  try {
    removeStalePackOutput(packDir, job.platform);
    produced = await packager(packagerOptions(config, appDir, packDir, tmpDir, iconBase, job));
  } catch (e) {
    throw packageFailed(ctx, job, e);
  }
  if (!produced[0]) {
    throw new GsFailure(
      'PACKAGE_FAILED',
      `Packaging ${job.target} produced no output.`,
      `Re-run with --verbose; the full log is ${ctx.logPath}.`,
    );
  }
  const outDir = path.join(ctx.projectDir, 'out', job.target);
  try {
    // The previous build here is the one a player is most likely to have running.
    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.renameSync(produced[0], outDir);
  } catch (e) {
    throw packageFailed(ctx, job, e);
  }

  const warnings = [...job.warnings];
  if (job.platform === 'darwin' && process.platform === 'darwin') {
    const bundle = path.join(outDir, `${fileSafeName(config.name)}.app`);
    try {
      await run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
    } catch (e) {
      warnings.push(
        gsError('MAC_ADHOC_SIGN_FAILED', `Couldn't ad-hoc sign the Mac app: ${(e as Error).message}`, 'The app may show as damaged when opened from Finder; it still launches from Steam.'),
      );
    }
  }
  const output: DesktopOutput = { target: job.target, dir: outDir, executable: executableFor(config, job.target, outDir), warnings };
  ctx.log(`packaged ${job.target} → ${outDir}`);
  return output;
}
