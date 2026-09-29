import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell, type WebContents, type WebFrameMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { PageCamera } from './camera.js';
import {
  captureSettings,
  DECK_SIZE,
  isAllowedOffline,
  QUIT_TIMEOUT_EXIT_CODE,
  QUIT_TIMEOUT_MS,
  SCREENSHOT_SIZE,
  screenshotFileName,
  type Size,
} from './capture.js';
import { floatingKeyboardArgs } from './deck-keyboard.js';
import {
  createDiagnostics,
  LOAD_BACKSTOP_EXTRA_SECONDS,
  LOAD_TIMEOUT_DESCRIPTION,
  mainProcessErrorReason,
  writeSummary,
} from './diagnostics.js';
import { chromiumSwitches } from './flags.js';
import { isFullscreenToggle, isScreenshotKey } from './keys.js';
import { mimeType } from './mime.js';
import { chooseOverlay, startRepaint } from './overlay.js';
import { caseMismatch, requestParts, userDataDir } from './paths.js';
import { createPluginHost, type PluginHost } from './plugins-runtime.js';
import {
  classifyLoadFailure,
  CROSS_ORIGIN_ISOLATION_HEADERS,
  isGameUrl,
  isPermissionAllowed,
  leaveAction,
  navigationAction,
  newWindowSource,
  returnToGame,
} from './policy.js';
import { cleanCounters, cleanLayout, layoutProbe, PROBE_ARG, READ_COUNTERS_JS, type ProbeReport } from './probe.js';
import { planFileResponse } from './range.js';
import { entryUrl, readRuntimeConfig } from './runtime-config.js';
import { callSaveStore, createSaveStore, type SaveStore } from './saves.js';
import { createSteamApi, type SteamApi } from './steam-api.js';
import { isSteamDeck, startSteam, withSteamErrors, type SteamSession, type SteamworksLoad } from './steam.js';

const env = process.env;
const diagnostics = createDiagnostics(env.GAMESHIPPER_LOG ?? null);
const smokeSeconds = Number(env.GAMESHIPPER_SMOKE_SECONDS ?? '0');
const smoke = smokeSeconds > 0;
/** What `play` and `check` asked the shell to capture (capture.ts); nothing for a shipped game. */
const capture = captureSettings(env);

const errorText = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return '(unprintable value)';
  }
};

/** Set once Steam has been started (below); a smoke run that fails before that has none. */
let steam: SteamSession | null = null;
/** window.steam's main-process side, set once the app is ready. */
let steamApi: SteamApi | null = null;
/** How long quitting waits for the game's last Steam calls (a leaderboard upload, say) before shutting Steam down. */
const STEAM_QUIT_WAIT_MS = 1000;

/**
 * Shuts Steam down so it sees the game as closed. Calls still waiting for Steam get up to STEAM_QUIT_WAIT_MS
 * first: steamworks-ffi-node polls for their results, and a poll after the shutdown could crash the game.
 */
async function stopSteam(): Promise<void> {
  try {
    await steamApi?.whenIdle(STEAM_QUIT_WAIT_MS);
  } finally {
    steam?.stop();
  }
}

// A smoke run always ends with a summary or a non-zero exit code; it never hangs.
let smokeDone = false;
/** Set once the page has finished loading (or its load was stopped); the backstop checks it. */
let pageLoaded = false;
/** What a `check` run measured just before its summary was written (runProbe). */
let probeReport: ProbeReport | null = null;
/**
 * `closing`: a `check` run ends by closing the game's window the way a player does, so its exit code shows whether
 * the game quits (closeLikeAPlayer). Every other ending exits at once with `code`.
 */
function finishSmoke(code: number, closing?: BrowserWindow): void {
  if (smokeDone) return;
  smokeDone = true;
  let exitCode = code;
  const client = steam?.client;
  if (client) {
    try {
      // Whether Steam says its overlay hooked the game: only the events log keeps it.
      diagnostics.record({ kind: 'steam-overlay', enabled: client.utils.isOverlayEnabled() });
    } catch {
      // Asking must never keep the run from ending.
    }
  }
  if (env.GAMESHIPPER_SMOKE_OUT) {
    try {
      writeSummary(env.GAMESHIPPER_SMOKE_OUT, probeReport ? { ...diagnostics.summary(), probe: probeReport } : diagnostics.summary());
    } catch (e) {
      process.stderr.write(`Gameshipper: couldn't write the smoke summary: ${errorText(e)}\n`);
      exitCode = code || 1;
    }
  }
  if (closing && exitCode === 0 && !closing.isDestroyed()) {
    closeLikeAPlayer(closing);
    return;
  }
  // app.exit() skips will-quit, so Steam is told here that the game closed. Nothing runs after app.exit(), so no
  // poll for a Steam call's result can come after the shutdown.
  void stopSteam().finally(() => app.exit(exitCode));
}

if (smoke) {
  // Registered before anything that can throw (like reading config.json). Having a listener
  // also stops Electron from showing its modal error dialog, which would block the run.
  const onFatal = (error: unknown): void => {
    diagnostics.record({ kind: 'crashed', reason: mainProcessErrorReason(error) });
    finishSmoke(1);
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
}

// Unpackaged (play) runs would otherwise log a CSP warning that says nothing about the game.
env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const config = readRuntimeConfig(path.join(__dirname, 'config.json'));
const appRoot = path.join(__dirname, '..');
const gameRoot = path.join(appRoot, 'game');
const gameEntry = entryUrl(config.entry);

/** Loaded only when the app has a Steam library, so builds without the SDK never load native code. */
function loadSteamworks(): SteamworksLoad {
  const steamworks = require('steamworks-ffi-node') as typeof import('steamworks-ffi-node');
  return {
    instance: () => steamworks.default.getInstance(),
    logger: steamworks.SteamLogger,
    isSteamRunning(libraryPath) {
      const koffi = require('koffi') as typeof import('koffi');
      return Boolean(koffi.load(libraryPath).func('SteamAPI_IsSteamRunning', 'bool', [])());
    },
  };
}

// Steam starts before the window: a packaged build of a real App ID that Steam didn't launch quits at
// once, so Steam can launch it properly (restartAppIfNecessary).
steam = startSteam({
  appId: config.steamAppId,
  // Inside app.asar in packaged builds: steamworks-ffi-node looks in app.asar.unpacked itself.
  sdkDir: path.join(appRoot, 'steamworks_sdk'),
  isPackaged: app.isPackaged,
  platform: process.platform,
  env,
  load: loadSteamworks,
});
const overlay = steam.client ? chooseOverlay(config.steamOverlay, process.platform, env) : 'none';
diagnostics.record({ kind: 'steam', state: steam.state, appId: config.steamAppId, overlay, message: steam.message });
if (steam.state === 'restarting') app.exit(0);

// Plugins load in the background from the start; a call from the game waits for its plugin.
const plugins = createPluginHost(
  appRoot,
  config.plugins,
  (url) => import(url),
  (plugin, message) => diagnostics.record({ kind: 'plugin-error', plugin, message }),
);

if (smoke) {
  // Backstop: end the run even if the page never loads, and report that as a failure, not a pass.
  setTimeout(() => {
    if (!pageLoaded) {
      diagnostics.record({ kind: 'load-failed', url: gameEntry, code: 0, description: LOAD_TIMEOUT_DESCRIPTION });
    }
    finishSmoke(0);
  }, (smokeSeconds + LOAD_BACKSTOP_EXTRA_SECONDS) * 1000);
}

// Everything below must happen before the app is ready.
for (const [name, value] of chromiumSwitches(process.platform)) app.commandLine.appendSwitch(name, value);
// Electron names the save folder after the app name the first time something asks for it, so pin it
// to the file-safe productName from package.json ("Moon- Rising") before setName switches to the
// display name ("Moon: Rising" isn't a valid folder name on Windows).
app.setPath('userData', userDataDir(env, app.getPath('appData'), app.getName()));
app.setName(config.name);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

const dirCache = new Map<string, string[]>();
function listDir(dir: string): string[] {
  let entries = dirCache.get(dir);
  if (!entries) {
    entries = fs.readdirSync(dir);
    dirCache.set(dir, entries);
  }
  return entries;
}

function notFound(url: string): Response {
  diagnostics.record({ kind: 'missing-file', url });
  return new Response('Not found', { status: 404 });
}

async function serve(request: Request): Promise<Response> {
  const parts = requestParts(request.url);
  if (!parts) return new Response('Forbidden', { status: 403 });
  // Only files under app://game/ exist: other hosts and the game folder itself are 404s.
  if (!isGameUrl(request.url) || parts.length === 0) return notFound(request.url);
  // Packaged games are read from an asar archive, where names are case-sensitive on every OS,
  // so a wrong-case path is a 404 here too, even on disks that would match it.
  const actual = caseMismatch(gameRoot, parts, listDir);
  if (actual) {
    diagnostics.record({ kind: 'case-mismatch', url: request.url, actual });
    return notFound(request.url);
  }
  const file = path.join(gameRoot, ...parts);
  let size: number;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return notFound(request.url);
    size = stat.size;
  } catch {
    return notFound(request.url);
  }
  const plan = planFileResponse(size, request.headers.get('range'), mimeType(file));
  const body =
    plan.body === null ? null : (Readable.toWeb(fs.createReadStream(file, plan.body === 'whole' ? {} : plan.body)) as ReadableStream);
  return new Response(body, { status: plan.status, headers: { ...plan.headers, ...CROSS_ORIGIN_ISOLATION_HEADERS } });
}

function registerSaves(store: SaveStore): void {
  ipcMain.handle('gameshipper:saves', (event, op: unknown, slot: unknown, data: unknown) =>
    callSaveStore(store, event.senderFrame?.url, op, slot, data),
  );
}

/** window.steam, and on a Steam Deck Steam's on-screen keyboard over the game's text fields. */
function registerSteam(): void {
  const deck = isSteamDeck(env);
  const client = steam?.client ?? null;
  const api = createSteamApi({
    client,
    isSteamDeck: deck,
    warn: (message) => diagnostics.record({ kind: 'console', level: 'warning', message, source: '', line: 0 }),
  });
  steamApi = api;
  ipcMain.handle('gameshipper:steam', (event, op: unknown, args: unknown) => api.call(event.senderFrame?.url, op, args));
  if (!client || !deck) return;
  const keyboard = (event: Electron.IpcMainEvent, show: () => void): void => {
    if (!isGameUrl(event.senderFrame?.url)) return;
    try {
      show();
    } catch (e) {
      const message = `Couldn't use Steam's on-screen keyboard: ${errorText(e)}`;
      diagnostics.record({ kind: 'console', level: 'warning', message, source: '', line: 0 });
    }
  };
  ipcMain.on('gameshipper:text-focus', (event, info: unknown) =>
    keyboard(event, () => {
      const args = floatingKeyboardArgs(info);
      if (args) client.utils.showFloatingGamepadTextInput(...args);
    }),
  );
  ipcMain.on('gameshipper:text-blur', (event) => keyboard(event, () => client.utils.dismissFloatingGamepadTextInput()));
}

function registerPlugins(host: PluginHost): void {
  ipcMain.handle('gameshipper:plugin', (event, name: unknown, fn: unknown, args: unknown) => host.call(event.senderFrame?.url, name, fn, args));
}

function watchRemoteRequests(): void {
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  session.defaultSession.webRequest.onCompleted(filter, (d) =>
    diagnostics.record({ kind: 'remote-request', url: d.url, status: d.statusCode, error: null }),
  );
  session.defaultSession.webRequest.onErrorOccurred(filter, (d) =>
    diagnostics.record({ kind: 'remote-request', url: d.url, status: null, error: d.error }),
  );
}

function restrictPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(isPermissionAllowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => isPermissionAllowed(permission));
}

/** A frame's origin, or null when it's unknown or gone (a WebFrameMain throws once its frame is disposed). */
function originOf(frame: WebFrameMain | null | undefined): string | null {
  try {
    return frame?.origin ?? null;
  } catch {
    return null;
  }
}

/** The origins of every frame in the window, the main frame included. */
function frameOrigins(wc: WebContents): string[] {
  try {
    return wc.mainFrame.framesInSubtree.map((frame) => frame.origin);
  } catch {
    return [];
  }
}

/**
 * The window only ever shows the game. Web, mail and Steam links the game itself asked for (`from` is the
 * origin of the frame that asked) go to the system instead; everything else is only recorded.
 */
function leaveGame(url: string, from: string | null): void {
  const external = leaveAction(url, from) === 'open-external';
  diagnostics.record({ kind: 'blocked-navigation', url, action: external ? 'opened-externally' : 'blocked' });
  // Smoke runs are automated, so they only note the link.
  if (external && !smoke) {
    shell.openExternal(url).catch((e: unknown) =>
      diagnostics.record({ kind: 'console', level: 'warning', message: `Couldn't open ${url}: ${errorText(e)}`, source: '', line: 0 }),
    );
  }
}

/**
 * Loads the game page; true once it has loaded. A failed load is recorded by did-fail-load, so the
 * rejection is only caught: left unhandled, it would end a smoke run as a crash.
 */
function loadGame(win: BrowserWindow): Promise<boolean> {
  return win.loadURL(gameEntry).then(
    () => true,
    () => false,
  );
}

/** will-navigate and will-redirect: the game window stays on the game. `initiator` is the frame that asked. */
function keepInGame(details: { url: string; isMainFrame: boolean; initiator?: WebFrameMain | null; preventDefault(): void }): void {
  if (!details.isMainFrame || navigationAction(details.url) === 'allow') return;
  details.preventDefault();
  leaveGame(details.url, originOf(details.initiator));
}

function createWindow(pluginManifest: Record<string, string[]>): BrowserWindow {
  const iconFile = path.join(__dirname, 'icon.png');
  const win = new BrowserWindow({
    title: config.name,
    width: config.window.width,
    height: config.window.height,
    resizable: config.window.resizable,
    fullscreen: isSteamDeck(env) || (config.window.fullscreen && env.GAMESHIPPER_WINDOWED !== '1'),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    icon: process.platform === 'linux' && fs.existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The sandboxed preload can't read files, so it gets the plugin list on its command line. `check` also has
      // it count the game's gamepad use (PROBE_ARG; see the end of preload.ts).
      additionalArguments: [`--gameshipper-plugins=${encodeURIComponent(JSON.stringify(pluginManifest))}`, ...(capture.probeDir ? [PROBE_ARG] : [])],
    },
  });
  const wc = win.webContents;
  wc.on('console-message', (details) =>
    diagnostics.record({
      kind: 'console',
      level: details.level,
      message: details.message,
      source: details.sourceId,
      line: details.lineNumber,
    }),
  );
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    const failure = classifyLoadFailure(code, isMainFrame);
    if (failure === 'fatal') diagnostics.record({ kind: 'load-failed', url, code, description });
    // Smoke runs report failed iframes (e.g. ones blocked by cross-origin isolation) as warnings.
    else if (failure === 'frame-failed' && smoke) {
      const message = `Embedded frame failed to load: ${url} (${description})`;
      diagnostics.record({ kind: 'console', level: 'warning', message, source: '', line: 0 });
    }
  });
  wc.on('render-process-gone', (_event, details) => diagnostics.record({ kind: 'crashed', reason: details.reason }));
  wc.on('before-input-event', (event, input) => {
    if (isFullscreenToggle(input)) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  wc.on('will-navigate', keepInGame);
  wc.on('will-redirect', keepInGame);
  // Some navigations (such as to about:blank) never fire will-navigate. did-navigate reports
  // every main-frame page that actually loads (not ones blocked above), so any page that isn't
  // the game is replaced by the game again, unless the game keeps leaving, which would reload it forever.
  let lastReturn: number | null = null;
  let stoppedReturning = false;
  wc.on('did-navigate', (_event, url) => {
    // fixViewport shows about:blank on purpose, before the game has loaded.
    if (isGameUrl(url) || stoppedReturning || fixingViewport) return;
    const now = Date.now();
    if (!returnToGame(lastReturn, now)) {
      stoppedReturning = true;
      diagnostics.record({ kind: 'blocked-navigation', url, action: 'blocked' });
      const message = 'The game keeps navigating away; stopped returning to it.';
      diagnostics.record({ kind: 'console', level: 'warning', message, source: '', line: 0 });
      return;
    }
    lastReturn = now;
    // Nothing says who sent the window here, so nothing is opened outside the game.
    leaveGame(url, null);
    // Clearing history afterwards keeps Back from leading to the page the game left for.
    void loadGame(win).then((loaded) => {
      if (loaded && !win.isDestroyed()) wc.navigationHistory.clear();
    });
  });
  // Never a new window: the game's own links open in the system, and other frames' links are blocked.
  wc.setWindowOpenHandler(({ url }) => {
    leaveGame(url, newWindowSource(frameOrigins(wc)));
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

/** Gives the Steam overlay frames to draw on (overlay.ts says why each OS differs). */
function attachOverlay(win: BrowserWindow): void {
  const client = steam?.client;
  if (!client) return;
  if (overlay === 'repaint') startRepaint(win);
  if (overlay === 'native') {
    win.webContents.once('did-finish-load', () => {
      // steamworks-ffi-node says why it couldn't only through its logger.
      const reasons: string[] = [];
      let reason: string | null;
      try {
        const added = withSteamErrors(loadSteamworks().logger, reasons, () => client.addElectronSteamOverlay(win, { title: config.name, fps: 60 }));
        reason = added ? null : reasons.join(' ') || "steamworks-ffi-node couldn't create its overlay window";
      } catch (e) {
        reason = `its overlay window failed to start: ${errorText(e)}`;
      }
      if (reason) diagnostics.record({ kind: 'steam-overlay', enabled: false, reason });
    });
  }
}

/** How long one capture step (a screenshot, fixing the page size, one measurement) may take. */
const CAPTURE_STEP_MS = 5000;
/** How long the end of a smoke run waits for screenshots still being taken. */
const SCREENSHOTS_WAIT_MS = 10_000;
/** Longest text of a problem a `check` run's probe reports. */
const MAX_PROBE_ERROR_CHARS = 500;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `check`: every request that isn't for the game's own files fails, and is recorded (capture.ts isAllowedOffline). */
function blockInternet(): void {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isAllowedOffline(details.url)) {
      callback({});
      return;
    }
    diagnostics.record({ kind: 'blocked-request', url: details.url });
    callback({ cancel: true });
  });
}

/** Set while the window shows about:blank to fix the page's size (fixViewport), before the game has loaded. */
let fixingViewport = false;
/** Why the page's size couldn't be fixed, for `check`'s probe. */
const captureErrors: string[] = [];

/**
 * Lays the page out at `size` from before the game's first script runs, so a game that reads the window size once
 * at start-up gets it too. DevTools commands only answer once the window has loaded a page, so it loads
 * about:blank first. Never throws: without it the game runs at the window's size, and the run says why.
 */
async function fixViewport(win: BrowserWindow, camera: PageCamera, size: Size): Promise<void> {
  fixingViewport = true;
  try {
    await withTimeout(win.loadURL('about:blank'), CAPTURE_STEP_MS, 'loading about:blank');
    await withTimeout(camera.fixViewport(size), CAPTURE_STEP_MS, 'fixing the page size');
  } catch (e) {
    const message = `Couldn't lay the page out at ${size.width}x${size.height}: ${errorText(e)}`;
    captureErrors.push(message.slice(0, MAX_PROBE_ERROR_CHARS));
    diagnostics.record({ kind: 'console', level: 'warning', message, source: '', line: 0 });
  } finally {
    fixingViewport = false;
  }
}

let screenshotQueue: Promise<void> = Promise.resolve();

/** Saves a 1920x1080 PNG into `dir`. Queued, so two captures never overlap. */
function takeScreenshot(camera: PageCamera, dir: string): Promise<void> {
  screenshotQueue = screenshotQueue.then(async () => {
    try {
      const png = await withTimeout(camera.capture(SCREENSHOT_SIZE), CAPTURE_STEP_MS, 'taking the screenshot');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, screenshotFileName());
      fs.writeFileSync(file, png);
      diagnostics.record({ kind: 'screenshot', file, width: SCREENSHOT_SIZE.width, height: SCREENSHOT_SIZE.height });
    } catch (e) {
      diagnostics.record({ kind: 'screenshot-failed', error: errorText(e) });
    }
  });
  return screenshotQueue;
}

/** F12 saves a store screenshot, and `play --screenshot` takes them at set times. Only `play` asks for either. */
function enableScreenshots(win: BrowserWindow, camera: PageCamera): void {
  const dir = capture.screenshotDir;
  if (!dir) return;
  win.webContents.on('before-input-event', (event, input) => {
    if (!isScreenshotKey(input)) return;
    event.preventDefault();
    void takeScreenshot(camera, dir);
  });
  win.webContents.once('did-finish-load', () => {
    for (const seconds of capture.screenshotAt ?? []) setTimeout(() => void takeScreenshot(camera, dir), seconds * 1000);
  });
}

/** What `check` needs from the running game: its last frame, its layout, and whether it read a gamepad. */
async function runProbe(wc: WebContents, camera: PageCamera, dir: string): Promise<ProbeReport> {
  const report: ProbeReport = { viewport: camera.viewport, frame: null, layout: null, counters: null, errors: [...captureErrors] };
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await withTimeout(fn(), CAPTURE_STEP_MS, what);
    } catch (e) {
      report.errors.push(`${what}: ${errorText(e)}`.slice(0, MAX_PROBE_ERROR_CHARS));
      return null;
    }
  };
  const png = await attempt('capturing the frame', () => camera.capture(camera.viewport ?? DECK_SIZE));
  if (png) {
    await attempt('saving the frame', async () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'frame.png'), png);
      report.frame = path.join(dir, 'frame.png');
    });
  }
  // The page answers with plain data, but it may have replaced the functions the probe uses: clean it.
  report.layout = cleanLayout(await attempt('measuring the page', () => wc.executeJavaScript(`(${layoutProbe.toString()})()`) as Promise<unknown>));
  report.counters = cleanCounters(await attempt('reading the gamepad counters', () => wc.executeJavaScript(READ_COUNTERS_JS) as Promise<unknown>));
  return report;
}

/**
 * How a `check` run ends: its window closes as when a player closes it, so the exit code shows whether the game
 * quits (window-all-closed → quit → will-quit shuts Steam down → exit code 0). A game still running
 * QUIT_TIMEOUT_MS later (a beforeunload handler that returns a value keeps the window open, say) is stopped with
 * QUIT_TIMEOUT_EXIT_CODE; Steam is told first, as app.exit() skips will-quit.
 */
function closeLikeAPlayer(win: BrowserWindow): void {
  setTimeout(() => void stopSteam().finally(() => app.exit(QUIT_TIMEOUT_EXIT_CODE)), QUIT_TIMEOUT_MS);
  win.close();
}

/**
 * The end of a smoke run that ran its full length: screenshots still being taken finish, and a `check` run
 * measures the game, then closes its window like a player. finishSmoke does the rest.
 */
async function endSmoke(win: BrowserWindow, camera: PageCamera): Promise<void> {
  if (smokeDone) return;
  await withTimeout(screenshotQueue, SCREENSHOTS_WAIT_MS, 'the screenshots').catch(() => undefined);
  const dir = capture.probeDir;
  if (!dir || win.isDestroyed()) {
    finishSmoke(0);
    return;
  }
  probeReport = await runProbe(win.webContents, camera, dir);
  finishSmoke(0, win);
}

function armSmokeTest(win: BrowserWindow, camera: PageCamera): void {
  const wc = win.webContents;
  const runFullDuration = (): void => {
    if (pageLoaded) return;
    pageLoaded = true;
    setTimeout(() => void endSmoke(win, camera), smokeSeconds * 1000);
  };
  wc.on('did-finish-load', runFullDuration);
  wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    const failure = classifyLoadFailure(code, isMainFrame);
    if (failure === 'fatal') setTimeout(() => finishSmoke(0), 500);
    else if (failure === 'stopped') runFullDuration();
  });
  // A game that closes its own window (window.close()) still gets a summary.
  win.on('closed', () => finishSmoke(0));
}

app.on('window-all-closed', () => app.quit());
// Steam sees the game as closed only once it shuts down its connection.
app.on('will-quit', (event) => {
  if (!steamApi?.pendingCalls()) {
    steam?.stop();
    return;
  }
  // Let the game's last Steam calls finish first; app.exit() then quits without coming back here.
  event.preventDefault();
  void stopSteam().finally(() => app.exit(0));
});

void app.whenReady().then(async () => {
  // Steam is launching the game again; this copy only waits to exit.
  if (steam?.state === 'restarting') return;
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null,
  );
  protocol.handle('app', serve);
  restrictPermissions();
  registerSaves(createSaveStore(path.join(app.getPath('userData'), 'saves')));
  registerSteam();
  registerPlugins(plugins);
  watchRemoteRequests();
  if (capture.offline) blockInternet();
  const win = createWindow(plugins.manifest());
  const camera = new PageCamera(win.webContents);
  // First, before anything waits for the game's page to load: fixing the size shows about:blank.
  if (capture.viewport) await fixViewport(win, camera, capture.viewport);
  attachOverlay(win);
  enableScreenshots(win, camera);
  if (smoke) armSmokeTest(win, camera);
  void loadGame(win).then((loaded) => {
    // Back from the game's first page mustn't lead to the about:blank that fixed its size.
    if (loaded && capture.viewport && !win.isDestroyed()) win.webContents.navigationHistory.clear();
  });
});
