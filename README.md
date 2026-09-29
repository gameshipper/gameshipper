# Gameshipper

Turn any web game folder (three.js, Phaser, PixiJS, Babylon.js, plain canvas) into Windows, Mac and Linux desktop builds you can upload to Steam. Free and open source (MIT). Built so an AI agent can run it end to end.

```bash
npx gameshipper init           # detects your game, writes gameshipper.json
npx gameshipper play           # plays it in the desktop shell
npx gameshipper play --smoke   # runs it for 5 s and reports problems
npx gameshipper build          # out/windows, out/mac, out/linux
npx gameshipper status         # what's configured, built, and what happened last
```

Your game doesn't need a build step or npm. A folder with an `index.html` is enough. Files your game loads from CDNs (three.js from unpkg through an import map, a `<script>` or `<link>` tag, a CSS `@import`) are downloaded into the build, so it works offline. They're pinned in `gameshipper.lock`, so builds are reproducible from it; use `--frozen-lock` in CI to enforce that.

Needs Node.js 22.12 or newer. The first build for each OS downloads Electron (120 to 160 MB, cached after that).

## Commands

### `init`

Detects the game and writes `gameshipper.json`. It finds `index.html` (or the first `.html` file) and an icon at `icon.png`, `art/icon.png`, `assets/icon.png` or `public/icon.png`. Steam needs a square PNG of at least 1024x1024, so an icon that isn't one is left out with an `ICON_UNSUITABLE` warning. If `package.json` has a `build` script and a bundler (Vite, Parcel, webpack, esbuild, Rollup), Gameshipper runs `npm run build` before every `play` and `build` and packages `dist/`. It also adds `.gameshipper/`, `out/` and `.sdk/` to `.gitignore`, creating one if the folder is a git repository without it.

| Flag | |
|---|---|
| `--name <name>` | Game name shown in windows and stores. |
| `--app-id <id>` | Steam App ID (default 480, Valve's test app). |
| `--icon <png\|none>` | Square PNG icon, at least 1024x1024. |
| `--entry <file>` | The game's HTML file (default: detected). |
| `--build-command <cmd>` | Command that builds the game (default: detected). |
| `--output-dir <dir>` | Folder the build command writes. |
| `--force` | Overwrite an existing `gameshipper.json`. |

In a terminal, `init` asks for the name, App ID and icon. With `--yes` or `--json`, or when stdin isn't a terminal, it uses the flags and what it detected instead.

### `play`

Runs the game in the same shell the builds use. The window stays a window even when `gameshipper.json` asks for fullscreen; F11 or Alt+Enter toggles fullscreen. Saves go to `.gameshipper/play-data/`, so testing never touches a real install's saves.

| Flag | |
|---|---|
| `--smoke` | Run for a few seconds, quit, and report errors, missing files, internet use and crashes. |
| `--seconds <n>` | How long a smoke run lasts after the page loads (default 5). Implies `--smoke`. |
| `--fullscreen` | Honour `window.fullscreen` from `gameshipper.json`. |
| `--frozen-lock` | Fail instead of accepting changed or new CDN files; for CI. |
| `--steam-sdk <path>` | Your Steamworks SDK zip or folder (see [Steam](#steam)). |

### `build`

Builds desktop apps into `out/<target>`. For a game named "Spinning Cube" that's `out/windows/Spinning Cube.exe`, `out/mac/Spinning Cube.app` and `out/linux/spinning-cube`. One target failing never stops the others.

| Flag | |
|---|---|
| `--target <list>` | Comma-separated subset of the configured targets, e.g. `--target windows,linux`. |
| `--frozen-lock` | Fail instead of accepting changed or new CDN files; for CI. |
| `--steam-sdk <path>` | Your Steamworks SDK zip or folder (see [Steam](#steam)). |

`targets` defaults to `windows`, `mac` and `linux`. `ios` and `android` can be added to it, but this version skips them with a `TARGET_NOT_YET_SUPPORTED` warning.

### `status`

Shows the config, what this computer can build, the Steamworks SDK builds will use, which `out/` folders exist, and the last result of `init`, `play` and `build` with their log paths. It succeeds for any existing folder, so it's the command to run first.

### `help`

`help` lists the commands, `help <command>` or `<command> --help` shows a command's flags, and `help --json` returns every command, flag and exit code plus the JSON Schema of `gameshipper.json`.

### Global flags

| Flag | |
|---|---|
| `--json` | Print the result as JSON on stdout and nothing else. |
| `--verbose` | Also stream the run log to stderr. |
| `-y`, `--yes` | Never prompt; use detected defaults and flags. |
| `--dir <path>` | Game folder (default: the current folder). |
| `-h`, `--help` | Show help for a command. |
| `-v`, `--version` | Print the Gameshipper version. |

## For AI agents

- Add `--json` to any command: stdout is exactly one JSON object, `{ ok, data, errors[], warnings[], logPath }`. `logPath` is the run's log (for `play` and `build`). Without a valid `gameshipper.json` they write nothing into the folder, so a `CONFIG_MISSING` or `CONFIG_INVALID` result has no `logPath`.
- Every error and warning has a stable `code` and a plain-English `message`. Errors always have a `fix`; warnings have one whenever there's something to do.
- Nothing ever prompts when `--json` or `--yes` is set, or when stdin isn't a terminal. Missing input comes back as `INPUT_REQUIRED`, naming the flag to pass.
- Exit codes: `0` success, `1` a target or check failed, `2` invalid config, usage or missing input. A signal ends the run with an `INTERRUPTED` result and exit code 128 + the signal number (130 for Ctrl+C). Ctrl+C during an interactive `play` just ends the session: an `ok` result with a `PLAY_STOPPED` warning, still exit 130.
- `help --json` returns every command and flag.

The loop: `status --json`, `init --yes --json`, then `play --smoke --json` until it comes back clean (`ok: true`, so no errors; warnings don't block), then `build --json`.

### What `play --smoke` reports

| Code | Level | What happened |
|---|---|---|
| `GAME_CONSOLE_ERROR` | error | The game logged an error or threw, with the file and line. |
| `GAME_FILE_MISSING` | error | The game requested a file that isn't in the build. |
| `GAME_PATH_CASE` | warning | Comes with `GAME_FILE_MISSING` when the file exists with different letter case (`Player.png` vs `player.png`). Builds treat those as different files on every OS, so the request fails everywhere. The fix names the real file. |
| `GAME_LOAD_FAILED` | error | The page failed to load, or never finished loading. |
| `GAME_CRASHED` | error | The game's process crashed. |
| `SMOKE_NO_RESULT`, `SMOKE_TIMEOUT` | error | The game never reported back, or froze and had to be stopped. |
| `GAME_USES_INTERNET` | warning | The game loaded something from the internet while running, so it won't work offline. |
| `GAME_CONSOLE_WARNING` | warning | The game logged a warning. |
| `STEAM_INIT_FAILED` | error | Steam is running but didn't start for the game's App ID (usually one the signed-in account doesn't own). |
| `STEAM_NOT_RUNNING` | warning | Steam isn't running, so `window.steam` was a no-op. |
| `STEAM_OVERLAY_FAILED` | warning | The native overlay window (see [Steam](#steam)) couldn't start, so Shift+Tab shows no overlay. |
| `PLUGIN_LOAD_FAILED` | error | A plugin's module failed to load in the game. |
| `GAME_NAVIGATION_BLOCKED` | warning | The game tried to take its window to a page that isn't the game's, like `about:blank` or `file:`, or an embedded site tried to open a link. Web, mail and `steam:` links the game itself opens aren't reported: they open in the player's browser or app. |

Each code lists at most 10 issues, then one more issue counting the rest. `data.smoke.summary.events` holds the first 100 diagnostic events; `data.smoke.eventsLog` names a JSON-lines file with all of them, including everything the game logged.

Other problems have codes too, such as `CDN_FETCH_FAILED`, `CDN_CHANGED`, `ENTRY_MISSING`, `CONFIG_INVALID`, `ICON_TOO_SMALL`, `ICON_NOT_SQUARE`, `STEAM_SDK_MISSING`, `STEAM_SDK_INVALID`, `STEAM_SDK_CACHE_FAILED`, `PLUGIN_HOOK_FAILED` and `PACKAGE_FAILED` from a build, or `GAME_EXITED` when a game quits with an error during `play`, each with its fix. An icon problem only stops `build`: `play` warns with the same code and uses the default icon.

### Files

| Path | |
|---|---|
| `gameshipper.json` | The config. Commit it. |
| `gameshipper.lock` | The URL and SHA-256 of every downloaded CDN file. Commit it. When a CDN file changes, `build` warns with `CDN_CHANGED` and updates the lock; `--frozen-lock` makes that an error. |
| `out/<target>/` | The builds. |
| `.sdk/` | Your Steamworks SDK zip. Don't commit it (`init` adds it to `.gitignore`). |
| `.gameshipper/logs/` | Run logs (the newest 50 of each command), plus the events logs and smoke summaries of `play` runs (the newest 20). |
| `.gameshipper/last/` | The last result of each command, which `status` reads. |

## `gameshipper.json`

`init` writes every field with its default. The main ones:

```json
{
  "name": "Spinning Cube",
  "version": "1.0.0",
  "game": { "dir": ".", "entry": "index.html", "buildCommand": null, "outputDir": null },
  "icon": "icon.png",
  "targets": ["windows", "mac", "linux"],
  "window": { "width": 1280, "height": 720, "fullscreen": true, "resizable": true },
  "steam": { "appId": 480, "sdk": null, "overlay": "auto" },
  "plugins": []
}
```

Builds start fullscreen when `window.fullscreen` is true, and always on Steam Deck. `npx gameshipper help --json` includes the full schema.

## Saves

Inside Gameshipper builds your game gets `window.gameshipper.saves`, which writes one JSON file per slot, a format Steam Auto-Cloud can sync. In a normal browser it's `undefined`, so use this helper to work in both:

```js
const saves = window.gameshipper?.saves ?? {
  save: async (slot, data) => localStorage.setItem(slot, JSON.stringify(data)),
  load: async (slot) => JSON.parse(localStorage.getItem(slot) ?? 'null'),
  list: async () => Object.keys(localStorage),
  delete: async (slot) => localStorage.removeItem(slot),
};

await saves.save('slot1', { level: 3 });
const progress = await saves.load('slot1'); // null when there's no save
```

Slot names are 1 to 64 letters, numbers, `-` or `_`, and the data must be JSON-serializable. Saves live in the game's folder in the OS app data folder (`~/Library/Application Support/<Name>/saves` on a Mac, `%APPDATA%\<Name>\saves` on Windows, `~/.config/<Name>/saves` on Linux).

## Steam

Your game gets `window.steam` in desktop builds and in `play`. It works with your own copy of Valve's Steamworks SDK; Gameshipper never ships Valve's files itself.

1. Download the Steamworks SDK zip from https://partner.steamgames.com/downloads/list (you need a Steamworks partner login).
2. Put it in your game folder's `.sdk/` folder, e.g. `.sdk/steamworks_sdk_165.zip`. `init` adds `.sdk/` to `.gitignore`: don't commit Valve's files. You can also set `steam.sdk` in gameshipper.json (relative to the game folder), set `GAMESHIPPER_STEAM_SDK`, or pass `--steam-sdk <path>`. Once a build has used an SDK, Gameshipper keeps its libraries in its cache and later projects find them there. The SDK is never copied into the game, whatever it's called and wherever it is.
3. `npx gameshipper status` shows which SDK builds will use. Without one, builds still work (with a `STEAM_SDK_MISSING` warning) and `window.steam.isAvailable()` resolves `false`.

Each build gets only the Steam library its OS needs, copied from your SDK. Nobody needs a `steam_appid.txt`, and none is ever shipped.

```js
if (window.steam && (await steam.isAvailable())) {
  await steam.unlockAchievement('FIRST_WIN');
  await steam.setStat('WINS', 10);                 // saved to Steam right away
  await steam.uploadLeaderboardScore('HIGH_SCORES', 12345);
  const top = await steam.getLeaderboardEntries('HIGH_SCORES', 10);
  await steam.setRichPresence('status', 'Level 3');
  const name = await steam.getUserName();
  steam.activateOverlay('achievements');
}
```

Every method resolves to a harmless value (`false`, `null` or `[]`) when Steam isn't running, so the game never needs to guard each call. Also available: `getSteamId`, `getLanguage`, `isSteamDeck`, `clearAchievement`, `isAchievementUnlocked`, `listAchievements`, `getStat`, `storeStats`, `clearRichPresence`, `activateOverlayWebPage`, and GemShell-style names (`getPersonaName`, `getSteamID`, `getAchievement`, `getStatInt`, `setStatInt`, `getStatFloat`, `setStatFloat`, `requestStats`, `requestStatsAndWait`, `runCallbacks`), so GemShell games need few or no changes. Only the game's own pages can use `window.steam`. `window.steam` and `window.gameshipper` are ordinary globals: a game that has its own `steam` or `gameshipper` (a top-level `const`, `let`, `var`, `function` or `class` in a classic script, or `window.steam = ...`) keeps working, and its own takes the place of Gameshipper's.

- **App ID.** `steam.appId` defaults to 480, Valve's Spacewar test app, which every Steam account can use. With your own App ID, a packaged build started outside Steam asks Steam to launch it (Valve's standard check).
- **Overlay (Shift+Tab).** `steam.overlay` is `"auto"` by default. On macOS that uses a native window that mirrors the game so Steam's overlay can draw on it; on Windows and Linux it keeps a new frame coming 60 times a second. On macOS and Linux this happens only when Steam launched the game, which is when Steam injects its overlay. Set `"native"`, `"repaint"` or `"off"` to override. `play --smoke` warns `STEAM_OVERLAY_FAILED` when the native window couldn't start.
- **Steam Deck.** Steam's on-screen keyboard opens when a text field gets focus, and again when the player taps the field after closing it. Read-only fields get no keyboard.
- **Quitting.** The game waits up to a second for Steam calls still in flight (a leaderboard upload, say) before it disconnects from Steam.
- **Troubleshooting.** `play --smoke --json` reports `STEAM_NOT_RUNNING` (a warning: start Steam) or `STEAM_INIT_FAILED` (an error: usually an App ID the signed-in account doesn't own).

## Plugins

List module paths in `"plugins"` in gameshipper.json. A plugin is one file, or a folder with a package.json `main` or an `index.mjs`:

```js
export default {
  name: 'myplugin',
  // The game calls these as await gameshipper.plugins.myplugin.doThing(arg).
  // They run in Electron's main process with full Node.js access.
  main: { async doThing(arg) { return `did ${arg}`; } },
  // Optional build hooks.
  async beforePackage(ctx) { /* ctx.appDir, ctx.targets, ctx.config, ctx.log() */ },
  async afterPackage(ctx) { /* ctx.target, ctx.outDir, ctx.executable */ },
};
```

Plugin and function names use letters, digits and `_`, and no two plugins may share a name, even in different letter case. A single-file plugin is copied alone, so one that imports other files or packages gets a `PLUGIN_IMPORTS_NOT_COPIED` warning: bundle it into one file or make it a folder plugin. A folder plugin is copied whole by the same rules as the game (no `.env` files, Steamworks SDK, `.git`, `out/` or `node_modules/.bin`); its `main` must be inside the folder, and a link out of the folder fails the build with `PLUGIN_LOAD_FAILED`. A plugin's files are never copied into the game itself. A failing `beforePackage` stops the build (`PLUGIN_HOOK_FAILED`), as does a hook still running after 5 minutes; a failing `afterPackage` fails that target. Only use plugins you trust: they run with the same rights as the game.

## TypeScript

```ts
/// <reference types="gameshipper/types" />
```

This types `window.steam` and `window.gameshipper` (both `undefined` in a normal browser).

## Building from each OS

| Host | Windows | Linux | Mac |
|---|---|---|---|
| macOS | ✓ | ✓ | ✓ universal (Intel and Apple Silicon)¹ |
| Linux | ✓ | ✓ | Apple Silicon only |
| Windows | ✓ | ✓ | ✗ (build on a Mac or Linux) |

Windows and Linux builds are x64. ¹ Universal Mac builds need Apple's command-line tools (`xcode-select --install`); without them the Mac build is Apple Silicon only, with a `MAC_NOT_UNIVERSAL` warning. Mac builds made on a Mac are ad-hoc signed, not notarized.

## Coming in later versions

Store images, `check`, `publish`, Mac signing and notarization, and iOS and Android builds.

## License

MIT
