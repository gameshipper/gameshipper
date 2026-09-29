import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, DesktopTarget } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { GsFailure, gsError, type GsError } from '../result.js';
import { readZipEntries, readZipEntry } from './zip.js';

/** Where each desktop target's Steamworks library lives inside redistributable_bin/. */
export const SDK_LIBS: Record<DesktopTarget, string> = {
  windows: 'win64/steam_api64.dll',
  mac: 'osx/libsteam_api.dylib',
  linux: 'linux64/libsteam_api.so',
};
const SDK_TARGETS = Object.keys(SDK_LIBS) as DesktopTarget[];

export const SDK_DOWNLOAD_URL = 'https://partner.steamgames.com/downloads/list';

export type SdkSourceKind = 'flag' | 'config' | 'env' | 'project' | 'cache';

export interface SdkFound {
  kind: SdkSourceKind;
  /** The zip file or folder that was found. */
  path: string;
  format: 'zip' | 'dir';
  /** e.g. "1.65", from the SDK's Readme.txt or the zip's file name; null when unknown. */
  version: string | null;
  /** Desktop targets the SDK has a Steam library for. */
  targets: DesktopTarget[];
  /** The folder (dir) or entry-name prefix (zip, e.g. "sdk/") that holds redistributable_bin/. */
  root: string;
}

export interface SteamSdk {
  /** A real folder holding redistributable_bin/<platform>/<library>. */
  dir: string;
  version: string | null;
  targets: DesktopTarget[];
  found: SdkFound;
}

export interface FindSdkOptions {
  projectDir: string;
  config: Config | null;
  env: NodeJS.ProcessEnv;
  cacheDir: string;
  /** From the `--steam-sdk` flag, which the CLI resolves against the current folder. */
  flagPath?: string;
}

const README_VERSION = /^v(\d+\.\d+)\b/m;
const SDK_ZIP_NAME = /^steamworks_sdk.*\.zip$/i;

function versionFromName(file: string): string | null {
  const m = path.basename(file).match(/steamworks_sdk_(\d)(\d{2})/i);
  return m ? `${m[1]}.${m[2]}` : null;
}

function versionFromReadme(text: string | null): string | null {
  return text?.match(README_VERSION)?.[1] ?? null;
}

/** Sort comparator: newest version first, unknown versions last. */
export function newestFirst(a: string | null, b: string | null): number {
  const pa = a ? a.split('.').map(Number) : [];
  const pb = b ? b.split('.').map(Number) : [];
  if (!pa.length || !pb.length) return pb.length - pa.length;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type Inspected = Omit<SdkFound, 'kind'>;

function inspectZip(file: string): Inspected | null {
  let zip: Buffer;
  let entries;
  try {
    zip = fs.readFileSync(file);
    entries = readZipEntries(zip);
  } catch {
    return null;
  }
  const byPrefix = new Map<string, DesktopTarget[]>();
  for (const entry of entries) {
    for (const target of SDK_TARGETS) {
      const suffix = `redistributable_bin/${SDK_LIBS[target]}`;
      if (entry.name !== suffix && !entry.name.endsWith(`/${suffix}`)) continue;
      const prefix = entry.name.slice(0, -suffix.length);
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), target]);
    }
  }
  const best = [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!best) return null;
  const [root, found] = best;
  const readme = entries.find((e) => e.name === `${root}Readme.txt`);
  let readmeText: string | null = null;
  try {
    readmeText = readme ? readZipEntry(zip, readme).toString('latin1') : null;
  } catch {
    readmeText = null;
  }
  return {
    path: file,
    format: 'zip',
    version: versionFromReadme(readmeText) ?? versionFromName(file),
    targets: SDK_TARGETS.filter((t) => found.includes(t)),
    root,
  };
}

function inspectDir(dir: string): Inspected | null {
  for (const root of [dir, path.join(dir, 'sdk')]) {
    const targets = SDK_TARGETS.filter((t) => fs.existsSync(path.join(root, 'redistributable_bin', ...SDK_LIBS[t].split('/'))));
    if (!targets.length) continue;
    const readme = path.join(root, 'Readme.txt');
    const text = fs.existsSync(readme) ? fs.readFileSync(readme, 'latin1') : null;
    return { path: dir, format: 'dir', version: versionFromReadme(text) ?? versionFromName(dir), targets, root };
  }
  return null;
}

function inspect(p: string): Inspected | null {
  if (!fs.existsSync(p)) return null;
  return fs.statSync(p).isDirectory() ? inspectDir(p) : inspectZip(p);
}

function invalid(label: string, p: string): GsFailure {
  return new GsFailure(
    'STEAM_SDK_INVALID',
    `${label} (${p}) isn't a usable Steamworks SDK: it has no redistributable_bin/ folder with Steam's libraries, or the zip is damaged.`,
    `Use the steamworks_sdk_<version>.zip you downloaded from ${SDK_DOWNLOAD_URL} (or its unzipped folder), or remove that setting.`,
  );
}

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Finds the user's Steamworks SDK without changing anything on disk. Gameshipper never ships
 * Valve's files itself. Order: --steam-sdk, steam.sdk, GAMESHIPPER_STEAM_SDK, the project's
 * .sdk/steamworks_sdk_*.zip (newest), the project's steamworks_sdk/ folder, then the newest SDK
 * already extracted into the cache. Returns null when there is none; throws STEAM_SDK_INVALID
 * when a path that should be an SDK isn't one. steam.sdk is relative to the project; the flag
 * and the environment variable are relative to the current folder, like any command-line path.
 */
export function findSteamSdk(opts: FindSdkOptions): SdkFound | null {
  const explicit: Array<[SdkSourceKind, string | null | undefined, string, string]> = [
    ['flag', opts.flagPath, '--steam-sdk', process.cwd()],
    ['config', opts.config?.steam.sdk, 'steam.sdk in gameshipper.json', opts.projectDir],
    ['env', opts.env.GAMESHIPPER_STEAM_SDK, 'GAMESHIPPER_STEAM_SDK', process.cwd()],
  ];
  for (const [kind, raw, label, base] of explicit) {
    if (!raw) continue;
    const p = path.resolve(base, raw);
    const found = inspect(p);
    if (!found) throw invalid(label, p);
    return { kind, ...found };
  }

  const sdkFolder = path.join(opts.projectDir, '.sdk');
  const zips = listNames(sdkFolder)
    .filter((n) => SDK_ZIP_NAME.test(n))
    .sort((a, b) => newestFirst(versionFromName(a), versionFromName(b)) || b.localeCompare(a));
  if (zips.length) {
    const zip = path.join(sdkFolder, zips[0]);
    const found = inspect(zip);
    if (!found) throw invalid(`.sdk/${zips[0]}`, zip);
    return { kind: 'project', ...found };
  }
  const projectDir = path.join(opts.projectDir, 'steamworks_sdk');
  if (fs.existsSync(projectDir)) {
    const found = inspect(projectDir);
    if (!found) throw invalid('The steamworks_sdk folder in your project', projectDir);
    return { kind: 'project', ...found };
  }

  const cacheRoot = path.join(opts.cacheDir, 'steamworks-sdk');
  const cached = listNames(cacheRoot)
    .filter((n) => !n.startsWith('.'))
    .map((n) => inspect(path.join(cacheRoot, n)))
    .filter((f): f is Inspected => f !== null)
    .sort((a, b) => newestFirst(a.version, b.version));
  return cached.length ? { kind: 'cache', ...cached[0] } : null;
}

/** The warning for builds and play runs without an SDK. They still work; window.steam just reports unavailable. */
export function sdkMissingWarning(detail?: string): GsError {
  return gsError(
    'STEAM_SDK_MISSING',
    detail ?? 'No Steamworks SDK found, so the game runs without Steam features (window.steam.isAvailable() resolves false).',
    `Download the Steamworks SDK zip from ${SDK_DOWNLOAD_URL} and put it in this project's .sdk/ folder (e.g. .sdk/steamworks_sdk_165.zip), or point --steam-sdk, steam.sdk in gameshipper.json or GAMESHIPPER_STEAM_SDK at it. Gameshipper doesn't ship Valve's files itself.`,
  );
}

/**
 * Makes the SDK's libraries available as real files. Folders are used in place; zips have just
 * their libraries (and Readme.txt) extracted once into <cache>/steamworks-sdk/<version>/.
 */
export function ensureSteamSdk(ctx: Ctx, found: SdkFound): SteamSdk {
  if (found.format === 'dir') return { dir: found.root, version: found.version, targets: found.targets, found };
  let zip: Buffer;
  try {
    zip = fs.readFileSync(found.path);
  } catch {
    throw invalid('The Steamworks SDK zip', found.path);
  }
  const key = found.version ?? `sha256-${createHash('sha256').update(zip).digest('hex').slice(0, 16)}`;
  const cacheRoot = path.join(ctx.cacheDir, 'steamworks-sdk');
  const dir = path.join(cacheRoot, key);
  const libFile = (base: string, target: DesktopTarget) => path.join(base, 'redistributable_bin', ...SDK_LIBS[target].split('/'));
  if (!found.targets.every((t) => fs.existsSync(libFile(dir, t)))) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(cacheRoot, '.extract-'));
    try {
      const entries = readZipEntries(zip);
      const wanted = new Map<string, string>(found.targets.map((t) => [`${found.root}redistributable_bin/${SDK_LIBS[t]}`, libFile(tmp, t)]));
      wanted.set(`${found.root}Readme.txt`, path.join(tmp, 'Readme.txt'));
      for (const entry of entries) {
        const dest = wanted.get(entry.name);
        if (!dest) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, readZipEntry(zip, entry));
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (e instanceof GsFailure) throw e;
      throw invalid('The Steamworks SDK zip', found.path);
    }
    ctx.log(`extracted Steamworks SDK ${key} libraries from ${found.path} → ${dir}`);
  }
  return { dir, version: found.version, targets: found.targets, found };
}
