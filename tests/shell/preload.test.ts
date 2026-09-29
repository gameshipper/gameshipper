import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STEAM_OPS } from '../../src/shell/steam-api.js';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const preload = read('src/shell/preload.ts');
const types = read('types/index.d.ts');

/** The method names in exposeReplaceable('steam', ..., { ... }). */
function steamMethods(): string[] {
  const block = preload.slice(preload.indexOf("exposeReplaceable('steam'"));
  return [...block.slice(0, block.indexOf('\n});')).matchAll(/^ {2}(\w+): \(/gm)].map((m) => m[1]);
}

describe('preload ↔ main ↔ types', () => {
  it('asks the main process only for allowed Steam operations, and uses all of them', () => {
    const used = new Set([...preload.matchAll(/callSteam\('(\w+)'/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual([...STEAM_OPS].sort());
  });

  it('never exposes window.steam or window.gameshipper as properties the game could not replace', () => {
    expect(preload).not.toMatch(/exposeInMainWorld\('(steam|gameshipper)'/);
    expect(preload).toContain("exposeReplaceable('steam', '__gameshipperSteam'");
    expect(preload).toContain("exposeReplaceable('gameshipper', '__gameshipper'");
  });

  it('documents every window.steam method in types/index.d.ts', () => {
    const methods = steamMethods();
    expect(methods.length).toBeGreaterThan(20);
    for (const m of methods) expect(types, m).toMatch(new RegExp(`^\\s+${m}\\(`, 'm'));
  });
});
