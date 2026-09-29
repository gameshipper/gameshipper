import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimePlugin } from '../shell/runtime-config.js';
import type { Config, DesktopTarget } from './config/schema.js';
import type { Ctx } from './context.js';
import { GsFailure } from './result.js';

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

function entryFor(source: string): string | null {
  if (!fs.statSync(source).isDirectory()) return source;
  const { main } = readPackageJson(path.join(source, 'package.json'));
  if (typeof main === 'string') return path.join(source, main);
  return ['index.mjs', 'index.js', 'index.cjs'].map((n) => path.join(source, n)).find((f) => fs.existsSync(f)) ?? null;
}

/** Imports and checks every plugin listed in gameshipper.json, in order. Throws PLUGIN_LOAD_FAILED. */
export async function loadPlugins(ctx: Ctx, config: Config): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  for (const spec of config.plugins) {
    const source = path.resolve(ctx.projectDir, spec);
    if (!fs.existsSync(source)) throw loadFailed(spec, `${source} doesn't exist.`);
    let entryFile: string | null;
    try {
      entryFile = entryFor(source);
    } catch (e) {
      throw loadFailed(spec, `its package.json can't be read: ${message(e)}`);
    }
    if (!entryFile || !fs.existsSync(entryFile)) throw loadFailed(spec, 'the folder has no package.json "main", index.mjs, index.js or index.cjs.');
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(entryFile).href)) as { default?: unknown };
    } catch (e) {
      throw loadFailed(spec, message(e));
    }
    const plugin = mod.default as GameshipperPlugin | undefined;
    if (!plugin || typeof plugin !== 'object') throw loadFailed(spec, 'it has no default export object.');
    if (typeof plugin.name !== 'string' || !NAME.test(plugin.name)) {
      throw loadFailed(spec, `"name" must be letters, digits and _, starting with a letter (like "myplugin"); got ${JSON.stringify(plugin.name)}.`);
    }
    if (loaded.some((p) => p.name === plugin.name)) throw loadFailed(spec, `another plugin is already named "${plugin.name}".`);
    if (plugin.main !== undefined && (typeof plugin.main !== 'object' || plugin.main === null)) throw loadFailed(spec, '"main" must be an object of functions.');
    for (const hook of ['beforePackage', 'afterPackage'] as const) {
      if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function') throw loadFailed(spec, `"${hook}" must be a function.`);
    }
    const main = plugin.main ?? {};
    const functions = Object.keys(main).filter((k) => typeof main[k] === 'function');
    const badName = functions.find((f) => !NAME.test(f));
    if (badName) throw loadFailed(spec, `main.${badName} needs a plain name (letters, digits and _, starting with a letter).`);
    loaded.push({ name: plugin.name, spec, source, entryFile, functions, plugin });
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
 * Copies each plugin into <app>/plugins/<name>/ and describes it for the shell. A plugin is one
 * file, or a folder copied whole (for plugins that import other files or have node_modules).
 * The copy keeps the module type (ESM/CommonJS) the plugin had in the project.
 */
export function copyPlugins(appDir: string, plugins: LoadedPlugin[]): RuntimePlugin[] {
  return plugins.map((p) => {
    const dest = path.join(appDir, 'plugins', p.name);
    const isDir = fs.statSync(p.source).isDirectory();
    if (isDir) {
      fs.cpSync(p.source, dest, { recursive: true, dereference: true, filter: (src) => path.basename(src) !== '.git' });
    } else {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(p.source, path.join(dest, path.basename(p.source)));
    }
    if (!fs.existsSync(path.join(dest, 'package.json'))) {
      fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify({ type: moduleTypeAt(p.entryFile) })}\n`);
    }
    const entryRel = isDir ? path.relative(p.source, p.entryFile) : path.basename(p.source);
    return { name: p.name, entry: ['plugins', p.name, ...entryRel.split(path.sep)].join('/'), functions: p.functions };
  });
}

export async function runPluginHook(plugins: LoadedPlugin[], hook: 'beforePackage', hookCtx: BeforePackageContext): Promise<void>;
export async function runPluginHook(plugins: LoadedPlugin[], hook: 'afterPackage', hookCtx: AfterPackageContext): Promise<void>;
/** Runs one build hook of every plugin, in order. Throws PLUGIN_HOOK_FAILED. */
export async function runPluginHook(plugins: LoadedPlugin[], hook: 'beforePackage' | 'afterPackage', hookCtx: PluginHookContext): Promise<void> {
  for (const p of plugins) {
    const fn = p.plugin[hook] as ((ctx: PluginHookContext) => unknown) | undefined;
    if (!fn) continue;
    try {
      await fn.call(p.plugin, { ...hookCtx, log: (message: string) => hookCtx.log(`[plugin ${p.name}] ${message}`) });
    } catch (e) {
      throw new GsFailure(
        'PLUGIN_HOOK_FAILED',
        `Plugin ${p.name}'s ${hook} failed: ${message(e)}`,
        `Fix ${hook} in ${p.entryFile}, or remove the plugin from "plugins" in gameshipper.json.`,
      );
    }
  }
}
