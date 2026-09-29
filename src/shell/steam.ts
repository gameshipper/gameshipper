import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SteamState } from './diagnostics.js';

/** The parts of a steamworks-ffi-node instance the shell uses (main.ts checks the real type fits). */
export interface SteamworksClient {
  setSdkPath(dir: string): void;
  restartAppIfNecessary(appId: number): boolean;
  init(options: { appId: number }): boolean;
  runCallbacks(): void;
  shutdown(): void;
  getStatus(): { initialized: boolean; appId: number; steamId: string };
  getCurrentGameLanguage(): string;
  addElectronSteamOverlay(window: unknown, options?: { title?: string; fps?: number; vsync?: boolean }): boolean;
  achievements: {
    unlockAchievement(name: string): Promise<boolean>;
    clearAchievement(name: string): Promise<boolean>;
    isAchievementUnlocked(name: string): Promise<boolean>;
    getAllAchievements(): Promise<Array<{ apiName: string; displayName: string; description: string; unlocked: boolean; unlockTime: number }>>;
  };
  stats: {
    getStatInt(name: string): Promise<{ value: number } | null>;
    getStatFloat(name: string): Promise<{ value: number } | null>;
    setStatInt(name: string, value: number): Promise<boolean>;
    setStatFloat(name: string, value: number): Promise<boolean>;
  };
  leaderboards: {
    findLeaderboard(name: string): Promise<{ handle: bigint } | null>;
    uploadScore(
      handle: bigint,
      score: number,
      method: number,
    ): Promise<{ success: boolean; score: number; scoreChanged: boolean; globalRankNew: number; globalRankPrevious: number } | null>;
    downloadLeaderboardEntries(handle: bigint, request: number, start: number, end: number): Promise<Array<{ steamId: string; globalRank: number; score: number }>>;
  };
  friends: { getPersonaName(): string; getFriendPersonaName(steamId: string): string };
  richPresence: { setRichPresence(key: string, value: string | null): boolean; clearRichPresence(): void };
  overlay: { activateGameOverlay(dialog: string): void; activateGameOverlayToWebPage(url: string): void };
  utils: {
    isOverlayEnabled(): boolean;
    showFloatingGamepadTextInput(mode: number, x: number, y: number, width: number, height: number): boolean;
    dismissFloatingGamepadTextInput(): boolean;
  };
}

/** What main.ts gets from require('steamworks-ffi-node') (injected so tests never load native code). */
export interface SteamworksLoad {
  instance(): SteamworksClient;
  /** steamworks-ffi-node's SteamLogger: its error() receives Steam's failure reasons. */
  logger: { error(...args: unknown[]): void };
  /** Calls SteamAPI_IsSteamRunning() in the given library. */
  isSteamRunning(libraryPath: string): boolean;
}

export interface StartSteamOptions {
  appId: number;
  /**
   * <app>/steamworks_sdk. In packaged builds this is inside app.asar: steamworks-ffi-node maps
   * it to app.asar.unpacked itself, so pass the app.asar path, never the unpacked one.
   */
  sdkDir: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  load(): SteamworksLoad;
  exists?(file: string): boolean;
  /** How often Steam callbacks run, in ms (default 33, about 30 times a second). */
  callbackMs?: number;
}

export interface SteamSession {
  state: SteamState;
  message: string | null;
  /** Set only when state is 'ready'. */
  client: SteamworksClient | null;
  /** Stops callbacks and shuts Steam down so it sees the game as closed. Safe to call twice. */
  stop(): void;
}

export const TEST_APP_ID = 480;
const LIBRARIES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'win64/steam_api64.dll',
  darwin: 'osx/libsteam_api.dylib',
  linux: 'linux64/libsteam_api.so',
};

/** Native files can't be loaded from inside app.asar; packaged builds keep them in app.asar.unpacked. */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/]|$)/, '$1app.asar.unpacked');
}

/** The real file path of this OS's Steam library in the app, or null on other OSes. */
export function sdkLibraryPath(sdkDir: string, platform: NodeJS.Platform): string | null {
  const lib = LIBRARIES[platform];
  return lib ? path.join(unpackedPath(sdkDir), 'redistributable_bin', ...lib.split('/')) : null;
}

/** SteamOS sets SteamDeck=1 in game mode. (Steamworks SDK 1.65 removed IsSteamRunningOnSteamDeck.) */
export function isSteamDeck(env: NodeJS.ProcessEnv): boolean {
  return env.SteamDeck === '1';
}

/**
 * A packaged build with a real App ID that wasn't started by Steam asks Steam to relaunch it
 * (restartAppIfNecessary). Never for Valve's test app 480, `play` runs, or smoke tests.
 */
export function shouldRestartThroughSteam(appId: number, isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return appId !== TEST_APP_ID && isPackaged && !env.GAMESHIPPER_SMOKE_SECONDS;
}

const cleanMessage = (m: string) => m.replace(/^\[Steamworks\]\s*(ERROR:\s*)?/, '').trim();

/** Connects to Steam if this app has the SDK and Steam is running. Never throws. */
export function startSteam(opts: StartSteamOptions): SteamSession {
  const exists = opts.exists ?? fs.existsSync;
  const off = (state: SteamState, message: string): SteamSession => ({ state, message, client: null, stop: () => {} });
  const libraryPath = sdkLibraryPath(opts.sdkDir, opts.platform);
  if (!libraryPath || !exists(libraryPath)) return off('no-sdk', 'This build has no Steamworks library, so Steam features are off.');

  let lib: SteamworksLoad;
  try {
    lib = opts.load();
  } catch (e) {
    return off('init-failed', `Couldn't load the Steam bridge: ${(e as Error).message}`);
  }
  const reasons: string[] = [];
  const logError = lib.logger.error;
  lib.logger.error = (...args: unknown[]) => {
    reasons.push(cleanMessage(args.map(String).join(' ')));
    logError.apply(lib.logger, args);
  };
  let client: SteamworksClient;
  try {
    client = lib.instance();
    client.setSdkPath(opts.sdkDir);
    if (shouldRestartThroughSteam(opts.appId, opts.isPackaged, opts.env) && client.restartAppIfNecessary(opts.appId)) {
      return off('restarting', 'The game was not started by Steam, so Steam is relaunching it.');
    }
    if (!client.init({ appId: opts.appId })) {
      let running = true;
      try {
        running = lib.isSteamRunning(libraryPath);
      } catch {
        running = true;
      }
      return running ? off('init-failed', reasons[0] ?? 'SteamAPI_Init() failed.') : off('not-running', 'Steam is not running.');
    }
  } catch (e) {
    return off('init-failed', (e as Error).message);
  } finally {
    lib.logger.error = logError;
  }

  const timer = setInterval(() => {
    try {
      client.runCallbacks();
    } catch {
      // A failed round of callbacks must never crash the game; the next one tries again.
    }
  }, opts.callbackMs ?? 33);
  timer.unref();
  let stopped = false;
  return {
    state: 'ready',
    message: null,
    client,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        client.shutdown();
      } catch {
        // Shutting down must never keep the game from closing.
      }
    },
  };
}
