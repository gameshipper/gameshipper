import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
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
import { caseMismatch, requestParts, userDataDir } from './paths.js';
import {
  classifyLoadFailure,
  CROSS_ORIGIN_ISOLATION_HEADERS,
  isGameUrl,
  isPermissionAllowed,
  navigationAction,
  returnToGame,
} from './policy.js';
import { planFileResponse } from './range.js';
import { entryUrl, readRuntimeConfig } from './runtime-config.js';
import { callSaveStore, createSaveStore, type SaveStore } from './saves.js';

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

// A smoke run always ends with a summary or a non-zero exit code; it never hangs.
let smokeDone = false;
/** Set once the page has finished loading (or its load was stopped); the backstop checks it. */
let pageLoaded = false;
function finishSmoke(code: number): void {
  if (smokeDone) return;
  smokeDone = true;
  let exitCode = code;
  if (env.GAMESHIPPER_SMOKE_OUT) {
    try {
      writeSummary(env.GAMESHIPPER_SMOKE_OUT, diagnostics.summary());
    } catch (e) {
      process.stderr.write(`Gameshipper: couldn't write the smoke summary: ${errorText(e)}\n`);
      exitCode = code || 1;
    }
  }
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
const gameRoot = path.join(__dirname, '..', 'game');
const gameEntry = entryUrl(config.entry);

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

/** The window only ever shows the game; web, mail and Steam links go to the system instead. */
function leaveGame(url: string): void {
  const external = navigationAction(url) === 'open-external';
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

function keepInGame(details: { url: string; isMainFrame: boolean; preventDefault(): void }): void {
  if (!details.isMainFrame || navigationAction(details.url) === 'allow') return;
  details.preventDefault();
  leaveGame(details.url);
}

function createWindow(): BrowserWindow {
  const iconFile = path.join(__dirname, 'icon.png');
  const win = new BrowserWindow({
    title: config.name,
    width: config.window.width,
    height: config.window.height,
    resizable: config.window.resizable,
    fullscreen: env.SteamDeck === '1' || (config.window.fullscreen && env.GAMESHIPPER_WINDOWED !== '1'),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    icon: process.platform === 'linux' && fs.existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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
    leaveGame(url);
    // Clearing history afterwards keeps Back from leading to the page the game left for.
    void loadGame(win).then((loaded) => {
      if (loaded && !win.isDestroyed()) wc.navigationHistory.clear();
    });
  });
  wc.setWindowOpenHandler(({ url }) => {
    leaveGame(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  return win;
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

void app.whenReady().then(() => {
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null,
  );
  protocol.handle('app', serve);
  restrictPermissions();
  registerSaves(createSaveStore(path.join(app.getPath('userData'), 'saves')));
  watchRemoteRequests();
  const win = createWindow();
  if (smoke) armSmokeTest(win);
  void loadGame(win);
});
