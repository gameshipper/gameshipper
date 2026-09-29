import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { createDiagnostics, writeSummary } from './diagnostics.js';
import { chromiumSwitches } from './flags.js';
import { isFullscreenToggle } from './keys.js';
import { mimeType } from './mime.js';
import { caseMismatch, requestParts } from './paths.js';
import { classifyLoadFailure, isGameUrl, isPermissionAllowed, navigationAction } from './policy.js';
import { planFileResponse } from './range.js';
import { entryUrl, readRuntimeConfig } from './runtime-config.js';
import { callSaveStore, createSaveStore, type SaveStore } from './saves.js';

const env = process.env;
const diagnostics = createDiagnostics(env.GAMESHIPPER_LOG ?? null);
const smokeSeconds = Number(env.GAMESHIPPER_SMOKE_SECONDS ?? '0');
const smoke = smokeSeconds > 0;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// A smoke run always ends with a summary or a non-zero exit code; it never hangs.
let smokeDone = false;
function finishSmoke(code: number): void {
  if (smokeDone) return;
  if (env.GAMESHIPPER_SMOKE_OUT) {
    try {
      writeSummary(env.GAMESHIPPER_SMOKE_OUT, diagnostics.summary());
    } catch (e) {
      process.stderr.write(`Gameshipper: couldn't write the smoke summary: ${errorText(e)}\n`);
      app.exit(code || 1);
      return;
    }
  }
  smokeDone = true;
  app.exit(code);
}

if (smoke) {
  // Registered before anything that can throw (like reading config.json). Having a listener
  // also stops Electron from showing its modal error dialog, which would block the run.
  const onFatal = (error: unknown): void => {
    diagnostics.record({ kind: 'crashed', reason: `main process error: ${errorText(error)}` });
    finishSmoke(1);
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  setTimeout(() => finishSmoke(0), (smokeSeconds + 30) * 1000);
}

// Unpackaged (play) runs would otherwise log a CSP warning that says nothing about the game.
env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const config = readRuntimeConfig(path.join(__dirname, 'config.json'));
const gameRoot = path.join(__dirname, '..', 'game');

// Everything below must happen before the app is ready.
for (const [name, value] of chromiumSwitches(process.platform)) app.commandLine.appendSwitch(name, value);
if (env.GAMESHIPPER_USER_DATA) app.setPath('userData', env.GAMESHIPPER_USER_DATA);
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
  return new Response(body, { status: plan.status, headers: plan.headers });
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

/** The window only ever shows the game; web links open in the player's browser instead. */
function leaveGame(url: string): void {
  diagnostics.record({ kind: 'blocked-navigation', url });
  // Smoke runs are automated, so they note the link without opening a browser.
  if (!smoke && navigationAction(url) === 'open-external') void shell.openExternal(url);
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
    if (classifyLoadFailure(code, isMainFrame) === 'fatal') diagnostics.record({ kind: 'load-failed', url, code, description });
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
  wc.setWindowOpenHandler(({ url }) => {
    leaveGame(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

function armSmokeTest(win: BrowserWindow): void {
  const wc = win.webContents;
  let started = false;
  const runFullDuration = (): void => {
    if (started) return;
    started = true;
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
  void win.loadURL(entryUrl(config.entry));
});
