import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { createDiagnostics } from './diagnostics.js';
import { chromiumSwitches } from './flags.js';
import { isFullscreenToggle } from './keys.js';
import { mimeType } from './mime.js';
import { caseMismatch, requestParts } from './paths.js';
import { entryUrl, readRuntimeConfig } from './runtime-config.js';
import { createSaveStore, type SaveStore } from './saves.js';

const env = process.env;
const config = readRuntimeConfig(path.join(__dirname, 'config.json'));
const gameRoot = path.join(__dirname, '..', 'game');
const diagnostics = createDiagnostics(env.GAMESHIPPER_LOG ?? null);
const smokeSeconds = Number(env.GAMESHIPPER_SMOKE_SECONDS ?? '0');

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
  if (new URL(request.url).host !== 'game' || parts.length === 0) return notFound(request.url);
  const actual = caseMismatch(gameRoot, parts, listDir);
  if (actual) diagnostics.record({ kind: 'case-mismatch', url: request.url, actual });
  const file = path.join(gameRoot, ...parts);
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
    return new Response(body, { headers: { 'content-type': mimeType(file), 'content-length': String(stat.size) } });
  } catch {
    return notFound(request.url);
  }
}

function registerSaves(store: SaveStore): void {
  // Slots are passed through unconverted: the store rejects anything that isn't a valid slot string.
  ipcMain.handle('gameshipper:saves', async (_event, op: unknown, slot: unknown, data: unknown) => {
    switch (op) {
      case 'save':
        return store.save(slot as string, data);
      case 'load':
        return store.load(slot as string);
      case 'list':
        return store.list();
      case 'delete':
        return store.delete(slot as string);
      default:
        throw new Error(`Unknown saves operation: ${String(op)}`);
    }
  });
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
  wc.on('did-fail-load', (_event, code, description, url) => diagnostics.record({ kind: 'load-failed', url, code, description }));
  wc.on('render-process-gone', (_event, details) => diagnostics.record({ kind: 'crashed', reason: details.reason }));
  wc.on('before-input-event', (event, input) => {
    if (isFullscreenToggle(input)) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

function armSmokeTest(win: BrowserWindow): void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (env.GAMESHIPPER_SMOKE_OUT) fs.writeFileSync(env.GAMESHIPPER_SMOKE_OUT, JSON.stringify(diagnostics.summary(), null, 2));
    app.exit(0);
  };
  win.webContents.once('did-finish-load', () => setTimeout(finish, smokeSeconds * 1000));
  win.webContents.once('did-fail-load', () => setTimeout(finish, 500));
  setTimeout(finish, (smokeSeconds + 30) * 1000);
}

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(() => {
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null,
  );
  protocol.handle('app', serve);
  registerSaves(createSaveStore(path.join(app.getPath('userData'), 'saves')));
  watchRemoteRequests();
  const win = createWindow();
  if (smokeSeconds > 0) armSmokeTest(win);
  void win.loadURL(entryUrl(config.entry));
});
