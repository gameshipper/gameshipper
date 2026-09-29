// Electron's sandboxed preload may only require('electron'), so this file deliberately has no
// import/export statements: TypeScript then emits no module helpers beyond one
// `exports.__esModule` marker, which the sandboxed preload wrapper tolerates.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const callSaves = (op: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke('gameshipper:saves', op, ...args);
/** Every op must be in STEAM_OPS (src/shell/steam-api.ts); tests/shell/preload.test.ts checks. */
const callSteam = (op: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke('gameshipper:steam', op, args);

// gameshipper.plugins.<name>.<fn>(...args), from the list main.ts passes on the command line: a sandboxed
// preload can't read files.
const PLUGIN_ARG = '--gameshipper-plugins=';
let pluginManifest: Record<string, string[]> = {};
try {
  const arg = process.argv.find((a) => a.startsWith(PLUGIN_ARG));
  if (arg) pluginManifest = JSON.parse(decodeURIComponent(arg.slice(PLUGIN_ARG.length))) as Record<string, string[]>;
} catch {
  pluginManifest = {};
}
const plugins: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
for (const [name, fns] of Object.entries(pluginManifest)) {
  plugins[name] = {};
  for (const fn of fns) plugins[name][fn] = (...args: unknown[]) => ipcRenderer.invoke('gameshipper:plugin', name, fn, args);
}

/**
 * Exposes `api` as the global `name` (window.steam, window.gameshipper) in a way the game can replace.
 * exposeInMainWorld makes a property that can't be written or redefined, so a game with its own top-level
 * `const steam`, `class steam` or `window.steam = ...` would fail ("Identifier 'steam' has already been
 * declared"). So the API is exposed under a private name, then copied to an ordinary writable,
 * configurable global, which the game's own declaration takes the place of.
 */
function exposeReplaceable(name: string, hiddenName: string, api: Record<string, unknown>): void {
  contextBridge.exposeInMainWorld(hiddenName, api);
  contextBridge.executeInMainWorld({
    // Runs in the page's world, so it can't use anything from this file: only its arguments.
    func: (key: string, from: string) => {
      const value = (globalThis as unknown as Record<string, unknown>)[from];
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
    },
    args: [name, hiddenName],
  });
}

exposeReplaceable('gameshipper', '__gameshipper', {
  version: 1,
  saves: {
    save: (slot: string, data: unknown) => callSaves('save', slot, data),
    load: (slot: string) => callSaves('load', slot),
    list: () => callSaves('list'),
    delete: (slot: string) => callSaves('delete', slot),
  },
  plugins,
});

// Every method resolves to a harmless value (false, null or []) when Steam isn't available.
exposeReplaceable('steam', '__gameshipperSteam', {
  isAvailable: () => callSteam('isAvailable'),
  getUserName: () => callSteam('getUserName'),
  getSteamId: () => callSteam('getSteamId'),
  getLanguage: () => callSteam('getLanguage'),
  isSteamDeck: () => callSteam('isSteamDeck'),
  unlockAchievement: (id: string) => callSteam('unlockAchievement', id),
  clearAchievement: (id: string) => callSteam('clearAchievement', id),
  isAchievementUnlocked: (id: string) => callSteam('isAchievementUnlocked', id),
  listAchievements: () => callSteam('listAchievements'),
  getStat: (name: string, kind?: 'int' | 'float') => callSteam('getStat', name, kind),
  setStat: (name: string, value: number, kind?: 'int' | 'float') => callSteam('setStat', name, value, kind),
  storeStats: () => callSteam('storeStats'),
  uploadLeaderboardScore: (leaderboard: string, score: number) => callSteam('uploadLeaderboardScore', leaderboard, score),
  getLeaderboardEntries: (leaderboard: string, count?: number) => callSteam('getLeaderboardEntries', leaderboard, count),
  setRichPresence: (key: string, value: string | null) => callSteam('setRichPresence', key, value),
  clearRichPresence: () => callSteam('clearRichPresence'),
  activateOverlay: (dialog?: string) => callSteam('activateOverlay', dialog),
  activateOverlayWebPage: (url: string) => callSteam('activateOverlayWebPage', url),
  // GemShell-style names, so games written for GemShell need few or no changes.
  getPersonaName: () => callSteam('getUserName'),
  getSteamID: () => callSteam('getSteamId'),
  getAchievement: (id: string) => callSteam('isAchievementUnlocked', id),
  getStatInt: (name: string) => callSteam('getStat', name, 'int'),
  getStatFloat: (name: string) => callSteam('getStat', name, 'float'),
  setStatInt: (name: string, value: number) => callSteam('setStat', name, value, 'int'),
  setStatFloat: (name: string, value: number) => callSteam('setStat', name, value, 'float'),
  requestStats: () => callSteam('isAvailable'),
  requestStatsAndWait: () => callSteam('isAvailable'),
  runCallbacks: () => Promise.resolve(),
});

// Steam Deck on-screen keyboard: tell the main process when a text field gains or loses focus
// (deck-keyboard.ts decides which fields get which keyboard).
const showKeyboardFor = (target: EventTarget | null): void => {
  const el = target as HTMLElement | null;
  if (!el || typeof el.getBoundingClientRect !== 'function' || typeof el.tagName !== 'string') return;
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return;
  const r = el.getBoundingClientRect();
  ipcRenderer.send('gameshipper:text-focus', {
    tag,
    // The normalized type: lowercase, and "text" for a missing or unknown one.
    type: tag === 'input' ? (el as HTMLInputElement).type : '',
    editable: el.isContentEditable,
    readOnly: (tag === 'input' || tag === 'textarea') && (el as HTMLInputElement).readOnly,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    scale: window.devicePixelRatio,
  });
};
window.addEventListener('focusin', (event) => showKeyboardFor(event.target), true);
// A tap on the field that already has focus (after the player closed the keyboard) opens it again.
window.addEventListener(
  'pointerdown',
  (event) => {
    const focused = document.activeElement;
    if (focused && focused !== document.body && event.target instanceof Node && focused.contains(event.target)) showKeyboardFor(focused);
  },
  true,
);
window.addEventListener('focusout', () => ipcRenderer.send('gameshipper:text-blur'), true);
