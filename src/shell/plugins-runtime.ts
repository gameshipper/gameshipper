import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGameUrl } from './policy.js';
import type { RuntimePlugin } from './runtime-config.js';

export interface PluginHost {
  /** { pluginName: [functionName, ...] }, for the preload to build gameshipper.plugins. */
  manifest(): Record<string, string[]>;
  /** Runs an allowed plugin function with the game's arguments. `senderUrl` must be one of the game's pages. */
  call(senderUrl: string | null | undefined, name: unknown, fn: unknown, args: unknown): Promise<unknown>;
}

type Main = Record<string, unknown>;

/**
 * Loads each plugin's module in Electron's main process (right away, in the background) and
 * lets the game call only the `main` functions listed in the app's config.
 */
export function createPluginHost(
  appRoot: string,
  plugins: RuntimePlugin[],
  importModule: (url: string) => Promise<unknown>,
  onLoadError: (plugin: string, message: string) => void,
): PluginHost {
  const byName = new Map(plugins.map((p) => [p.name, p]));
  const loading = new Map<string, Promise<Main | null>>();
  for (const p of plugins) {
    const url = pathToFileURL(path.join(appRoot, ...p.entry.split('/'))).href;
    loading.set(
      p.name,
      importModule(url).then(
        (mod) => ((mod as { default?: { main?: Main } }).default?.main ?? {}) as Main,
        (e: unknown) => {
          onLoadError(p.name, e instanceof Error ? e.message : String(e));
          return null;
        },
      ),
    );
  }
  return {
    manifest: () => Object.fromEntries(plugins.map((p) => [p.name, [...p.functions]])),
    async call(senderUrl, name, fn, args) {
      if (!isGameUrl(senderUrl)) throw new Error('Plugins are only available to the game (app://game/).');
      const plugin = typeof name === 'string' ? byName.get(name) : undefined;
      if (!plugin || typeof fn !== 'string' || !plugin.functions.includes(fn)) {
        throw new Error(`Unknown plugin function: ${String(name)}.${String(fn)}`);
      }
      const main = await loading.get(plugin.name);
      if (!main) throw new Error(`Plugin ${plugin.name} failed to load; see the events log.`);
      const f = main[fn];
      if (typeof f !== 'function') throw new Error(`Plugin ${plugin.name} has no function ${fn}.`);
      return f.apply(main, Array.isArray(args) ? args : []);
    },
  };
}
