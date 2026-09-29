import * as fs from 'node:fs';
import { isBuiltin } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimePlugin } from '../shell/runtime-config.js';
import type { Config, DesktopTarget } from './config/schema.js';
import type { Ctx } from './context.js';
import { findJsSpecifiers } from './prepare/rewrite-js.js';
import { holdsSteamworksSdk, isSkippedAnywhere, isWithin, loopsBack, realOrSelf } from './prepare/stage.js';
import { GsFailure, gsError, type GsError } from './result.js';

export interface PluginHookContext {
  projectDir: string;
  /** The assembled Electron app folder (.gameshipper/app) that every target is packaged from. */
  appDir: string;
  config: Config;
  log(message: string): void;
}

export interface BeforePackageContext extends PluginHookContext {
  /** The desktop targets about to be packaged. */
  targets: DesktopTarget[];
}

export interface AfterPackageContext extends PluginHookContext {
  target: DesktopTarget;
  /** out/<target> */
  outDir: string;
  executable: string;
}

/** The whole v1 plugin API (spec §7.6): a module whose default export looks like this. */
export interface GameshipperPlugin {
  name: string;
  /** Functions the game calls as gameshipper.plugins.<name>.<fn>(...args); they run in Electron's main process. */
  main?: Record<string, unknown>;
  beforePackage?(ctx: BeforePackageContext): unknown;
  afterPackage?(ctx: AfterPackageContext): unknown;
}

export interface LoadedPlugin {
  name: string;
  /** As written in gameshipper.json "plugins". */
  spec: string;
  /** The file or folder the spec points to. */
  source: string;
  /** The module file that was imported. */
  entryFile: string;
  /** Names of the functions in `main`. */
  functions: string[];
  plugin: GameshipperPlugin;
  /** Problems that don't stop the build (PLUGIN_IMPORTS_NOT_COPIED). */
  warnings: GsError[];
}

/** Plugin and function names: usable as gameshipper.plugins.<name>.<fn>. */
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function loadFailed(spec: string, reason: string): GsFailure {
  return new GsFailure(
    'PLUGIN_LOAD_FAILED',
    `Plugin ${spec} couldn't be loaded: ${reason}`,
    'Fix the plugin (its default export must be { name, main?, beforePackage?, afterPackage? }), or remove it from "plugins" in gameshipper.json.',
  );
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A package.json's fields, or {} when there is none. Throws when it isn't valid JSON. */
function readPackageJson(file: string): { main?: unknown; type?: unknown } {
  return fs.existsSync(file) ? ((JSON.parse(fs.readFileSync(file, 'utf8')) as { main?: unknown; type?: unknown } | null) ?? {}) : {};
}

/** The module file a plugin spec points to. A folder plugin's entry must be inside the folder: only the folder is packaged. */
function entryFor(spec: string, source: string): string {
  if (!fs.statSync(source).isDirectory()) return source;
  let main: unknown;
  try {
    ({ main } = readPackageJson(path.join(source, 'package.json')));
  } catch (e) {
    throw loadFailed(spec, `its package.json can't be read: ${message(e)}`);
  }
  if (typeof main !== 'string') {
    const index = ['index.mjs', 'index.js', 'index.cjs'].map((n) => path.join(source, n)).find((f) => fs.existsSync(f));
    if (!index) throw loadFailed(spec, 'the folder has no package.json "main", index.mjs, index.js or index.cjs.');
    return index;
  }
  const entry = path.resolve(source, main);
  const outside = (): GsFailure =>
    loadFailed(spec, `its package.json "main" (${main}) is outside the plugin folder, and only the folder is packaged. Move that file into the folder.`);
  if (!isWithin(entry, source)) throw outside();
  if (!fs.existsSync(entry)) throw loadFailed(spec, `its package.json "main" (${main}) doesn't exist.`);
  // A link to a file elsewhere is outside the folder too.
  if (!isWithin(realOrSelf(entry), realOrSelf(source))) throw outside();
  // The copy (copyPluginFolder) must not leave the main file out.
  const parts = path.relative(source, entry).split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    if (!leftOutOfPlugin(parts.slice(0, i), path.join(source, ...parts.slice(0, i)))) continue;
    const rel = parts.join('/');
    throw loadFailed(
      spec,
      i < parts.length
        ? `the plugin's main file is in a folder that isn't packaged (${parts.slice(0, i).join('/')}), so the app couldn't load it. Move ${rel} elsewhere in the folder and update package.json "main".`
        : `the plugin's main file (${rel}) isn't packaged: files named like that never are. Rename it and update package.json "main".`,
    );
  }
  return entry;
}

/** CommonJS require('...') calls, which es-module-lexer doesn't report. */
const REQUIRE_CALL = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
/** node:, data:, file: and other URL schemes: never a file next to the plugin or a package. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * What a single-file plugin loads besides Node's built-in modules and Electron: other files (./x.js) and
 * packages (lodash). Only the plugin file itself is copied into the app, so those are missing there.
 */
async function importsNotCopied(file: string): Promise<string[]> {
  let code: string;
  try {
    code = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const specifiers = [...code.matchAll(REQUIRE_CALL)].map((m) => m[2]);
  try {
    specifiers.push(...(await findJsSpecifiers(code)).map((s) => s.specifier));
  } catch {
    // Not parseable as a module (CommonJS can be); the require() calls above still count.
  }
  const always = (s: string) => s === 'electron' || s.startsWith('electron/') || isBuiltin(s) || URL_SCHEME.test(s);
  return [...new Set(specifiers.filter((s) => !always(s)))];
}

/**
 * Imports and checks every plugin listed in gameshipper.json, in order. Throws PLUGIN_LOAD_FAILED.
 * Each import asks for the file as it is now (the URL carries its modification time), so a long-running
 * process sees a plugin's latest code. Only the plugin's own file is reloaded, not the files it imports.
 */
export async function loadPlugins(ctx: Ctx, config: Config): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const spec of config.plugins) {
    const source = path.resolve(ctx.projectDir, spec);
    if (!fs.existsSync(source)) throw loadFailed(spec, `${source} doesn't exist.`);
    const entryFile = entryFor(spec, source);
    let mod: { default?: unknown };
    try {
      mod = (await import(`${pathToFileURL(entryFile).href}?v=${fs.statSync(entryFile).mtimeMs}`)) as { default?: unknown };
    } catch (e) {
      throw loadFailed(spec, message(e));
    }
    const plugin = mod.default as GameshipperPlugin | undefined;
    if (!plugin || typeof plugin !== 'object') throw loadFailed(spec, 'it has no default export object.');
    if (typeof plugin.name !== 'string' || !NAME.test(plugin.name)) {
      throw loadFailed(spec, `"name" must be letters, digits and _, starting with a letter (like "myplugin"); got ${JSON.stringify(plugin.name)}.`);
    }
    // gameshipper.plugins.<name> must be the plugin's own, never a property every object has.
    if (Object.hasOwn(Object.prototype, plugin.name)) {
      throw loadFailed(spec, `"${plugin.name}" can't be a plugin name: every JavaScript object already has it. Pick another name.`);
    }
    // Plugins are copied to plugins/<name>/, and Windows and macOS don't tell "Echo" from "echo".
    const clash = loaded.find((p) => p.name.toLowerCase() === plugin.name.toLowerCase());
    if (clash) {
      throw loadFailed(
        spec,
        clash.name === plugin.name
          ? `another plugin is already named "${plugin.name}".`
          : `another plugin is named "${clash.name}", which differs only in letter case. Give one of them another name.`,
      );
    }
    if (plugin.main !== undefined && (typeof plugin.main !== 'object' || plugin.main === null)) throw loadFailed(spec, '"main" must be an object of functions.');
    for (const hook of ['beforePackage', 'afterPackage'] as const) {
      if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function') throw loadFailed(spec, `"${hook}" must be a function.`);
    }
    const main = plugin.main ?? {};
    const functions = Object.keys(main).filter((k) => typeof main[k] === 'function');
    const badName = functions.find((f) => !NAME.test(f));
    if (badName) throw loadFailed(spec, `main.${badName} needs a plain name (letters, digits and _, starting with a letter).`);
    const warnings: GsError[] = [];
    const imports = entryFile === source ? await importsNotCopied(entryFile) : [];
    if (imports.length) {
      warnings.push(
        gsError(
          'PLUGIN_IMPORTS_NOT_COPIED',
          `Plugin ${plugin.name} (${spec}) loads ${imports.join(', ')}, but only the plugin file is packaged, so it may fail to load in the game.`,
          'Bundle it into one file (with esbuild, say) or make it a folder plugin: a folder with a package.json "main" or an index.mjs is copied whole.',
        ),
      );
    }
    loaded.push({ name: plugin.name, spec, source, entryFile, functions, plugin, warnings });
    ctx.log(`loaded plugin ${plugin.name} from ${entryFile} (game functions: ${functions.join(', ') || 'none'})`);
  }
  return loaded;
}

/** "module" or "commonjs": how Node treats a .js file at `file`, from the nearest package.json. */
function moduleTypeAt(file: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) return readPackageJson(pkg).type === 'module' ? 'module' : 'commonjs';
    if (dir === path.dirname(dir)) return 'commonjs';
  }
}

/**
 * Whether a folder plugin's copy leaves out the entry at `parts` (its path inside the plugin folder; `abs`
 * is the full path), by staging's rules: .env files, steam_appid.txt, the Steamworks SDK and .git anywhere;
 * every dot entry (.npmrc, .vscode, .sdk, .gameshipper...) and out/ at the top; node_modules/.bin.
 */
function leftOutOfPlugin(parts: string[], abs: string): boolean {
  const name = parts[parts.length - 1];
  if (isSkippedAnywhere(name)) return true;
  if (parts.length === 1 && (name.startsWith('.') || name === 'out')) return true;
  if (name === '.bin' && parts[parts.length - 2] === 'node_modules') return true;
  return holdsSteamworksSdk(abs);
}

/**
 * Copies a folder plugin by staging's rules (see leftOutOfPlugin). Links are copied as the files they
 * point to, but only within the plugin folder: a link out of it (to ~/.ssh, say), to nothing, or into a
 * loop fails the build instead.
 */
function copyPluginFolder(p: LoadedPlugin, dest: string): void {
  const root = fs.realpathSync(p.source);
  const filter = (src: string): boolean => {
    const rel = path.relative(p.source, src);
    if (rel === '') return true;
    if (leftOutOfPlugin(rel.split(path.sep), src)) return false;
    if (!fs.lstatSync(src).isSymbolicLink()) return true;
    let target: string;
    try {
      target = fs.realpathSync(src);
    } catch {
      throw loadFailed(p.spec, `${rel} links to something that doesn't exist. Remove the link or point it at a real file.`);
    }
    // A link with a harmless name can still point at a secret (settings.txt -> .env).
    if (isSkippedAnywhere(path.basename(target))) return false;
    if (!isWithin(target, root)) {
      throw loadFailed(p.spec, `${rel} links outside the plugin folder (to ${target}), so it isn't packaged. Replace the link with a copy.`);
    }
    if (fs.statSync(target).isDirectory() && loopsBack(src, target, p.source)) {
      throw loadFailed(p.spec, `${rel} links to a folder that contains it. Remove the link.`);
    }
    return true;
  };
  fs.cpSync(p.source, dest, { recursive: true, dereference: true, filter });
}

/**
 * Copies each plugin into <app>/plugins/<name>/ and describes it for the shell. A plugin is one
 * file, or a folder copied whole (for plugins that import other files or have node_modules).
 * The copy keeps the module type (ESM/CommonJS) the plugin had in the project. Throws PLUGIN_LOAD_FAILED.
 */
export function copyPlugins(appDir: string, plugins: LoadedPlugin[]): RuntimePlugin[] {
  return plugins.map((p) => {
    const dest = path.join(appDir, 'plugins', p.name);
    const isDir = fs.statSync(p.source).isDirectory();
    try {
      if (isDir) {
        copyPluginFolder(p, dest);
      } else {
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(p.source, path.join(dest, path.basename(p.source)));
      }
      if (!fs.existsSync(path.join(dest, 'package.json'))) {
        fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify({ type: moduleTypeAt(p.entryFile) })}\n`);
      }
    } catch (e) {
      if (e instanceof GsFailure) throw e;
      // ERR_FS_CP_EINVAL (a plugin folder that holds the app), ELOOP, a full disk...
      throw loadFailed(p.spec, `it couldn't be copied into the app: ${message(e)}`);
    }
    const entryRel = isDir ? path.relative(p.source, p.entryFile) : path.basename(p.source);
    return { name: p.name, entry: ['plugins', p.name, ...entryRel.split(path.sep)].join('/'), functions: p.functions };
  });
}

/** How long a build hook may run before the build gives up on it. */
export const PLUGIN_HOOK_TIMEOUT_MS = 5 * 60_000;

export interface HookOptions {
  /** Default PLUGIN_HOOK_TIMEOUT_MS. */
  timeoutMs?: number;
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    const n = Math.round(ms / 60_000);
    return `${n} minute${n === 1 ? '' : 's'}`;
  }
  return ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} ms`;
}

export async function runPluginHook(plugins: LoadedPlugin[], hook: 'beforePackage', hookCtx: BeforePackageContext, opts?: HookOptions): Promise<void>;
export async function runPluginHook(plugins: LoadedPlugin[], hook: 'afterPackage', hookCtx: AfterPackageContext, opts?: HookOptions): Promise<void>;
/** Runs one build hook of every plugin, in order. Throws PLUGIN_HOOK_FAILED, also when a hook runs past its timeout. */
export async function runPluginHook(
  plugins: LoadedPlugin[],
  hook: 'beforePackage' | 'afterPackage',
  hookCtx: PluginHookContext,
  opts: HookOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? PLUGIN_HOOK_TIMEOUT_MS;
  for (const p of plugins) {
    const fn = p.plugin[hook] as ((ctx: PluginHookContext) => unknown) | undefined;
    if (!fn) continue;
    const timedOut = Symbol('timed out');
    let timer: NodeJS.Timeout | undefined;
    let outcome: unknown;
    try {
      outcome = await Promise.race([
        (async () => fn.call(p.plugin, { ...hookCtx, log: (line: string) => hookCtx.log(`[plugin ${p.name}] ${line}`) }))(),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
    } catch (e) {
      throw new GsFailure(
        'PLUGIN_HOOK_FAILED',
        `Plugin ${p.name}'s ${hook} failed: ${message(e)}`,
        `Fix ${hook} in ${p.entryFile}, or remove the plugin from "plugins" in gameshipper.json.`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (outcome === timedOut) {
      throw new GsFailure(
        'PLUGIN_HOOK_FAILED',
        `Plugin ${p.name}'s ${hook} timed out: it was still running after ${formatDuration(timeoutMs)}.`,
        `Make ${hook} in ${p.entryFile} finish (await its work, and don't wait for something that never comes), or remove the plugin from "plugins" in gameshipper.json.`,
      );
    }
  }
}
