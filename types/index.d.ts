/**
 * Types for the globals Gameshipper gives your game in desktop builds.
 * In a plain browser both are undefined, so check before use:
 *
 *   /// <reference types="gameshipper/types" />
 *   if (window.steam && (await window.steam.isAvailable())) { ... }
 */

export interface SteamAchievement {
  /** API name, e.g. "ACH_WIN_ONE_GAME". */
  id: string;
  name: string;
  description: string;
  unlocked: boolean;
  /** Unix time in seconds; 0 while locked. */
  unlockTime: number;
}

export interface SteamLeaderboardEntry {
  rank: number;
  score: number;
  steamId: string;
  /** The player's Steam name, when Steam knows it. */
  name: string;
}

export interface SteamScoreUpload {
  success: boolean;
  /** The score Steam kept (your best score is kept). */
  score: number;
  changed: boolean;
  rank: number;
  previousRank: number;
}

export type SteamOverlayDialog = 'friends' | 'community' | 'players' | 'settings' | 'officialgamegroup' | 'stats' | 'achievements';

/**
 * window.steam. Every method resolves to a harmless value (false, null or []) when Steam
 * isn't running or the build has no Steamworks SDK, so the game never has to guard each call.
 */
export interface GameshipperSteam {
  /** True when Steam is connected. */
  isAvailable(): Promise<boolean>;
  /** The player's Steam name. */
  getUserName(): Promise<string | null>;
  getSteamId(): Promise<string | null>;
  /** The language the player picked for this game in Steam, e.g. "english". */
  getLanguage(): Promise<string | null>;
  /** True on a Steam Deck (works without Steam too). */
  isSteamDeck(): Promise<boolean>;

  unlockAchievement(id: string): Promise<boolean>;
  /** For testing: locks an achievement again. */
  clearAchievement(id: string): Promise<boolean>;
  isAchievementUnlocked(id: string): Promise<boolean>;
  listAchievements(): Promise<SteamAchievement[]>;

  /** Reads a stat; `kind` defaults to trying int, then float. */
  getStat(name: string, kind?: 'int' | 'float'): Promise<number | null>;
  /** Sets and saves a stat to Steam; whole numbers are written as int stats unless `kind` says otherwise. */
  setStat(name: string, value: number, kind?: 'int' | 'float'): Promise<boolean>;
  /** setStat already saves; kept for code written for other tools. */
  storeStats(): Promise<boolean>;

  /** Uploads a score to an existing leaderboard, keeping the player's best. */
  uploadLeaderboardScore(leaderboard: string, score: number): Promise<SteamScoreUpload | null>;
  /** The top `count` entries (default 10, at most 100). */
  getLeaderboardEntries(leaderboard: string, count?: number): Promise<SteamLeaderboardEntry[]>;

  /** Rich presence shown to friends, e.g. setRichPresence('status', 'Level 3'). null removes the key. */
  setRichPresence(key: string, value: string | null): Promise<boolean>;
  clearRichPresence(): Promise<boolean>;

  /** Opens the Steam overlay (default: achievements). */
  activateOverlay(dialog?: SteamOverlayDialog): Promise<boolean>;
  /** Opens a web page (http or https) in the Steam overlay's browser. */
  activateOverlayWebPage(url: string): Promise<boolean>;

  // GemShell-compatible names.
  getPersonaName(): Promise<string | null>;
  getSteamID(): Promise<string | null>;
  getAchievement(id: string): Promise<boolean>;
  getStatInt(name: string): Promise<number | null>;
  getStatFloat(name: string): Promise<number | null>;
  setStatInt(name: string, value: number): Promise<boolean>;
  setStatFloat(name: string, value: number): Promise<boolean>;
  requestStats(): Promise<boolean>;
  requestStatsAndWait(timeoutMs?: number): Promise<boolean>;
  runCallbacks(): Promise<void>;
}

/** JSON files in the OS app-data folder; Steam Auto-Cloud can sync them. */
export interface GameshipperSaves {
  save(slot: string, data: unknown): Promise<void>;
  load<T = unknown>(slot: string): Promise<T | null>;
  list(): Promise<string[]>;
  delete(slot: string): Promise<void>;
}

/** Functions from gameshipper.json "plugins": gameshipper.plugins.<name>.<fn>(...args). */
export type GameshipperPlugins = Record<string, Record<string, (...args: any[]) => Promise<any>>>;

/** window.gameshipper */
export interface GameshipperApi {
  version: number;
  saves: GameshipperSaves;
  plugins: GameshipperPlugins;
}

declare global {
  interface Window {
    steam?: GameshipperSteam;
    gameshipper?: GameshipperApi;
  }
  var steam: GameshipperSteam | undefined;
  var gameshipper: GameshipperApi | undefined;
}
