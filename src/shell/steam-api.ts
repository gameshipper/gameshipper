import { isGameUrl } from './policy.js';
import type { SteamworksClient } from './steam.js';

/**
 * Every operation window.steam can ask the main process for. The preload maps each game-facing
 * method (and its GemShell-style alias) onto one of these; anything else is refused.
 */
export const STEAM_OPS = [
  'isAvailable',
  'getUserName',
  'getSteamId',
  'getLanguage',
  'isSteamDeck',
  'unlockAchievement',
  'clearAchievement',
  'isAchievementUnlocked',
  'listAchievements',
  'getStat',
  'setStat',
  'storeStats',
  'uploadLeaderboardScore',
  'getLeaderboardEntries',
  'setRichPresence',
  'clearRichPresence',
  'activateOverlay',
  'activateOverlayWebPage',
] as const;
export type SteamOp = (typeof STEAM_OPS)[number];

/** Overlay dialogs the game may open, mapped to Steam's names. */
export const OVERLAY_DIALOGS: Record<string, string> = {
  friends: 'Friends',
  community: 'Community',
  players: 'Players',
  settings: 'Settings',
  officialgamegroup: 'OfficialGameGroup',
  stats: 'Stats',
  achievements: 'Achievements',
};

const LEADERBOARD_GLOBAL = 0;
const UPLOAD_KEEP_BEST = 1;

/** Steam keeps integer stats and leaderboard scores as signed 32-bit integers. */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const isInt32 = (n: number): boolean => Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX;

export interface SteamApiState {
  /** Null when Steam isn't available; every call then returns its "nothing happened" value. */
  client: SteamworksClient | null;
  isSteamDeck: boolean;
  /** Records a mistake in the game's call that isn't worth rejecting (it shows up in `play --smoke`). */
  warn?: (message: string) => void;
}

export interface SteamApi {
  /**
   * Runs one window.steam operation. `senderUrl` is the page that asked (the IPC sender frame's URL): only
   * the game's own pages may use Steam, so a page the window somehow ends up showing can't.
   */
  call(senderUrl: string | null | undefined, op: unknown, args: unknown): Promise<unknown>;
}

function text(args: unknown[], i: number, what: string, max = 256): string {
  const v = args[i];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new TypeError(`${what} must be a non-empty string of at most ${max} characters.`);
  return v;
}

function number(args: unknown[], i: number, what: string): number {
  const v = args[i];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be a finite number.`);
  return v;
}

function statKind(args: unknown[], i: number): 'int' | 'float' | undefined {
  const v = args[i];
  if (v === undefined || v === null) return undefined;
  if (v !== 'int' && v !== 'float') throw new TypeError('The stat kind must be "int" or "float".');
  return v;
}

/**
 * The main-process side of window.steam. Arguments are checked the same way whether or not Steam
 * is available, so mistakes show up while developing without Steam too.
 */
export function createSteamApi(state: SteamApiState): SteamApi {
  const warn = state.warn ?? (() => {});
  /** An out-of-range number: warn, and the call does nothing, with or without Steam. */
  const outOfRange = (call: string, what: string, outcome: string, fallback: unknown) => {
    warn(`steam.${call}: ${what} must be whole numbers from ${INT32_MIN} to ${INT32_MAX} (Steam keeps them in 32 bits), so it was not ${outcome}.`);
    return { fallback };
  };
  const boards = new Map<string, bigint>();
  const board = async (c: SteamworksClient, name: string): Promise<bigint | null> => {
    const known = boards.get(name);
    if (known !== undefined) return known;
    const found = await c.leaderboards.findLeaderboard(name);
    if (found) boards.set(name, found.handle);
    return found ? found.handle : null;
  };

  type Handler = (args: unknown[]) => { fallback: unknown; run?: (c: SteamworksClient) => unknown };
  const handlers: Record<SteamOp, Handler> = {
    isAvailable: () => ({ fallback: false, run: () => true }),
    getUserName: () => ({ fallback: null, run: (c) => c.friends.getPersonaName() || null }),
    getSteamId: () => ({ fallback: null, run: (c) => (c.getStatus().steamId !== '0' ? c.getStatus().steamId : null) }),
    getLanguage: () => ({ fallback: null, run: (c) => c.getCurrentGameLanguage() || null }),
    isSteamDeck: () => ({ fallback: state.isSteamDeck, run: () => state.isSteamDeck }),
    unlockAchievement: (a) => {
      const id = text(a, 0, 'The achievement id');
      return { fallback: false, run: (c) => c.achievements.unlockAchievement(id) };
    },
    clearAchievement: (a) => {
      const id = text(a, 0, 'The achievement id');
      return { fallback: false, run: (c) => c.achievements.clearAchievement(id) };
    },
    isAchievementUnlocked: (a) => {
      const id = text(a, 0, 'The achievement id');
      return { fallback: false, run: (c) => c.achievements.isAchievementUnlocked(id) };
    },
    listAchievements: () => ({
      fallback: [],
      run: async (c) =>
        (await c.achievements.getAllAchievements()).map((x) => ({
          id: x.apiName,
          name: x.displayName,
          description: x.description,
          unlocked: x.unlocked,
          unlockTime: x.unlockTime,
        })),
    }),
    getStat: (a) => {
      const name = text(a, 0, 'The stat name');
      const kind = statKind(a, 1);
      return {
        fallback: null,
        run: async (c) => {
          if (kind !== 'float') {
            const int = await c.stats.getStatInt(name);
            if (int) return int.value;
            if (kind === 'int') return null;
          }
          return (await c.stats.getStatFloat(name))?.value ?? null;
        },
      };
    },
    setStat: (a) => {
      const name = text(a, 0, 'The stat name');
      const value = number(a, 1, 'The stat value');
      const kind = statKind(a, 2);
      if (kind === 'int' && !isInt32(Math.trunc(value))) {
        return outOfRange(`setStat(${JSON.stringify(name)}, ${value})`, 'integer stats', 'saved', false);
      }
      return {
        fallback: false,
        run: async (c) => {
          // Without a kind, only a whole number that fits an int stat is tried as one; anything else is a float stat.
          if (kind === 'int' || (kind === undefined && isInt32(value))) {
            if (await c.stats.setStatInt(name, Math.trunc(value))) return true;
            if (kind === 'int') return false;
          }
          return c.stats.setStatFloat(name, value);
        },
      };
    },
    // setStat already sends stats to Steam; this exists for GemShell-style code.
    storeStats: () => ({ fallback: false, run: () => true }),
    uploadLeaderboardScore: (a) => {
      const name = text(a, 0, 'The leaderboard name');
      const score = Math.trunc(number(a, 1, 'The score'));
      if (!isInt32(score)) return outOfRange(`uploadLeaderboardScore(${JSON.stringify(name)}, ${score})`, 'leaderboard scores', 'uploaded', null);
      return {
        fallback: null,
        run: async (c) => {
          const handle = await board(c, name);
          if (handle === null) return null;
          const r = await c.leaderboards.uploadScore(handle, score, UPLOAD_KEEP_BEST);
          return r && { success: r.success, score: r.score, changed: r.scoreChanged, rank: r.globalRankNew, previousRank: r.globalRankPrevious };
        },
      };
    },
    getLeaderboardEntries: (a) => {
      const name = text(a, 0, 'The leaderboard name');
      const count = a[1] === undefined ? 10 : number(a, 1, 'The entry count');
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new TypeError('The entry count must be a whole number from 1 to 100.');
      return {
        fallback: [],
        run: async (c) => {
          const handle = await board(c, name);
          if (handle === null) return [];
          const entries = await c.leaderboards.downloadLeaderboardEntries(handle, LEADERBOARD_GLOBAL, 1, count);
          return entries.map((e) => ({ rank: e.globalRank, score: e.score, steamId: e.steamId, name: c.friends.getFriendPersonaName(e.steamId) }));
        },
      };
    },
    setRichPresence: (a) => {
      const key = text(a, 0, 'The rich presence key', 64);
      const value = a[1] === null ? null : text(a, 1, 'The rich presence value');
      return { fallback: false, run: (c) => c.richPresence.setRichPresence(key, value) };
    },
    clearRichPresence: () => ({
      fallback: false,
      run: (c) => {
        c.richPresence.clearRichPresence();
        return true;
      },
    }),
    activateOverlay: (a) => {
      const dialog = a[0] === undefined ? 'achievements' : text(a, 0, 'The overlay dialog').toLowerCase();
      if (!Object.hasOwn(OVERLAY_DIALOGS, dialog)) throw new TypeError(`Unknown overlay dialog "${dialog}". Use one of: ${Object.keys(OVERLAY_DIALOGS).join(', ')}.`);
      const steamName = OVERLAY_DIALOGS[dialog];
      return {
        fallback: false,
        run: (c) => {
          c.overlay.activateGameOverlay(steamName);
          return true;
        },
      };
    },
    activateOverlayWebPage: (a) => {
      const url = text(a, 0, 'The URL', 2048);
      if (!/^https?:\/\//i.test(url)) throw new TypeError('The URL must start with http:// or https://.');
      return {
        fallback: false,
        run: (c) => {
          c.overlay.activateGameOverlayToWebPage(url);
          return true;
        },
      };
    },
  };

  return {
    async call(senderUrl, op, args) {
      if (!isGameUrl(senderUrl)) throw new Error('Steam is only available to the game (app://game/).');
      if (typeof op !== 'string' || !Object.hasOwn(handlers, op)) throw new Error(`Unknown Steam operation: ${String(op)}`);
      const { fallback, run } = handlers[op as SteamOp](Array.isArray(args) ? args : []);
      const client = state.client;
      if (!client || !run) return fallback;
      try {
        return await run(client);
      } catch {
        // A failing Steam call must never break the game; it just "didn't happen".
        return fallback;
      }
    },
  };
}
