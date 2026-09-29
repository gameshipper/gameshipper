import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPluginHost } from '../../src/shell/plugins-runtime.js';

/** The frame the game's calls come from. */
const GAME = 'app://game/index.html';

const plugins = [
  { name: 'echo', entry: 'plugins/echo/echo.mjs', functions: ['shout'] },
  { name: 'broken', entry: 'plugins/broken/index.mjs', functions: ['go'] },
];

function host() {
  const urls: string[] = [];
  const errors: string[] = [];
  const importModule = async (url: string) => {
    urls.push(url);
    if (url.includes('broken')) throw new Error('Unexpected token');
    return { default: { name: 'echo', main: { shout: async (s: string) => `${s}!`, secret: () => 'no' } } };
  };
  return { urls, errors, host: createPluginHost('/app', plugins, importModule, (p, m) => errors.push(`${p}: ${m}`)) };
}

describe('createPluginHost', () => {
  it('lists the callable functions and runs them', async () => {
    const { host: h, urls } = host();
    expect(h.manifest()).toEqual({ echo: ['shout'], broken: ['go'] });
    expect(await h.call(GAME, 'echo', 'shout', ['hi'])).toBe('hi!');
    expect(urls[0]).toBe(pathToFileURL(path.join('/app', 'plugins', 'echo', 'echo.mjs')).href);
  });

  it('refuses functions that are not listed', async () => {
    const { host: h } = host();
    await expect(h.call(GAME, 'echo', 'secret', [])).rejects.toThrow('Unknown plugin function: echo.secret');
    await expect(h.call(GAME, 'nope', 'shout', [])).rejects.toThrow('Unknown plugin function');
    await expect(h.call(GAME, 'echo', '__proto__', [])).rejects.toThrow('Unknown plugin function');
  });

  it("runs only the plugin's own functions, never inherited ones", async () => {
    const inherited = [{ name: 'proto', entry: 'plugins/proto/index.mjs', functions: ['toString', 'hasOwnProperty'] }];
    const h = createPluginHost('/app', inherited, async () => ({ default: { name: 'proto', main: {} } }), () => {});
    await expect(h.call(GAME, 'proto', 'toString', [])).rejects.toThrow('Plugin proto has no function toString.');
    await expect(h.call(GAME, 'proto', 'hasOwnProperty', ['x'])).rejects.toThrow('has no function hasOwnProperty');
    await expect(h.call(GAME, 'constructor', 'name', [])).rejects.toThrow('Unknown plugin function');
  });

  it('answers only the game itself', async () => {
    const { host: h } = host();
    await expect(h.call('https://example.com/', 'echo', 'shout', ['hi'])).rejects.toThrow('Plugins are only available to the game (app://game/).');
    await expect(h.call(undefined, 'echo', 'shout', ['hi'])).rejects.toThrow('only available to the game');
  });

  it('reports a plugin that fails to load, once, and rejects its calls', async () => {
    const { host: h, errors } = host();
    await expect(h.call(GAME, 'broken', 'go', [])).rejects.toThrow('Plugin broken failed to load');
    expect(errors).toEqual(['broken: Unexpected token']);
  });
});
