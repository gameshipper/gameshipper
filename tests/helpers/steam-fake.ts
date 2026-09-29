import type { SteamworksClient } from '../../src/shell/steam.js';

/**
 * An in-memory stand-in for a steamworks-ffi-node instance, logging every call. Like the real one it has a
 * `libraryLoader` with the flat Steam API bindings the shell's storeStats uses; `storeResult` is what
 * StoreStats() returns.
 */
export function fakeSteamClient(overrides: Partial<SteamworksClient> = {}, storeResult = true): SteamworksClient & { calls: string[] } {
  const calls: string[] = [];
  const log = (s: string) => calls.push(s);
  const unlocked = new Set<string>();
  const client: SteamworksClient = {
    setSdkPath: (dir) => log(`setSdkPath ${dir}`),
    restartAppIfNecessary: (appId) => (log(`restartAppIfNecessary ${appId}`), false),
    init: ({ appId }) => (log(`init ${appId}`), true),
    runCallbacks: () => log('runCallbacks'),
    shutdown: () => log('shutdown'),
    getStatus: () => ({ initialized: true, appId: 480, steamId: '76561190000000001' }),
    getCurrentGameLanguage: () => 'english',
    addElectronSteamOverlay: () => (log('addElectronSteamOverlay'), true),
    achievements: {
      unlockAchievement: async (n) => (unlocked.add(n), log(`unlock ${n}`), true),
      clearAchievement: async (n) => (unlocked.delete(n), log(`clear ${n}`), true),
      isAchievementUnlocked: async (n) => unlocked.has(n),
      getAllAchievements: async () => [
        { apiName: 'ACH_WIN_ONE_GAME', displayName: 'Winner', description: 'Win one game', unlocked: unlocked.has('ACH_WIN_ONE_GAME'), unlockTime: 0 },
      ],
    },
    stats: {
      getStatInt: async (n) => (n === 'NumGames' ? { value: 3 } : null),
      getStatFloat: async (n) => (n === 'FeetTraveled' ? { value: 12.5 } : null),
      setStatInt: async (n, v) => (log(`setStatInt ${n} ${v}`), n === 'NumGames'),
      setStatFloat: async (n, v) => (log(`setStatFloat ${n} ${v}`), n === 'FeetTraveled'),
    },
    leaderboards: {
      findLeaderboard: async (n) => (log(`findLeaderboard ${n}`), n === 'Feet Traveled' ? { handle: 2n } : null),
      uploadScore: async (h, score, method) => (
        log(`uploadScore ${h} ${score} ${method}`), { success: true, score, scoreChanged: true, globalRankNew: 7, globalRankPrevious: 9 }
      ),
      downloadLeaderboardEntries: async (h, request, start, end) => (
        log(`download ${h} ${request} ${start} ${end}`), [{ steamId: '76561190000000002', globalRank: 1, score: 99 }]
      ),
    },
    friends: { getPersonaName: () => 'Player One', getFriendPersonaName: (id) => `name-of-${id}` },
    richPresence: {
      setRichPresence: (k, v) => (log(`setRichPresence ${k}=${v}`), true),
      clearRichPresence: () => log('clearRichPresence'),
    },
    overlay: {
      activateGameOverlay: (d) => log(`overlay ${d}`),
      activateGameOverlayToWebPage: (u) => log(`overlayWeb ${u}`),
    },
    utils: {
      isOverlayEnabled: () => true,
      showFloatingGamepadTextInput: (m, x, y, w, h) => (log(`keyboard ${m} ${x},${y} ${w}x${h}`), true),
      dismissFloatingGamepadTextInput: () => (log('dismissKeyboard'), true),
    },
    ...overrides,
  };
  const libraryLoader = {
    SteamAPI_SteamUserStats: () => 'user-stats-interface',
    SteamAPI_ISteamUserStats_StoreStats: (stats: unknown) => (log(`StoreStats ${String(stats)}`), storeResult),
  };
  return Object.assign(client, { calls, libraryLoader });
}
