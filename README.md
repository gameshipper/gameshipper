# Gameshipper

Turn any web game folder (three.js, Phaser, PixiJS, Babylon.js, plain canvas) into Windows, Mac and Linux desktop builds you can upload to Steam, plus Xcode and Android Studio projects for the App Store and Google Play. Free and open source (MIT). Built so an AI agent can run it end to end.

```bash
npx gameshipper init           # detects your game, writes gameshipper.json
npx gameshipper play           # plays it in the desktop shell (F12 saves a store screenshot)
npx gameshipper play --smoke   # runs it for 5 s and reports problems
npx gameshipper build          # out/windows, out/mac, out/linux and the store images in out/store
npx gameshipper check          # launches the build and checks it's ready for Steam and Steam Deck
npx gameshipper status         # what's configured, built, and what happened last
```

Your game doesn't need a build step or npm. A folder with an `index.html` is enough. Files your game loads from CDNs (three.js from unpkg through an import map, a `<script>` or `<link>` tag, a CSS `@import`) are downloaded into the build, so it works offline. They're pinned in `gameshipper.lock`, so builds are reproducible from it; use `--frozen-lock` in CI to enforce that.

Needs Node.js 22.12 or newer. The first build for each OS downloads Electron (120 to 160 MB, cached after that).

## Commands

### `init`

Detects the game and writes `gameshipper.json`. It finds `index.html` (or the first `.html` file), an icon at `icon.png`, `art/icon.png`, `assets/icon.png` or `public/icon.png`, and the art for the [store images](#store-images-and-screenshots) at `art/key-art.png` (or `.jpg`) and `art/logo.png`. Steam needs a square PNG of at least 1024x1024, so an icon that isn't one is left out with an `ICON_UNSUITABLE` warning. If `package.json` has a `build` script and a bundler (Vite, Parcel, webpack, esbuild, Rollup), Gameshipper runs `npm run build` before every `play` and `build` and packages `dist/`. It also adds `.gameshipper/`, `out/` and `.sdk/` to `.gitignore`, creating one if the folder is a git repository without it.

| Flag | |
|---|---|
| `--name <name>` | Game name shown in windows and stores. |
| `--app-id <id>` | Steam App ID (default 480, Valve's test app). |
| `--icon <png\|none>` | Square PNG icon, at least 1024x1024. |
| `--key-art <file\|none>` | Key art for the store images: PNG or JPEG, 3840x2160 recommended. |
| `--logo <png\|none>` | Game logo on a transparent background, for the store images. |
| `--bundle-id <id\|none>` | Bundle ID like `com.yourname.yourgame`. Adds the `ios` and `android` targets (see [iOS and Android](#ios-and-android)). It can never change once the game is in a store. |
| `--entry <file>` | The game's HTML file (default: detected). |
| `--build-command <cmd>` | Command that builds the game (default: detected). |
| `--output-dir <dir>` | Folder the build command writes. |
| `--force` | Overwrite an existing `gameshipper.json`. |

In a terminal, `init` asks for the name, App ID, icon, key art, logo and a bundle ID for iOS and Android. With `--yes` or `--json`, or when stdin isn't a terminal, it uses the flags and what it detected instead.

### `play`

Runs the game in the same shell the builds use. The window stays a window even when `gameshipper.json` asks for fullscreen; F11 or Alt+Enter toggles fullscreen. **F12** saves a 1920x1080 store screenshot to `out/store/screenshots/` (the window flickers while it's taken). Saves go to `.gameshipper/play-data/`, so testing never touches a real install's saves.

| Flag | |
|---|---|
| `--smoke` | Run for a few seconds, quit, and report errors, missing files, internet use and crashes. |
| `--seconds <n>` | How long a smoke run lasts after the page loads (default 5, at most 600). Implies `--smoke`. |
| `--screenshot <s,s,...>` | Save 1920x1080 store screenshots this many seconds after the page loads, then quit, e.g. `--screenshot 5,10,15,20,25`. |
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

`targets` defaults to `windows`, `mac` and `linux`; with `ios` and `android` (which `init --bundle-id` adds) it also writes an Xcode project to `out/ios` and an Android Studio project to `out/android` (see [iOS and Android](#ios-and-android)). On a Mac, the Mac app is signed, and notarized when your Apple credentials are set (see [Mac signing and notarization](#mac-signing-and-notarization)).

Every build also makes the [store images](#store-images-and-screenshots) in `out/store/`, whatever `--target` says.

### `check`

Launches the latest build for this computer once, for 15 seconds (`--seconds` to change), with the network blocked and the page laid out at Steam Deck size (1280x800), then closes its window the way a player would. It also looks at every build and at `out/store/`, and reports 18 checks:

| Group | What |
|---|---|
| Offline | nothing is loaded from the internet (every blocked address is listed) |
| Launch | it starts, has no console errors or missing files, draws a non-uniform frame (with a warning when it's mostly one colour, like a loading screen), and exits with code 0 when its window closes; builds for other operating systems are listed as built, not launched here |
| Steam Deck | at 1280x800 nothing is cut off, no text runs past the screen edge and no scrollbars appear; it reads a gamepad (while running, or in its own code: engine and library files aren't searched); text fields are listed |
| Review | a build for every desktop target, no `steam_appid.txt`, the Mac build signed and notarized, a custom icon, your own App ID |
| Store | all eight images at their exact sizes and newer than the key art and logo, at least five 1920x1080 screenshots, and reminders about the trailer and Steam's AI disclosure |

Run it after `build`: it never builds anything itself. The Deck-size frame is saved as `.gameshipper/check/frame.png` and the full report as `.gameshipper/check/report.json`. Without Apple credentials a Mac build is only ad-hoc signed, so on a Mac `review.mac-signing` fails with `CHECK_MAC_NOT_NOTARIZED` until you [sign and notarize](#mac-signing-and-notarization) it.

The network block stops the game's requests (each is listed in `offline.requests`) and its WebRTC connections (not listed). It doesn't cover WebTransport, or networking a [plugin](#plugins) does in Electron's main process: `offline.requests` never sees those.

| Flag | |
|---|---|
| `--seconds <n>` | How long the game runs with the network blocked (default 15, at most 600). |

### `status`

Shows the config, what this computer can build, the Steamworks SDK builds will use, which `out/` folders exist, and the last result of `init`, `play`, `build` and `check` with their log paths. It succeeds for any existing folder, so it's the command to run first.

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

- Add `--json` to any command: stdout is exactly one JSON object, `{ ok, data, errors[], warnings[], logPath }`. `logPath` is the run's log (for `play`, `build` and `check`). Without a valid `gameshipper.json` they write nothing into the folder, so a `CONFIG_MISSING` or `CONFIG_INVALID` result has no `logPath`.
- Every error and warning has a stable `code` and a plain-English `message`. Errors always have a `fix`; warnings have one whenever there's something to do.
- Nothing ever prompts when `--json` or `--yes` is set, or when stdin isn't a terminal. Missing input comes back as `INPUT_REQUIRED`, naming the flag to pass.
- Exit codes: `0` success, `1` a target or check failed, `2` invalid config, usage or missing input. A signal ends the run with an `INTERRUPTED` result and exit code 128 + the signal number (130 for Ctrl+C). Ctrl+C during an interactive `play` just ends the session: an `ok` result with a `PLAY_STOPPED` warning, still exit 130.
- `help --json` returns every command and flag.
- `check --json` returns 18 checks, each with a stable `id`, a `status` (`pass`, `warn`, `fail`, `info` or `skip`) and, for `warn` and `fail`, a `code` and a `fix`. Every failed check is also an error in `errors`, and every warning in `warnings`, so exit code 1 means at least one check failed. Open `data.deckScreenshot` to see what the game showed at Steam Deck size.
- `play --screenshot 5,10,15,20,25 --json` saves store screenshots without a person; `data.screenshots` lists them. They show whatever the game shows without input, so look at them before you upload them.

The loop: `status --json`, `init --yes --json`, then `play --smoke --json` until it comes back clean (`ok: true`, so no errors; warnings don't block), then `build --json`, then `check --json` until nothing fails that you can fix.

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
| `SCREENSHOT_FAILED` | warning | A screenshot couldn't be saved. With `--screenshot` it's also an error when fewer were saved than asked for. |
| `GAME_NAVIGATION_BLOCKED` | warning | The game tried to take its window to a page that isn't the game's, like `about:blank` or `file:`, or an embedded site tried to open a link. Web, mail and `steam:` links the game itself opens aren't reported: they open in the player's browser or app. But while the page has an embedded frame from another site, or one that failed to load, the game's own `window.open()` and `target="_blank"` links are blocked too, because Electron can't tell which frame opened a window. |

Each code lists at most 10 issues, then one more issue counting the rest. `data.smoke.summary.events` holds the first 100 diagnostic events; `data.smoke.eventsLog` names a JSON-lines file with all of them, including everything the game logged.

Other problems have codes too, such as `CDN_FETCH_FAILED`, `CDN_CHANGED`, `ENTRY_MISSING`, `CONFIG_INVALID`, `ICON_TOO_SMALL`, `ICON_NOT_SQUARE`, `STEAM_SDK_MISSING`, `STEAM_SDK_INVALID`, `STEAM_SDK_CACHE_FAILED` (Gameshipper's cache can't be written), `STEAM_NATIVE_DOWNLOAD_FAILED` (another OS's native Steam bridge couldn't be downloaded), `STEAM_UNSUPPORTED_PLATFORM` (a warning: Steam has no libraries for that OS and CPU, like arm64 Linux, so it runs without Steam), `PLUGIN_LOAD_FAILED`, `PLUGIN_IMPORTS_NOT_COPIED` (a warning, see [Plugins](#plugins)), `PLUGIN_HOOK_FAILED` and `PACKAGE_FAILED` from a build, or `GAME_EXITED` when a game quits with an error during `play`, each with its fix. An icon problem only stops `build`: `play` warns with the same code and uses the default icon.

### What `check` reports

| Check | Not met | Code |
|---|---|---|
| `offline.requests` | fail | `CHECK_OFFLINE` |
| `launch.run` | fail (warn when this computer's OS isn't a target) | `CHECK_NOT_LAUNCHED`, `CHECK_LAUNCH_FAILED` |
| `launch.errors` | warn | `CHECK_GAME_ERRORS` |
| `launch.frame` | fail (warn when the frame is mostly one colour) | `CHECK_BLANK_FRAME`, `CHECK_MOSTLY_BLANK_FRAME` |
| `launch.exit` | fail | `CHECK_EXIT_CODE` |
| `launch.other-os` | info | |
| `deck.layout` | warn (skip when the page couldn't be laid out at 1280x800) | `CHECK_DECK_LAYOUT` |
| `deck.gamepad` | warn | `CHECK_NO_GAMEPAD` |
| `deck.text-input` | always passes; lists text fields | |
| `review.builds` | fail | `CHECK_BUILD_MISSING` |
| `review.steam-appid` | fail | `CHECK_STEAM_APPID_FILE` |
| `review.mac-signing` | fail on a Mac, warn elsewhere | `CHECK_MAC_NOT_NOTARIZED`, `CHECK_MAC_SIGNING_UNKNOWN` |
| `review.icon` | warn | `CHECK_DEFAULT_ICON` |
| `review.app-id` | warn | `CHECK_TEST_APP_ID` |
| `store.images` | fail (also when older than the key art or logo) | `CHECK_STORE_IMAGES` |
| `store.screenshots` | fail | `CHECK_SCREENSHOTS` |
| `store.trailer`, `ai.disclosure` | info | |

A check that couldn't run here is `skip`, and its message says why.

### Environment variables

| Variable | |
|---|---|
| `GAMESHIPPER_CACHE` | Gameshipper's download cache (CDN files, Steamworks SDK libraries, native Steam bridges). Default: the OS's user cache folder. |
| `GAMESHIPPER_STEAM_SDK` | Your Steamworks SDK zip or folder (see [Steam](#steam)). |
| `GAMESHIPPER_NPM_REGISTRY` | The npm registry that other OSes' native Steam bridges (`@koromix/koffi-*`) are downloaded from. Default: `npm_config_registry`, then https://registry.npmjs.org. Downloads are checked against pinned hashes. |
| `GAMESHIPPER_MAC_IDENTITY` | The Developer ID Application identity Mac builds are signed with (see [Mac signing and notarization](#mac-signing-and-notarization)). Unset: ad-hoc signing. |
| `GAMESHIPPER_NOTARY_PROFILE`, `GAMESHIPPER_NOTARY_KEYCHAIN` | The notarytool keychain profile (and, optionally, the keychain holding it) Mac builds are notarized with. |
| `GAMESHIPPER_NOTARY_KEY`, `GAMESHIPPER_NOTARY_KEY_ID`, `GAMESHIPPER_NOTARY_ISSUER` | For CI instead of a profile: an App Store Connect API key (`.p8` path), its ID and its issuer ID. |

`help --json` lists them all under `environment`. Apple credentials are only ever read from these variables and your keychain, never from `gameshipper.json`.

### Files

| Path | |
|---|---|
| `gameshipper.json` | The config. Commit it. |
| `gameshipper.lock` | The URL and SHA-256 of every downloaded CDN file. Commit it. When a CDN file changes, `build` warns with `CDN_CHANGED` and updates the lock; `--frozen-lock` makes that an error. |
| `out/<target>/` | The builds. |
| `out/store/` | The store images; `out/store/screenshots/` holds the screenshots from F12 and `play --screenshot`. |
| `.sdk/` | Your Steamworks SDK zip. Don't commit it (`init` adds it to `.gitignore`). |
| `.gameshipper/logs/` | Run logs (the newest 50 of each command), plus the events logs and smoke summaries of `play` runs (the newest 20). |
| `.gameshipper/last/` | The last result of each command, which `status` reads. |
| `.gameshipper/check/` | The last `check`: `report.json` and the Deck-size `frame.png`. |

## `gameshipper.json`

`init` writes every field with its default. The main ones:

```json
{
  "name": "Spinning Cube",
  "version": "1.0.0",
  "game": { "dir": ".", "entry": "index.html", "buildCommand": null, "outputDir": null },
  "icon": "icon.png",
  "keyArt": "art/key-art.png",
  "logo": "art/logo.png",
  "targets": ["windows", "mac", "linux"],
  "window": { "width": 1280, "height": 720, "fullscreen": true, "resizable": true },
  "steam": { "appId": 480, "sdk": null, "overlay": "auto" },
  "mobile": { "bundleId": null, "orientation": "landscape" },
  "plugins": []
}
```

Builds start fullscreen when `window.fullscreen` is true, and always on Steam Deck. `npx gameshipper help --json` includes the full schema.

## Store images and screenshots

Set `keyArt` (PNG or JPEG, 3840x2160 recommended, at least 1280x720) and `logo` (a PNG with a transparent background) in `gameshipper.json`, or put them at `art/key-art.png` and `art/logo.png` before `init`. Every `build` then writes all eight Steam images to `out/store/`:

| File | Size | |
|---|---|---|
| `header_capsule.png` | 920x430 | key art and logo |
| `small_capsule.png` | 462x174 | key art and logo |
| `main_capsule.png` | 1232x706 | key art and logo |
| `vertical_capsule.png` | 748x896 | key art and logo |
| `library_capsule.png` | 600x900 | key art and logo |
| `library_header.png` | 920x430 | key art and logo |
| `library_hero.png` | 3840x1240 | key art only |
| `library_logo.png` | 1280x720 | the logo on a transparent background |

Crops centre on `keyArtFocus`: `[x, y]` as fractions of the key art's width and height, `[0.5, 0.5]` by default. Transparent parts of the key art come out black. Unusable art fails the build with `KEYART_INVALID` (not a PNG or JPEG), `KEYART_TOO_SMALL`, `LOGO_INVALID` (not a PNG, or fully transparent) or `LOGO_NOT_TRANSPARENT` (exit code 2, like a bad icon); art that had to be enlarged gives `KEYART_LOW_RES` or `LOGO_LOW_RES`; without `keyArt` and `logo`, builds warn `STORE_IMAGES_SKIPPED`. Each build replaces the images in `out/store/`, and one that skips them or fails leaves none there, so `check` never passes old ones.

The key art and logo are left out of the game itself unless one of its HTML, JavaScript, CSS or JSON files mentions the file's name (then the game may show it, so it ships).

Steam needs at least five 1920x1080 gameplay screenshots. Press **F12** during `npx gameshipper play` to save one to `out/store/screenshots/`. It's always exactly 1920x1080, whatever your screen's scaling. F12 only does this in `play`: in your shipped game it stays Steam's screenshot key.

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

In iOS and Android builds `window.gameshipper.saves` works the same way: saves are stored with Capacitor Preferences (UserDefaults / SharedPreferences), which the OS never clears and device backups include. On phones `window.steam` is `undefined` and `gameshipper.plugins` is empty.

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

Plugin and function names use letters, digits and `_`, and no two plugins may share a name, even in different letter case. A single-file plugin is copied alone, so one that imports other files or packages gets a `PLUGIN_IMPORTS_NOT_COPIED` warning: bundle it into one file or make it a folder plugin. A folder plugin is copied with its `node_modules`, except:

- anywhere in it: `.env` and `.env.*` files, `steam_appid.txt`, `.git`, `.DS_Store`, `Thumbs.db`, and the Steamworks SDK (anything named `steamworks_sdk*`, `redistributable_bin`, or a folder holding a `redistributable_bin/`);
- at its top: every dot file and folder (`.npmrc`, `.vscode`, `.github`, ...) and `out/`;
- every `node_modules/.bin`.

Its `main` must be a packaged file inside the folder, and a link out of the folder (or to nothing, or into a loop) fails the build with `PLUGIN_LOAD_FAILED`. A plugin's files are never copied into the game itself. A failing `beforePackage` stops the build (`PLUGIN_HOOK_FAILED`), as does a hook still running after 5 minutes; a failing `afterPackage` fails that target. `afterPackage` runs before the Mac app is signed, so it may still change the app. The hooks run for desktop targets only. Only use plugins you trust: they run with the same rights as the game.

Each `build` and `play` loads plugins afresh. A process that stays running (such as an MCP server) picks up an edited ES module plugin's own entry file, but a CommonJS plugin, and any file a plugin imports, keeps its first-loaded code until that process restarts.

## TypeScript

```ts
/// <reference types="gameshipper/types" />
```

This types `window.steam` and `window.gameshipper` (both `undefined` in a normal browser).

## Building from each OS

| Host | Windows | Linux | Mac | iOS and Android projects |
|---|---|---|---|---|
| macOS | ✓ | ✓ | ✓ universal (Intel and Apple Silicon)¹, signed | ✓ |
| Linux | ✓ | ✓ | Apple Silicon only, unsigned | ✓ (archiving for iOS needs a Mac) |
| Windows | ✓ | ✓ | ✗ (build on a Mac or Linux) | ✓ (archiving for iOS needs a Mac) |

Windows and Linux builds are x64. ¹ Universal Mac builds need Apple's command-line tools (`xcode-select --install`); without them the Mac build is Apple Silicon only, with a `MAC_NOT_UNIVERSAL` warning. Mac builds made on a Mac are signed: ad-hoc without Apple credentials, with your Developer ID and notarized with them. Mac builds made on Linux are unsigned (`MAC_SIGN_HOST`).

## Mac signing and notarization

Steam only accepts Mac builds that are signed with an Apple Developer ID and notarized. On a Mac, `build` does both when these environment variables are set:

```bash
# once: a "Developer ID Application" certificate (Xcode → Settings → Accounts → Manage Certificates; needs the paid Apple Developer Program)
# once: a notarytool login stored in your keychain (it asks for an app-specific password)
xcrun notarytool store-credentials gameshipper --apple-id you@example.com --team-id ABCDE12345

export GAMESHIPPER_MAC_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export GAMESHIPPER_NOTARY_PROFILE=gameshipper
npx gameshipper build --target mac      # signs, notarizes (usually a few minutes) and staples
```

For CI, use an App Store Connect API key instead of the profile: `GAMESHIPPER_NOTARY_KEY` (the `.p8` file's path, not the key itself), `GAMESHIPPER_NOTARY_KEY_ID` and `GAMESHIPPER_NOTARY_ISSUER`. The first signing may ask for keychain access: click "Always Allow". The variables are never read from `gameshipper.json`, because the identity contains your legal name and game repositories are often public.

Without them the Mac app is ad-hoc signed: it runs on your Mac, and `build` warns `MAC_UNSIGNED`. With only `GAMESHIPPER_MAC_IDENTITY` it's signed but not notarized (`MAC_NOT_NOTARIZED`). Every Mac build uses the hardened runtime with the entitlements Steam needs: Steam injects its overlay with `DYLD_INSERT_LIBRARIES` and the game loads Valve-signed libraries, so library validation is off and DYLD variables are allowed in the game's main process; the App Sandbox isn't used. Signing happens after your plugins' `afterPackage` hooks.

| Code | |
|---|---|
| `APPLE_CREDENTIALS_INVALID` | The variables are half-set or mixed (a notary login without an identity, a keychain without a profile, a profile with API key variables, say); the message names them. Stops the build before anything is built; exit code 2. |
| `MAC_IDENTITY_NOT_FOUND` | `GAMESHIPPER_MAC_IDENTITY` isn't in your keychain. The message lists what is; exit code 2. |
| `MAC_SIGN_FAILED`, `NOTARIZE_FAILED`, `STAPLE_FAILED`, `NOTARIZE_TOOL_MISSING` | Signing or notarizing failed; the Mac target fails. The fix names the log in `.gameshipper/logs/` with codesign's output or Apple's report. |
| `MAC_UNSIGNED`, `MAC_NOT_NOTARIZED`, `MAC_BUNDLE_ID_DEFAULT`, `MAC_SIGN_HOST`, `MAC_ADHOC_SIGN_FAILED` | Warnings: how far the Mac app got, and what to set to go further. |

## iOS and Android

```bash
npx gameshipper init --bundle-id com.yourname.yourgame   # or set "mobile": { "bundleId": … } and add "ios", "android" to "targets"
npx gameshipper build --target ios,android
```

`out/ios` is an Xcode project (open `out/ios/App/App.xcodeproj`) and `out/android` an Android Studio project, generated with Capacitor 8 from the same game files as the desktop builds, with your icon, a splash screen, `version` (build number: 1.2.3 becomes 1002003) and `mobile.orientation`. Both folders are self-contained, so you can move, zip or commit them, and both can be generated on any computer; archiving for the App Store needs a Mac with Xcode. The iOS project needs iOS 16.4 or newer (for import maps) and downloads Capacitor's Swift package from GitHub the first time Xcode builds it. Signing and uploading are done in Xcode and Android Studio. `build` regenerates both folders, so don't edit them by hand; the signing team you pick in Xcode is kept.

A game whose page has no `<meta name="viewport">` gets one. Without a bundle ID the mobile targets fail with `BUNDLE_ID_REQUIRED` (exit code 2), and with one Android can't use (a Java keyword such as `new`) with `BUNDLE_ID_INVALID`.

## Coming in later versions

`publish`, and building, signing and uploading the iOS and Android apps themselves (Gameshipper makes the projects; Xcode and Android Studio do the rest).

## Development

```sh
npm test                  # unit tests
npm run typecheck
npm run test:integration  # builds Gameshipper, then packages and runs real apps
```

The Steam end-to-end test is opt-in. It needs macOS, a running, signed-in Steam client, network access and a Steamworks SDK zip, and on the signed-in account it unlocks then clears Spacewar's `ACH_WIN_ONE_GAME` (only when the account doesn't have it yet) and writes its `NumGames` stat back with its current value (leaving the account as it was):

```sh
GAMESHIPPER_STEAM_E2E=1 GAMESHIPPER_STEAM_E2E_SDK=/path/to/steamworks_sdk_165.zip \
  npm run test:integration -- tests/integration/steam.int.test.ts --reporter=verbose
```

Steam's overlay can only hook a game on an unlocked screen, so on a locked one the overlay-hook test is reported as skipped, with the reason.

## License

MIT
