import { describe, expect, it } from 'vitest';
import { createSteamApi, STEAM_OPS } from '../../src/shell/steam-api.js';
import { fakeSteamClient } from '../helpers/steam-fake.js';

/** The frame the game's calls come from. */
const GAME = 'app://game/index.html';

const withSteam = () => {
  const client = fakeSteamClient();
  return { client, api: createSteamApi({ client, isSteamDeck: false }) };
};
const without = createSteamApi({ client: null, isSteamDeck: true });

describe('window.steam main-process API', () => {
  it('answers user questions', async () => {
    const { api } = withSteam();
    expect(await api.call(GAME, 'isAvailable', [])).toBe(true);
    expect(await api.call(GAME, 'getUserName', [])).toBe('Player One');
    expect(await api.call(GAME, 'getSteamId', [])).toBe('76561190000000001');
    expect(await api.call(GAME, 'getLanguage', [])).toBe('english');
    expect(await api.call(GAME, 'isSteamDeck', [])).toBe(false);
  });

  it('unlocks, checks, lists and clears achievements', async () => {
    const { api } = withSteam();
    expect(await api.call(GAME, 'unlockAchievement', ['ACH_WIN_ONE_GAME'])).toBe(true);
    expect(await api.call(GAME, 'isAchievementUnlocked', ['ACH_WIN_ONE_GAME'])).toBe(true);
    expect(await api.call(GAME, 'listAchievements', [])).toEqual([
      { id: 'ACH_WIN_ONE_GAME', name: 'Winner', description: 'Win one game', unlocked: true, unlockTime: 0 },
    ]);
    expect(await api.call(GAME, 'clearAchievement', ['ACH_WIN_ONE_GAME'])).toBe(true);
    expect(await api.call(GAME, 'isAchievementUnlocked', ['ACH_WIN_ONE_GAME'])).toBe(false);
  });

  it('reads and writes int and float stats', async () => {
    const { api, client } = withSteam();
    expect(await api.call(GAME, 'getStat', ['NumGames'])).toBe(3);
    expect(await api.call(GAME, 'getStat', ['FeetTraveled'])).toBe(12.5);
    expect(await api.call(GAME, 'getStat', ['FeetTraveled', 'int'])).toBeNull();
    expect(await api.call(GAME, 'getStat', ['Nope'])).toBeNull();
    expect(await api.call(GAME, 'setStat', ['NumGames', 4])).toBe(true);
    expect(await api.call(GAME, 'setStat', ['FeetTraveled', 20])).toBe(true);
    expect(client.calls).toEqual(expect.arrayContaining(['setStatInt NumGames 4', 'setStatInt FeetTraveled 20', 'setStatFloat FeetTraveled 20']));
    expect(await api.call(GAME, 'setStat', ['NumGames', 5, 'int'])).toBe(true);
  });

  it("stores stats through Steam's own StoreStats(), returning its answer", async () => {
    const { api, client } = withSteam();
    expect(await api.call(GAME, 'storeStats', [])).toBe(true);
    expect(client.calls).toContain('StoreStats user-stats-interface');
    const refused = fakeSteamClient({}, false);
    expect(await createSteamApi({ client: refused, isSteamDeck: false }).call(GAME, 'storeStats', [])).toBe(false);
    expect(refused.calls).toContain('StoreStats user-stats-interface');
    // A steamworks-ffi-node without those bindings: nothing happened.
    const bare = Object.assign(fakeSteamClient(), { libraryLoader: undefined });
    expect(await createSteamApi({ client: bare, isSteamDeck: false }).call(GAME, 'storeStats', [])).toBe(false);
  });

  it('refuses integer stats and scores outside 32 bits, with a warning, with or without Steam', async () => {
    const warnings: string[] = [];
    const client = fakeSteamClient();
    const api = createSteamApi({ client, isSteamDeck: false, warn: (m) => warnings.push(m) });
    expect(await api.call(GAME, 'setStat', ['NumGames', 2 ** 31, 'int'])).toBe(false);
    expect(await api.call(GAME, 'setStat', ['NumGames', -(2 ** 31) - 1, 'int'])).toBe(false);
    expect(await api.call(GAME, 'uploadLeaderboardScore', ['Feet Traveled', 2 ** 31])).toBeNull();
    expect(await api.call(GAME, 'uploadLeaderboardScore', ['Feet Traveled', -1e12])).toBeNull();
    expect(client.calls.filter((c) => /^(setStat|uploadScore|findLeaderboard)/.test(c))).toEqual([]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toBe(
      'steam.setStat("NumGames", 2147483648): integer stats must be whole numbers from -2147483648 to 2147483647 (Steam keeps them in 32 bits), so it was not saved.',
    );
    expect(warnings[2]).toContain('leaderboard scores must be whole numbers from -2147483648 to 2147483647');
    // The edges fit.
    expect(await api.call(GAME, 'setStat', ['NumGames', 2 ** 31 - 1, 'int'])).toBe(true);
    expect(await api.call(GAME, 'uploadLeaderboardScore', ['Feet Traveled', -(2 ** 31)])).toMatchObject({ success: true, score: -(2 ** 31) });
    const offline = createSteamApi({ client: null, isSteamDeck: false, warn: (m) => warnings.push(m) });
    expect(await offline.call(GAME, 'setStat', ['NumGames', 2 ** 40, 'int'])).toBe(false);
    expect(warnings).toHaveLength(5);
  });

  it('writes numbers without a kind that are fractional or too big for an int as float stats', async () => {
    const { api, client } = withSteam();
    expect(await api.call(GAME, 'setStat', ['FeetTraveled', 2 ** 31])).toBe(true);
    expect(await api.call(GAME, 'setStat', ['FeetTraveled', -(2 ** 40)])).toBe(true);
    expect(await api.call(GAME, 'setStat', ['FeetTraveled', 1.5])).toBe(true);
    expect(client.calls.filter((c) => c.startsWith('setStat'))).toEqual([
      'setStatFloat FeetTraveled 2147483648',
      'setStatFloat FeetTraveled -1099511627776',
      'setStatFloat FeetTraveled 1.5',
    ]);
  });

  it('uploads scores and reads the top entries, finding each board once', async () => {
    const { api, client } = withSteam();
    expect(await api.call(GAME, 'uploadLeaderboardScore', ['Feet Traveled', 1234.9])).toEqual({ success: true, score: 1234, changed: true, rank: 7, previousRank: 9 });
    expect(await api.call(GAME, 'getLeaderboardEntries', ['Feet Traveled', 3])).toEqual([{ rank: 1, score: 99, steamId: '76561190000000002', name: 'name-of-76561190000000002' }]);
    expect(client.calls.filter((c) => c.startsWith('findLeaderboard'))).toEqual(['findLeaderboard Feet Traveled']);
    expect(client.calls).toContain('download 2 0 1 3');
    expect(await api.call(GAME, 'uploadLeaderboardScore', ['No Such Board', 1])).toBeNull();
    expect(await api.call(GAME, 'getLeaderboardEntries', ['No Such Board'])).toEqual([]);
  });

  it('sets rich presence and opens the overlay', async () => {
    const { api, client } = withSteam();
    expect(await api.call(GAME, 'setRichPresence', ['status', 'Level 3'])).toBe(true);
    expect(await api.call(GAME, 'clearRichPresence', [])).toBe(true);
    expect(await api.call(GAME, 'activateOverlay', ['Achievements'])).toBe(true);
    expect(await api.call(GAME, 'activateOverlay', [])).toBe(true);
    expect(await api.call(GAME, 'activateOverlayWebPage', ['https://example.com/wiki'])).toBe(true);
    expect(client.calls).toEqual(
      expect.arrayContaining(['setRichPresence status=Level 3', 'clearRichPresence', 'overlay Achievements', 'overlayWeb https://example.com/wiki']),
    );
  });

  it('is a safe no-op without Steam', async () => {
    const expected: Record<string, unknown> = {
      isAvailable: false,
      getUserName: null,
      getSteamId: null,
      getLanguage: null,
      isSteamDeck: true,
      unlockAchievement: false,
      clearAchievement: false,
      isAchievementUnlocked: false,
      listAchievements: [],
      getStat: null,
      setStat: false,
      storeStats: false,
      uploadLeaderboardScore: null,
      getLeaderboardEntries: [],
      setRichPresence: false,
      clearRichPresence: false,
      activateOverlay: false,
      activateOverlayWebPage: false,
    };
    const args: Record<string, unknown[]> = {
      unlockAchievement: ['A'],
      clearAchievement: ['A'],
      isAchievementUnlocked: ['A'],
      getStat: ['S'],
      setStat: ['S', 1],
      uploadLeaderboardScore: ['B', 1],
      getLeaderboardEntries: ['B'],
      setRichPresence: ['k', 'v'],
      activateOverlayWebPage: ['https://example.com'],
    };
    expect(Object.keys(expected).sort()).toEqual([...STEAM_OPS].sort());
    for (const op of STEAM_OPS) expect(await without.call(GAME, op, args[op] ?? []), op).toEqual(expected[op]);
  });

  it('a failing Steam call resolves to the no-op value instead of throwing', async () => {
    const client = fakeSteamClient();
    client.achievements.unlockAchievement = async () => {
      throw new Error('native crash');
    };
    expect(await createSteamApi({ client, isSteamDeck: false }).call(GAME, 'unlockAchievement', ['A'])).toBe(false);
  });

  it('tells when its Steam calls have finished, waiting at most the given time', async () => {
    const client = fakeSteamClient();
    const waiting: Array<() => void> = [];
    const finish = () => waiting.forEach((resolve) => resolve());
    client.leaderboards.findLeaderboard = () => new Promise((resolve) => waiting.push(() => resolve({ handle: 2n })));
    const api = createSteamApi({ client, isSteamDeck: false });
    expect(api.pendingCalls()).toBe(0);
    await api.whenIdle(1000);
    const upload = api.call(GAME, 'uploadLeaderboardScore', ['Feet Traveled', 5]);
    const other = api.call(GAME, 'getLeaderboardEntries', ['Other']);
    expect(api.pendingCalls()).toBe(2);
    const started = Date.now();
    await api.whenIdle(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(api.pendingCalls()).toBe(2);
    const idle = api.whenIdle(5000);
    finish();
    await idle;
    expect(api.pendingCalls()).toBe(0);
    expect(await upload).toMatchObject({ success: true });
    expect(await other).toEqual([expect.objectContaining({ rank: 1 })]);
  });

  it('answers only the game itself', async () => {
    const { api, client } = withSteam();
    for (const sender of ['https://example.com/', 'about:blank', undefined]) {
      await expect(api.call(sender, 'unlockAchievement', ['A'])).rejects.toThrow('Steam is only available to the game (app://game/).');
    }
    expect(client.calls.some((c) => c.startsWith('unlock'))).toBe(false);
  });

  it('refuses unknown operations and bad arguments, with or without Steam', async () => {
    for (const api of [withSteam().api, without]) {
      await expect(api.call(GAME, 'shutdown', [])).rejects.toThrow('Unknown Steam operation: shutdown');
      await expect(api.call(GAME, '__proto__', [])).rejects.toThrow('Unknown Steam operation');
      await expect(api.call(GAME, 'unlockAchievement', [])).rejects.toThrow('The achievement id must be a non-empty string');
      await expect(api.call(GAME, 'setStat', ['S', Number.NaN])).rejects.toThrow('The stat value must be a finite number');
      await expect(api.call(GAME, 'setStat', ['S', 1, 'double'])).rejects.toThrow('"int" or "float"');
      await expect(api.call(GAME, 'getLeaderboardEntries', ['B', 500])).rejects.toThrow('from 1 to 100');
      await expect(api.call(GAME, 'activateOverlay', ['inventory'])).rejects.toThrow('Unknown overlay dialog "inventory"');
      await expect(api.call(GAME, 'activateOverlayWebPage', ['file:///etc/passwd'])).rejects.toThrow('http:// or https://');
    }
  });
});
