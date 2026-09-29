import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { moveIntoCache } from '../cache.js';
import type { DesktopTarget } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { GsFailure } from '../result.js';
import { readTgz } from './tar.js';

const require = createRequire(import.meta.url);

/**
 * koffi (the FFI library steamworks-ffi-node uses) ships its native module as one npm package
 * per OS/CPU, and npm only installs the one for this computer. Builds for other OSes fetch the
 * others from the npm registry once, check them against these pinned hashes, and cache them.
 * Keep KOFFI_VERSION equal to the "koffi" version in package.json (a test checks this).
 */
export const KOFFI_VERSION = '3.3.2';
export const KOFFI_NATIVES: Record<string, string> = {
  'darwin-arm64': 'sha512-gQKOkA/4tkOxXP3hdau2MrvVvTYlKQiXd86hK+B2FKErV0QcwqrWt6DWZ3FtJUYGB1scenT0srS9VfsWmbgeMQ==',
  'darwin-x64': 'sha512-qxysFokAwiMLiWYYVhooWZHSV3REKJErsUjnX9IeG2rAVpWNkdcXUiQ2GMdfH3hZ0f2fuv0fTuv293/tYu1yew==',
  'linux-x64': 'sha512-78qO1oqd9GYfzcKOxIaRiN0KgvzQzgbPfdClf0/jErlWYdxnr8gB4i9KOFvsYMdnc7kTIa/wnubl1lPCiQnqvA==',
  'win32-x64': 'sha512-OWc6s6gziEabkQj+xc+ZNaf5g69hc/DQJLBcmbhxJAifAdXDgj9vB5d8hcjS2mTHjBeAIqQ4nkd9d/Jc7OUuHw==',
};

/** An OS/CPU the app runs on: a packaging job, or this computer for `play`. */
export interface NativeTarget {
  platform: string;
  /** 'universal' for a macOS universal build. */
  arch: string;
}

/** koffi native package ids ("<platform>-<arch>") an app for this target needs. */
export function nativeIds(t: NativeTarget): string[] {
  if (t.platform === 'darwin' && t.arch === 'universal') return ['darwin-arm64', 'darwin-x64'];
  return [`${t.platform}-${t.arch}`];
}

/** Which Steamworks library (see SDK_LIBS) an app for this platform needs. */
export function sdkTargetFor(platform: string): DesktopTarget | null {
  return ({ win32: 'windows', darwin: 'mac', linux: 'linux' } as Record<string, DesktopTarget>)[platform] ?? null;
}

/** The directory of the koffi package installed with Gameshipper. */
export function koffiDir(): string {
  // koffi's package.json "exports" hides package.json, but its main file sits in the package root.
  return path.dirname(require.resolve('koffi'));
}

/** The native package npm installed next to koffi, if it is for this id and version. */
export function installedKoffiNative(id: string): string | null {
  try {
    const fromKoffi = createRequire(path.join(koffiDir(), 'index.cjs'));
    const pkg = fromKoffi.resolve(`@koromix/koffi-${id}/package.json`);
    const { version } = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string };
    return version === KOFFI_VERSION ? path.dirname(pkg) : null;
  } catch {
    return null;
  }
}

export interface KoffiNativeOptions {
  /** npm registry base URL. Default: GAMESHIPPER_NPM_REGISTRY, npm_config_registry, then registry.npmjs.org. */
  registry?: string;
  /** Pinned integrity per id (tests replace it). */
  pins?: Record<string, string>;
  /** Finds an already-installed package (tests disable it). */
  installed?: (id: string) => string | null;
  /** Give up on the download after this many milliseconds (default 60 s). */
  timeoutMs?: number;
}

const KOFFI_DOWNLOAD_TIMEOUT_MS = 60_000;

function downloadFailed(id: string, reason: string): GsFailure {
  return new GsFailure(
    'STEAM_NATIVE_DOWNLOAD_FAILED',
    `Couldn't download @koromix/koffi-${id} ${KOFFI_VERSION}, which Steam support needs in the ${id} build: ${reason}`,
    `Check your internet connection and run the build again (it's cached after the first download). Or build only this computer's OS with --target.`,
  );
}

/** The native module inside a koffi package folder, e.g. <dir>/darwin_arm64/koffi.node. */
const koffiNode = (dir: string, id: string): string => path.join(dir, id.replace('-', '_'), 'koffi.node');

/** A path inside a package tarball that could write outside the package: absolute, or with a ".." part. */
function unsafeTarPath(name: string): boolean {
  return path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || name.split(/[\\/]/).includes('..');
}

/**
 * Returns a folder containing the @koromix/koffi-<id> package, downloading it into the cache if needed.
 * Only the pinned OS/CPUs are supported, even when npm installed another one here: Steam's Windows and
 * Linux libraries are x64 only, so an arm64 koffi could never load them.
 */
export async function ensureKoffiNative(ctx: Ctx, id: string, opts: KoffiNativeOptions = {}): Promise<string> {
  const integrity = (opts.pins ?? KOFFI_NATIVES)[id];
  if (!integrity) {
    throw new GsFailure(
      'STEAM_UNSUPPORTED_PLATFORM',
      `Steam features aren't available for ${id} builds.`,
      'Steam builds are supported for Windows x64, Linux x64 and macOS. Remove this target, or ignore Steam for it.',
    );
  }
  const cached = path.join(ctx.cacheDir, 'koffi', KOFFI_VERSION, id);
  const complete = (dir: string) => fs.existsSync(koffiNode(dir, id));
  if (complete(cached)) return cached;
  const installed = (opts.installed ?? installedKoffiNative)(id);
  if (installed) return installed;
  const registry = (opts.registry ?? process.env.GAMESHIPPER_NPM_REGISTRY ?? process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  const url = `${registry}/@koromix/koffi-${id}/-/koffi-${id}-${KOFFI_VERSION}.tgz`;
  ctx.log(`downloading ${url}`);
  let tgz: Buffer;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? KOFFI_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tgz = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    const err = e as Error & { cause?: { code?: unknown } };
    // fetch only says "fetch failed"; the cause says why (ENOTFOUND, ECONNREFUSED, ...).
    const why = typeof err.cause?.code === 'string' ? ` (${err.cause.code})` : '';
    throw downloadFailed(id, err.name === 'TimeoutError' ? 'the download timed out' : `${err.message}${why}`);
  }
  const actual = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  if (actual !== integrity) throw downloadFailed(id, `the file's checksum doesn't match (got ${actual})`);
  const parent = path.dirname(cached);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(parent, '.download-'));
  try {
    for (const [name, data] of readTgz(tgz)) {
      if (unsafeTarPath(name)) throw new Error(`the package has an unsafe path ${name}`);
      if (!name.startsWith('package/')) continue;
      const dest = path.join(tmp, ...name.slice('package/'.length).split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    moveIntoCache(tmp, cached, complete);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw downloadFailed(id, (e as Error).message);
  }
  return cached;
}

const SDK_DIRS: Record<DesktopTarget, string> = { windows: 'win64', mac: 'osx', linux: 'linux64' };

/**
 * The @electron/packager `ignore` function for one job. The assembled app holds native files for
 * every target being built; each package keeps only its own OS's. Nothing else is left out: staging
 * already decided what ships, and packager's own ignore list would drop game files such as .obj models.
 * `appPath` looks like "/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node" (relative to the
 * app, leading slash).
 */
export function packageIgnore(job: NativeTarget): (appPath: string) => boolean {
  const ids = nativeIds(job);
  const sdkTarget = sdkTargetFor(job.platform);
  return (appPath) => {
    const koffi = appPath.match(/^\/node_modules\/@koromix\/koffi-([^/]+)/);
    if (koffi) return !ids.includes(koffi[1]);
    const prebuild = appPath.match(/^\/node_modules\/steamworks-ffi-node\/prebuilds\/([^/]+)/);
    if (prebuild) return !ids.includes(prebuild[1]);
    const sdk = appPath.match(/^\/steamworks_sdk\/redistributable_bin\/([^/]+)/);
    if (sdk) return sdkTarget === null || sdk[1] !== SDK_DIRS[sdkTarget];
    return false;
  };
}
