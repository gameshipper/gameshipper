import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { injectShim, MOBILE_SHIM_JS, SHIM_TAG, VIEWPORT_TAG } from '../../../src/core/mobile/shim.js';

type Saves = { save(s: unknown, d?: unknown): Promise<void>; load(s: string): Promise<unknown>; list(): Promise<string[]>; delete(s: string): Promise<void> };
type Win = { gameshipper?: { version: number; saves: Saves; plugins: object } | string; steam?: unknown; Capacitor?: unknown; localStorage?: unknown };

/** Runs the shim in a fresh context with a fake Capacitor bridge (or, without one, localStorage) backed by a Map. */
function runShim(withCapacitor: boolean): { win: Win; calls: string[]; store: Map<string, string> } {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const nativePromise = async (plugin: string, method: string, opts: { key?: string; value?: string }) => {
    calls.push(`${plugin}.${method}`);
    if (method === 'set') store.set(opts.key!, opts.value!);
    if (method === 'get') return { value: store.get(opts.key!) ?? null };
    if (method === 'remove') store.delete(opts.key!);
    if (method === 'keys') return { keys: [...store.keys()] };
    return undefined;
  };
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  const win: Win = withCapacitor ? { Capacitor: { nativePromise, isNativePlatform: () => true } } : { localStorage };
  vm.runInNewContext(MOBILE_SHIM_JS, { window: win });
  return { win, calls, store };
}

const savesOf = (win: Win) => (win.gameshipper as { saves: Saves }).saves;

describe('mobile shim', () => {
  it('saves through Capacitor Preferences and leaves window.steam undefined', async () => {
    const { win, calls, store } = runShim(true);
    const saves = savesOf(win);
    await saves.save('slot1', { level: 3 });
    await saves.save('auto-2', [1]);
    store.set('someone-else', 'x');
    expect(await saves.load('slot1')).toEqual({ level: 3 });
    expect(await saves.load('missing')).toBeNull();
    expect(await saves.list()).toEqual(['auto-2', 'slot1']);
    await saves.delete('slot1');
    expect(await saves.list()).toEqual(['auto-2']);
    expect(store.get('gameshipper.saves.auto-2')).toBe('[1]');
    expect(calls).toContain('Preferences.set');
    expect(win.steam).toBeUndefined();
  });

  it('has the desktop API: version 1 and plugins (none run on phones)', () => {
    const { win } = runShim(true);
    expect(win.gameshipper).toMatchObject({ version: 1, plugins: {} });
    expect(Object.keys(win.gameshipper as object)).toEqual(['version', 'saves', 'plugins']);
  });

  it('is an ordinary global a game can replace, like the desktop one', () => {
    const { win } = runShim(true);
    expect(Object.getOwnPropertyDescriptor(win, 'gameshipper')).toMatchObject({ writable: true, configurable: true, enumerable: true });
    win.gameshipper = 'replaced';
    expect(win.gameshipper).toBe('replaced');
  });

  it('list() only returns valid slot names, like the desktop saves', async () => {
    for (const withCapacitor of [true, false]) {
      const { win, store } = runShim(withCapacitor);
      await savesOf(win).save('slot1', 1);
      for (const bad of ['', '../evil', 'has space', 'x'.repeat(65), 'dots.in.name']) store.set(`gameshipper.saves.${bad}`, '1');
      expect(await savesOf(win).list(), String(withCapacitor)).toEqual(['slot1']);
    }
  });

  it('rejects bad slot names and data like the desktop saves do', async () => {
    const saves = savesOf(runShim(true).win);
    await expect(saves.save('../evil', 1)).rejects.toMatchObject({ message: expect.stringMatching(/save slot/i) });
    await expect(saves.save('ok', undefined)).rejects.toMatchObject({ message: expect.stringContaining('JSON') });
  });

  it('falls back to localStorage outside a Capacitor app', async () => {
    const { win, store } = runShim(false);
    await savesOf(win).save('s', { a: 1 });
    store.set('other', '1');
    expect(store.get('gameshipper.saves.s')).toBe('{"a":1}');
    expect(await savesOf(win).list()).toEqual(['s']);
  });

  it('finds the Capacitor bridge when it arrives after the script ran', async () => {
    const { win, store } = runShim(false);
    const calls: string[] = [];
    win.Capacitor = { isNativePlatform: () => true, nativePromise: async (p: string, m: string) => void calls.push(`${p}.${m}`) };
    await savesOf(win).save('late', 1);
    expect(calls).toEqual(['Preferences.set']);
    expect(store.has('gameshipper.saves.late')).toBe(false);
  });
});

describe('injectShim', () => {
  const VP = '<meta name="viewport" content="width=device-width">';

  it('puts the script first in <head> and keeps an existing viewport', () => {
    expect(injectShim(`<!DOCTYPE html><html><head>${VP}<title>x</title></head><body></body></html>`)).toBe(
      `<!DOCTYPE html><html><head>${SHIM_TAG}${VP}<title>x</title></head><body></body></html>`,
    );
  });

  it('adds a mobile viewport when the page has none', () => {
    expect(injectShim('<html><head><title>x</title></head></html>')).toBe(`<html><head>${VIEWPORT_TAG}${SHIM_TAG}<title>x</title></head></html>`);
  });

  it('handles pages without <head> or <html>', () => {
    expect(injectShim(`<!doctype html>\n${VP}<script src="a.js"></script>`)).toBe(`<!doctype html>${SHIM_TAG}\n${VP}<script src="a.js"></script>`);
    expect(injectShim(`<html lang="en">${VP}<body>x`)).toBe(`<html lang="en">${SHIM_TAG}${VP}<body>x`);
    expect(injectShim('<canvas></canvas>')).toBe(`${VIEWPORT_TAG}${SHIM_TAG}<canvas></canvas>`);
  });
});
