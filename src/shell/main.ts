import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell, type WebContents, type WebFrameMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { floatingKeyboardArgs } from './deck-keyboard.js';
import {
  createDiagnostics,
  LOAD_BACKSTOP_EXTRA_SECONDS,
  LOAD_TIMEOUT_DESCRIPTION,
  mainProcessErrorReason,
  writeSummary,
} from './diagnostics.js';
import { chromiumSwitches } from './flags.js';
import { isFullscreenToggle } from './keys.js';
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
import { planFileResponse } from './range.js';
import { entryUrl, readRuntimeConfig } from './runtime-config.js';
import { callSaveStore, createSaveStore, type SaveStore } from './saves.js';
import { createSteamApi } from './steam-api.js';
import { isSteamDeck, startSteam, type SteamSession, type SteamworksLoad } from './steam.js';

const env = process.env;
const diagnostics = createDiagnostics(env.GAMESHIPPER_LOG ?? null);
const smokeSeconds = Number(env.GAMESHIPPER_SMOKE_SECONDS ?? '0');
const smoke = smokeSeconds > 0;

const errorText = (e: unknown): string => {
  try {
    return e instanceof Error ? e.message : String(e);
  } catch {
    return '(unprintable value)';
  }
};

/** Set once Steam has been started (below); a smoke run that fails before that has none. */
let steam: SteamSession | null = null;

// A smoke run always ends with a summary or a non-zero exit code; it never hangs.
let smokeDone = false;
/** Set once the page has finished loading (or its load was stopped); the backstop checks it. */
let pageLoaded = false;
function finishSmoke(code: number): void {
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
      writeSummary(env.GAMESHIPPER_SMOKE_OUT, diagnostics.summary());
    } catch (e) {
      process.stderr.write(`Gameshipper: couldn't write the smoke summary: ${errorText(e)}\n`);
      exitCode = code || 1;
    }
  }
  // app.exit() skips will-quit, so Steam is told here that the game closed.
  steam?.stop();
  app.exit(exitCode);
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
  const api = createSteamApi({ client, isSteamDeck: deck });
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
      // The sandboxed preload can't read files, so it gets the plugin list on its command line.
      additionalArguments: [`--gameshipper-plugins=${encodeURIComponent(JSON.stringify(pluginManifest))}`],
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
    if (isGameUrl(url) || stoppedReturning) return;
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
      try {
        client.addElectronSteamOverlay(win, { title: config.name, fps: 60 });
      } catch (e) {
        const message = `Couldn't start the Steam overlay window: ${errorText(e)}`;
        diagnostics.record({ kind: 'console', level: 'warning', message, source: '', line: 0 });
      }
    });
  }
}

function armSmokeTest(win: BrowserWindow): void {
  const wc = win.webContents;
  const runFullDuration = (): void => {
    if (pageLoaded) return;
    pageLoaded = true;
    setTimeout(() => finishSmoke(0), smokeSeconds * 1000);
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
app.on('will-quit', () => steam?.stop());

void app.whenReady().then(() => {
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
  const win = createWindow(plugins.manifest());
  attachOverlay(win);
  if (smoke) armSmokeTest(win);
  void loadGame(win);
});
