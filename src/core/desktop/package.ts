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
import type { DesktopJob } from './targets.js';

const run = promisify(execFile);

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
    asar: true,
    overwrite: true,
    prune: false,
    quiet: true,
    // The app folder is already exactly what should ship (staging filtered it). Packager's default
    // ignore list would silently drop game files such as .obj 3D models.
    ignore: () => false,
    win32metadata: { ProductName: config.name, FileDescription: config.name, CompanyName: config.name },
  };
}

export function executableFor(config: Config, target: DesktopTarget, dir: string): string {
  if (target === 'windows') return path.join(dir, `${fileSafeName(config.name)}.exe`);
  if (target === 'linux') return path.join(dir, slugify(config.name));
  const name = fileSafeName(config.name);
  return path.join(dir, `${name}.app`, 'Contents', 'MacOS', name);
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
    produced = await packager(packagerOptions(config, appDir, packDir, tmpDir, iconBase, job));
  } catch (e) {
    throw new GsFailure(
      'PACKAGE_FAILED',
      `Packaging ${job.target} failed: ${(e as Error).message}`,
      `Re-run with --verbose. If Electron couldn't be downloaded, check your connection; the full log is ${ctx.logPath}.`,
    );
  }
  if (!produced[0]) {
    throw new GsFailure(
      'PACKAGE_FAILED',
      `Packaging ${job.target} produced no output.`,
      `Re-run with --verbose; the full log is ${ctx.logPath}.`,
    );
  }
  const outDir = path.join(ctx.projectDir, 'out', job.target);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.renameSync(produced[0], outDir);

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
