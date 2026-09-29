import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DesktopTarget } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { GsFailure, type GsError } from '../result.js';
import { ensureKoffiNative, koffiDir, nativeIds, sdkTargetFor, type KoffiNativeOptions, type NativeTarget } from './natives.js';
import { SDK_LIBS, sdkMissingWarning, type SteamSdk } from './sdk.js';

const require = createRequire(import.meta.url);

/** Package folders (top level only) and files that are never needed at runtime. */
const SKIP_DIRS = new Set(['doc', 'docs', 'lib', 'native', 'scripts', 'test', 'tests', 'vendor']);
const SKIP_FILES = /(\.map|\.md|\.d\.ts|\.cc|\.hh|\.h|\.c|\.inc|\.S|\.asm|\.def|\.lib|^CMakeLists\.txt|^cnoke\.cjs|^postinstall\.js|^verify-sdk-setup\.js)$/;

/** Copies an npm package's runtime files: JavaScript, native modules, package.json and licenses. */
export function copyRuntimePackage(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      if (rel === '') return true;
      if (fs.statSync(p).isDirectory()) return rel.includes(path.sep) || !SKIP_DIRS.has(rel);
      return !SKIP_FILES.test(path.basename(p));
    },
  });
}

export interface SteamBundle {
  /** False when the app has no Steam support (no SDK, or an OS Steam builds don't support). */
  included: boolean;
  /** Desktop targets whose Steam library is in the app. */
  targets: DesktopTarget[];
  warnings: GsError[];
}

/**
 * Adds Steam support to an assembled app folder:
 *   node_modules/steamworks-ffi-node, node_modules/koffi, node_modules/@koromix/koffi-<os>-<cpu>
 *   steamworks_sdk/redistributable_bin/<os>/<library>   (from the user's own SDK)
 * `natives` lists every OS/CPU the app will be packaged for; packageIgnore() later drops the
 * other OSes' files from each package. Nothing is added without an SDK.
 */
export async function bundleSteam(
  ctx: Ctx,
  appDir: string,
  sdk: SteamSdk | null,
  natives: NativeTarget[],
  opts: KoffiNativeOptions = {},
): Promise<SteamBundle> {
  const none: SteamBundle = { included: false, targets: [], warnings: [] };
  if (!sdk || natives.length === 0) return none;
  const warnings: GsError[] = [];
  const ids = new Set<string>();
  const targets = new Set<DesktopTarget>();
  const unsupported = new Set<DesktopTarget>();
  for (const native of natives) {
    const target = sdkTargetFor(native.platform);
    if (!target) continue;
    if (!sdk.targets.includes(target)) {
      // One warning per target, however many OS/CPU builds it has.
      if (unsupported.has(target)) continue;
      unsupported.add(target);
      warnings.push(
        sdkMissingWarning(
          `The Steamworks SDK at ${sdk.found.path} has no ${target} library (redistributable_bin/${SDK_LIBS[target]}), so the ${target} build has no Steam features.`,
        ),
      );
      continue;
    }
    targets.add(target);
    for (const id of nativeIds(native)) ids.add(id);
  }
  if (targets.size === 0) return { ...none, warnings };

  // ensureKoffiNative refuses any OS/CPU without a pinned package (such as arm64 Linux and Windows, which
  // Steam has no libraries for) before it looks at the one npm installed here.
  const nativeDirs = new Map<string, string>();
  for (const id of ids) {
    try {
      nativeDirs.set(id, await ensureKoffiNative(ctx, id, opts));
    } catch (e) {
      if (e instanceof GsFailure && e.error.code === 'STEAM_UNSUPPORTED_PLATFORM') return { ...none, warnings: [...warnings, e.error] };
      throw e;
    }
  }

  const modules = path.join(appDir, 'node_modules');
  copyRuntimePackage(path.dirname(require.resolve('steamworks-ffi-node/package.json')), path.join(modules, 'steamworks-ffi-node'));
  copyRuntimePackage(koffiDir(), path.join(modules, 'koffi'));
  for (const [id, dir] of nativeDirs) copyRuntimePackage(dir, path.join(modules, '@koromix', `koffi-${id}`));
  for (const target of targets) {
    const rel = ['redistributable_bin', ...SDK_LIBS[target].split('/')];
    const dest = path.join(appDir, 'steamworks_sdk', ...rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(sdk.dir, ...rel), dest);
  }
  ctx.log(`bundled Steam support (SDK ${sdk.version ?? 'unknown version'}) for ${[...targets].join(', ')}`);
  return { included: true, targets: [...targets], warnings };
}
