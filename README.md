# Gameshipper

Turn any web game folder (three.js, Phaser, PixiJS, Babylon.js, plain canvas) into Windows, Mac and Linux desktop builds you can upload to Steam, plus Xcode and Android Studio projects for the App Store and Google Play. Free and open source (MIT). Built so an AI agent can run it end to end.

```bash
npx gameshipper init           # detects your game, writes gameshipper.json
npx gameshipper play           # plays it in the desktop shell (F12 saves a store screenshot)
npx gameshipper play --smoke   # runs it for 5 s and reports problems
npx gameshipper build          # out/windows, out/mac, out/linux and the store images in out/store
npx gameshipper check          # launches the build and checks it's ready for Steam and Steam Deck
npx gameshipper publish        # uploads the builds to Steam, itch.io and GitHub Releases
npx gameshipper status         # what's configured, built, and what happened last
npx gameshipper ci init        # a GitHub Actions workflow that builds and runs it on each OS
npx gameshipper mcp            # every command as an MCP tool, for AI agents
```

Your game doesn't need a build step or npm. A folder with an `index.html` is enough. Files your game loads from CDNs (three.js from unpkg through an import map, a `<script>` or `<link>` tag, a CSS `@import`) are downloaded into the build, so it works offline. They're pinned in `gameshipper.lock`, so builds are reproducible from it; use `--frozen-lock` in CI to enforce that.

Needs Node.js 22.12 or newer. The first build for each OS downloads Electron (120 to 160 MB, cached after that).

## Status of 0.1.0

0.1.0 is the first release. It's young: the list below says what has been verified and what hasn't.

Verified on macOS: every command on the fixture games, builds for all three OSes (cross-built from the Mac), the Mac app ad-hoc signed and running with the hardened runtime, Steam with Valve's test app 480 on a signed-in client (achievements, stats, the overlay hooking the game), the iOS project building and running in the Simulator, the MCP server end to end, and Claude Code shipping a game through the plugin loaded from this folder.

Verified on GitHub's hosted runners (Ubuntu, macOS and Windows), by this repository's CI: the unit tests, and the integration tests that build, run and check the fixture games on each OS, with software WebGL (`GAMESHIPPER_SOFTWARE_GL`) on the Linux and Windows runners, which have no GPU. On the Ubuntu runner (24.04, where Chromium's sandbox can't start for a game in a folder) that includes a Linux build started the way a player starts it, with no arguments: by its own path, through a symbolic link, and from a folder with spaces in its name.

Not verified yet:

- notarization with a real Apple Developer account (only a stand-in for Apple's notary service is tested);
- Steam on Windows, desktop Linux and the Steam Deck: overlay, achievements, gamepads, the on-screen keyboard and clean exits (the manual checks in [docs/release-checklist.md](docs/release-checklist.md));
- a Linux build started by Steam (in its Linux runtime, and on the Deck) or from a desktop's file manager: its [launcher](#build) is only tested started as a program, as above. GNOME's Files opens a script in a text editor on a double-click; there, right-click the launcher and choose Run as a Program;
- the workflow `ci init` writes, in a game's own repository on GitHub's runners;
- installing the Claude Code plugin from the marketplace (`/plugin marketplace add gameshipper/gameshipper`);
- the iOS and Android projects on real devices, and the Android project in Android Studio;
- `publish` to real Steam, itch.io and GitHub accounts: it's tested with the real SteamCMD and butler (without logging in) and against stand-ins for the uploads.

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
| `--screenshot <s,s,...>` | Save 1920x1080 store screenshots this many seconds after the page loads, then quit, e.g. `--screenshot 5,10,15,20,25` (up to 20 times, each at most 600). |
| `--fullscreen` | Honour `window.fullscreen` from `gameshipper.json`. |
| `--packaged` | Run this computer's build from `out/` (made by `build`) as it is, instead of preparing the game folder. `--packaged --smoke` tests the real build. With your own App ID, Steam relaunches it as it would any build started outside Steam. |
| `--detach` | Start the game and return at once, leaving it running (its output goes to the run log). Not with `--smoke`, `--seconds` or `--screenshot`. |
| `--frozen-lock` | Fail instead of accepting changed or new CDN files; for CI. |
| `--steam-sdk <path>` | Your Steamworks SDK zip or folder (see [Steam](#steam)). |

### `build`

Builds desktop apps into `out/<target>`. For a game named "Spinning Cube" that's `out/windows/Spinning Cube.exe`, `out/mac/Spinning Cube.app` and `out/linux/spinning-cube`. One target failing never stops the others.

On Linux, `spinning-cube` is the game's launcher, a small shell script, and `spinning-cube-bin` next to it is the game itself. Players, Steam's launch option and Gameshipper all start the launcher, with no arguments needed: it starts the game with `--no-sandbox`. Linux builds run without Chromium's sandbox (a game is its developer's own files, and its window can't be taken anywhere else), and Chromium only takes that from the command line: on Ubuntu 24.04 and later, where that sandbox can't start for a game in a folder, `spinning-cube-bin` started by itself stops before its window opens. The launcher works through symbolic links to it, from any folder and with spaces in its path, and hands its process to the game, so signals and the exit code are the game's.

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
| Store | all eight images at their exact sizes and made from the current key art, logo and focus, at least five 1920x1080 screenshots, and reminders about the trailer and Steam's AI disclosure |

Run it after `build`: it never builds anything itself. The Deck-size frame is saved as `.gameshipper/check/frame.png` and the full report as `.gameshipper/check/report.json`. Without Apple credentials a Mac build is only ad-hoc signed, so on a Mac `review.mac-signing` fails with `CHECK_MAC_NOT_NOTARIZED` until you [sign and notarize](#mac-signing-and-notarization) it.

The network block stops the game's requests (each is listed in `offline.requests`) and its WebRTC connections (not listed). A [plugin](#plugins)'s requests through Electron's `net` module are blocked and listed too, but its Node networking in Electron's main process (`http`, `https`, `fetch`) isn't blocked, and neither is WebTransport: `offline.requests` never sees those.

| Flag | |
|---|---|
| `--seconds <n>` | How long the game runs with the network blocked (default 15, at most 600). |

### `publish`

Uploads the builds in `out/` to Steam, itch.io and GitHub Releases: by default to each one `gameshipper.json` sets up (see [Publishing](#publishing)). Every desktop target must be built first. One destination failing never stops the others.

| Flag | |
|---|---|
| `--to <list>` | Where to upload: `steam`, `itch` and `github`, or some of them. |
| `--dry-run` | Check everything and preview the uploads, uploading nothing. Steam still needs its login for this. |
| `--steam-user <account>` | The Steam account that uploads builds (default: `steam.user`). |
| `--branch <name>` | Steam: also set the build live on this existing beta branch (never `default`). |
| `--repo <owner/name>` | The GitHub repository to release to (default: `github.repo`). |
| `--live` | GitHub: publish the release at once instead of leaving it a draft. |

### `status`

Shows the config, what this computer can build, the Steamworks SDK builds will use, which `out/` folders exist, and the last result of `init`, `play`, `build`, `check`, `publish` and `ci` with their log paths. It succeeds for any existing folder, so it's the command to run first.

### `ci init`

Writes `.github/workflows/gameshipper.yml`, a GitHub Actions workflow (see [GitHub Actions](#github-actions)). `--force` replaces an existing one.

### `mcp`

Serves every command as an MCP tool over stdio (see [MCP server and Claude Code plugin](#mcp-server-and-claude-code-plugin)). `--dir` sets the game folder tools use by default.

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

- Add `--json` to any command: stdout is exactly one JSON object, `{ ok, data, errors[], warnings[], logPath }`. `logPath` is the run's log (for `play`, `build`, `check` and `publish`). Without a valid `gameshipper.json` they write nothing into the folder, so a `CONFIG_MISSING` or `CONFIG_INVALID` result has no `logPath`.
- Every error and warning has a stable `code` and a plain-English `message`. Errors always have a `fix`; warnings have one whenever there's something to do.
- Nothing ever prompts when `--json` or `--yes` is set, or when stdin isn't a terminal. Missing input comes back as `INPUT_REQUIRED`, naming the flag to pass.
- Exit codes: `0` success, `1` a target or check failed, `2` invalid config, usage or missing input, or a login or token you must provide. A signal ends the run with an `INTERRUPTED` result and exit code 128 + the signal number (130 for Ctrl+C). Ctrl+C during an interactive `play` just ends the session: an `ok` result with a `PLAY_STOPPED` warning, still exit 130.
- `help --json` returns every command and flag.
- `check --json` returns 18 checks, each with a stable `id`, a `status` (`pass`, `warn`, `fail`, `info` or `skip`) and, for `warn` and `fail`, a `code` and a `fix`. Every failed check is also an error in `errors`, and every warning in `warnings`, so exit code 1 means at least one check failed. Open `data.deckScreenshot` to see what the game showed at Steam Deck size.
- `play --screenshot 5,10,15,20,25 --json` saves store screenshots without a person; `data.screenshots` lists them. They show whatever the game shows without input, so look at them before you upload them.
- `publish --json` never prompts. Without a saved Steam or itch.io login it returns `STEAM_LOGIN_REQUIRED` or `ITCH_LOGIN_REQUIRED` (exit code 2): the human runs the command in the error's `fix` once in their own terminal, then you publish again.
- `npx gameshipper mcp` serves the same commands as MCP tools, with the same results (see [MCP server and Claude Code plugin](#mcp-server-and-claude-code-plugin)).

The loop: `status --json`, `init --yes --json`, then `play --smoke --json` until it comes back clean (`ok: true`, so no errors; warnings don't block), then `build --json`, then `check --json` until nothing fails that you can fix. When the human wants it uploaded: `publish --dry-run --json`, then `publish --json`.

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
| `GAMESHIPPER_SOFTWARE_GL` | Set to `1` on machines without a GPU, such as hosted CI runners, so games may render WebGL in software. Only `play`, smoke runs and `check` use it: a player's launch of a shipped game ignores it. The `ci init` workflow sets it. |
| `GAMESHIPPER_MAC_IDENTITY` | The Developer ID Application identity Mac builds are signed with (see [Mac signing and notarization](#mac-signing-and-notarization)). Unset: ad-hoc signing. |
| `GAMESHIPPER_NOTARY_PROFILE`, `GAMESHIPPER_NOTARY_KEYCHAIN` | The notarytool keychain profile (and, optionally, the keychain holding it) Mac builds are notarized with. |
| `GAMESHIPPER_NOTARY_KEY`, `GAMESHIPPER_NOTARY_KEY_ID`, `GAMESHIPPER_NOTARY_ISSUER` | For CI instead of a profile: an App Store Connect API key (`.p8` path), its ID and its issuer ID. |
| `GITHUB_TOKEN`, `GH_TOKEN` | `publish`: a token that can write to the GitHub repository (`GH_TOKEN` is read when `GITHUB_TOKEN` isn't set). The `gh` CLI's login is never used. |
| `BUTLER_API_KEY` | `publish`: an itch.io API key for butler, for CI, instead of butler's own login. |
| `GAMESHIPPER_GITHUB_API` | `publish`: the GitHub API to use, for GitHub Enterprise. Default: https://api.github.com. |
| `GAMESHIPPER_STEAMCMD`, `GAMESHIPPER_BUTLER` | `publish`: a SteamCMD or butler to run instead of the ones Gameshipper downloads. |

`help --json` lists them all under `environment`. Apple credentials and tokens are only ever read from these variables and your keychain, never from `gameshipper.json`.

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
| `.gameshipper/steam/` | The last `publish` to Steam: the SteamPipe build scripts, and SteamCMD's build logs in `output/`. |

## MCP server and Claude Code plugin

`npx gameshipper mcp` serves every command as an MCP tool over stdio: `gameshipper_status`, `gameshipper_init`, `gameshipper_play`, `gameshipper_build`, `gameshipper_check`, `gameshipper_publish` and `gameshipper_ci_init`. Inputs are the command's flags in camelCase (`appId`, `bundleId`, `target: ["mac"]`, `screenshot: [5, 10]`), and `dir` picks the game folder (by default, the folder the server started in, or its `--dir`). `dir` and `steamSdk` are relative to the server's folder; `init`'s `icon`, `keyArt`, `logo`, `entry` and `outputDir` to the game folder. Each tool runs the CLI with `--json` and returns its result as structured content: `{ ok, data, errors[], warnings[], logPath }`, marked as a tool error when `ok` is false. A smoke run's result leaves out its list of events (`data.smoke.summary.eventsLeftOut` counts them; `data.smoke.eventsLog` has them all), and every error's and warning's message, those inside `data` too (each `publish` destination's), is cut to 300 characters around "… (see the log) …", so it stays small. The CLI's own result and the run log keep all of it. Long builds send progress notifications, a cancelled call stops its command and everything it started, and calls that change the same game folder run one at a time (a waiting call's progress says so).

- `gameshipper_play` opens the game window for you and returns at once. With `smoke: true` it runs the game briefly and returns every problem it found.
- `gameshipper_publish` is a separate step: the server tells agents to call it only when you ask, because it uploads to your store accounts, itch.io makes uploads public at once if the game's page is, and butler's saved itch.io login is used without asking. It never prompts: a missing Steam or itch.io login comes back as `STEAM_LOGIN_REQUIRED` or `ITCH_LOGIN_REQUIRED`, whose fix is the command the human runs once in their own terminal. `GITHUB_TOKEN` must be set where the server runs.
- The server never asks for, accepts or stores passwords, tokens or 2FA codes.

Claude Code:

```bash
claude mcp add gameshipper -- npx -y gameshipper mcp
```

Cursor and other MCP clients (`mcp.json`):

```json
{ "mcpServers": { "gameshipper": { "command": "npx", "args": ["-y", "gameshipper", "mcp"] } } }
```

The Claude Code plugin adds the MCP server and a `ship-web-game` skill that teaches Claude the loop: check the state, set up, smoke-test, fix, build and check, and publish when you ask.

```
/plugin marketplace add gameshipper/gameshipper
/plugin install gameshipper@gameshipper
```

Without the plugin, copy `plugin/skills/ship-web-game/SKILL.md` from this repository to `.claude/skills/ship-web-game/SKILL.md` in your game folder, and add the MCP server as shown above.

## GitHub Actions

```bash
npx gameshipper ci init
```

This writes `.github/workflows/gameshipper.yml`. On every push to `main` or `master` and every pull request it builds each desktop target on its own OS (`windows-latest`, `macos-latest`, `ubuntu-latest`) with `--frozen-lock`, runs the build for a few seconds with `play --packaged --smoke` (under a virtual display on Linux), and uploads it as an artifact: `<game>-windows.tar.gz`, `-mac` and `-linux`, tarballs so file permissions and the Mac app survive. Commit `gameshipper.lock` with it if your game has one. Hosted runners have no GPU, so the workflow sets `GAMESHIPPER_SOFTWARE_GL=1`. The workflow pins the Gameshipper version that wrote it, checks out without keeping the repository's token, and uses no secrets; its comments say how to add your Steamworks SDK and Mac signing without handing those secrets to pull requests.

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
  "steam": { "appId": 480, "user": null, "sdk": null, "overlay": "auto" },
  "mobile": { "bundleId": null, "orientation": "landscape" },
  "itch": { "project": null },
  "github": { "repo": null },
  "plugins": []
}
```

Builds start fullscreen when `window.fullscreen` is true, and always on Steam Deck. `npx gameshipper help --json` includes the full schema.

Builds package the game folder (`game.dir`, or `game.outputDir` when there's a `buildCommand`) except `.env` files, `.git`, `.DS_Store`, `Thumbs.db`, `steam_appid.txt` and the Steamworks SDK anywhere in it, and every dot file and folder at its top; only when the game folder is the project folder itself are the project's own top-level files skipped too (`out/`, `node_modules/`, `gameshipper.json`, `gameshipper.lock`, `CLAUDE.md`, `AGENTS.md` and package-manager lockfiles), so a `dist/` folder keeps its own `node_modules/` or `out/`.

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

Crops centre on `keyArtFocus`: `[x, y]` as fractions of the key art's width and height, `[0.5, 0.5]` by default. Transparent parts of the key art come out black. Unusable art fails the build with `KEYART_INVALID` (not a PNG or JPEG), `KEYART_TOO_SMALL`, `LOGO_INVALID` (not a PNG, or fully transparent) or `LOGO_NOT_TRANSPARENT` (exit code 2, like a bad icon); art that had to be enlarged gives `KEYART_LOW_RES` or `LOGO_LOW_RES`; without `keyArt` and `logo`, builds warn `STORE_IMAGES_SKIPPED`. Each build replaces the images in `out/store/` and records what they were made from (the key art's and logo's paths and content hashes, and the focus) in `out/store/.source.json`; one that skips them or fails leaves none there, so `check` never passes old ones.

The key art and logo are left out of the game itself unless one of its HTML, JavaScript, CSS or JSON files mentions the file's name, or its name without the extension as a quoted string (`"Logo"` for `Logo.png`, as RPG Maker games do); then the game may show it, so it ships. If a `play --smoke` run finds the game asking for one that was left out, `GAME_FILE_MISSING` says so.

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

In iOS and Android builds `window.gameshipper.saves` works the same way, on every page of the game: saves are stored with Capacitor Preferences (UserDefaults / SharedPreferences), which the OS never clears and device backups include. On phones `window.steam` is `undefined` and `gameshipper.plugins` is empty.

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

Without them the Mac app is ad-hoc signed: it runs on your Mac, and `build` warns `MAC_UNSIGNED`. With only `GAMESHIPPER_MAC_IDENTITY` it's signed but not notarized (`MAC_NOT_NOTARIZED`). Every Mac build uses the hardened runtime with as few entitlements as work: JIT (for JavaScript) and the microphone everywhere, and, when the build includes Steam, library validation off and DYLD variables allowed in the game's main process, because Steam injects its overlay with `DYLD_INSERT_LIBRARIES` and the game loads Valve-signed libraries. An ad-hoc signed build also has library validation off in every process: without a Team ID, Electron couldn't load its own framework. The App Sandbox isn't used. Signing happens after your plugins' `afterPackage` hooks.

| Code | |
|---|---|
| `APPLE_CREDENTIALS_INVALID` | The variables are half-set or mixed (a notary login without an identity, a keychain without a profile, a profile with API key variables, say); the message names them. Stops the build before anything is built; exit code 2. |
| `MAC_IDENTITY_NOT_FOUND` | `GAMESHIPPER_MAC_IDENTITY` isn't in your keychain. The message counts the identities that are there by certificate type, without their names (run `security find-identity -v -p codesigning` to see them); exit code 2. |
| `MAC_SIGN_FAILED`, `NOTARIZE_FAILED`, `STAPLE_FAILED`, `NOTARIZE_TOOL_MISSING` | Signing or notarizing failed; the Mac target fails. The fix names the log in `.gameshipper/logs/` with codesign's output, notarytool's own reason (usually a login problem) or Apple's report. Stapling the ticket is tried 3 times, 5 seconds apart, before `STAPLE_FAILED`. |
| `MAC_UNSIGNED`, `MAC_NOT_NOTARIZED`, `MAC_BUNDLE_ID_DEFAULT`, `MAC_SIGN_HOST`, `MAC_ADHOC_SIGN_FAILED` | Warnings: how far the Mac app got, and what to set to go further. |

## iOS and Android

```bash
npx gameshipper init --bundle-id com.yourname.yourgame   # or set "mobile": { "bundleId": … } and add "ios", "android" to "targets"
npx gameshipper build --target ios,android
```

`out/ios` is an Xcode project (open `out/ios/App/App.xcodeproj`) and `out/android` an Android Studio project, generated with Capacitor 8 from the same game files as the desktop builds, with your icon, a splash screen, `version` (build number: 1.2.3 becomes 1002003) and `mobile.orientation`. Both folders are self-contained, so you can move, zip or commit them, and both can be generated on any computer; archiving for the App Store needs a Mac with Xcode. The iOS project needs iOS 16.4 or newer (for import maps) and downloads Capacitor's Swift package from GitHub the first time Xcode builds it. Signing and uploading are done in Xcode and Android Studio. `build` regenerates both folders, so don't edit them by hand; the signing team you pick in Xcode is kept.

A game whose page has no `<meta name="viewport">` gets one. A build with the mobile targets checks the bundle ID and version before it builds anything, and stops with exit code 2: `BUNDLE_ID_REQUIRED` without a bundle ID, `BUNDLE_ID_INVALID` for one the stores won't take (a Java keyword such as `new`, which Android can't use, or Apple's own `com.apple.` prefix), and `VERSION_UNSUPPORTED` for a version that can't be a build number (a minor or patch of 1000 or more, or past 2100.0.0, Google Play's limit).

## Publishing

```bash
npx gameshipper publish --dry-run                 # check everything, upload nothing
npx gameshipper publish                           # Steam, itch.io and GitHub Releases, whichever are set up
npx gameshipper publish --to steam --branch beta  # also set the Steam build live on your beta branch
npx gameshipper publish --to github --live        # publish the GitHub release instead of leaving a draft
```

Set these in `gameshipper.json`; they're names, not secrets:

| Field | Example | For |
|---|---|---|
| `steam.appId` | `1234560` | Steam: your own App ID. 480 is Valve's test app, which can't take uploads, so Steam is left out until you set it |
| `steam.user` | `moon_builder` | Steam: the account that uploads builds (or pass `--steam-user`) |
| `steam.depots` | `{ "windows": 1234561 }` | Steam: depot IDs, when they aren't the App ID + 1, 2 and 3 |
| `itch.project` | `moonstudio/moon-game` | itch.io |
| `github.repo` | `moonstudio/moon-game` | GitHub Releases (or pass `--repo`) |

**Steam.** Gameshipper downloads Valve's SteamCMD into its cache (checked against a pinned SHA-256) and uploads one build with a depot per OS, from `out/windows`, `out/mac` and `out/linux`, with your version as its description; `steam_appid.txt` is never uploaded. The first time, SteamCMD asks for the password and Steam Guard code in your terminal; Gameshipper never sees them. SteamCMD runs with a HOME of its own in Gameshipper's cache, where it keeps its login, and on a Mac with a stand-in `launchctl`, so it never changes your Steam client's files and never loads or removes its background jobs. The build is uploaded, not set live: `publish` prints the link to set it live, and the launch option and Steam Cloud settings to enter once in Steamworks. `--branch beta` also sets it live on an existing beta branch; Valve only lets the website set the default branch live. The account needs Steamworks' Edit App Metadata and Publish App Changes To Steam permissions, and Valve recommends an account just for builds. A dry run logs in too, because Steam checks the build on its servers.

**itch.io.** Gameshipper downloads itch.io's butler and pushes each build to the channels `windows`, `mac` and `linux`, with your version. The first time, butler opens your browser to log in, and keeps the login itself; in CI, set `BUTLER_API_KEY`. Uploads are downloadable at once if the game's page is public: keep it in Draft to try a build first.

**GitHub Releases.** Needs a token in `GITHUB_TOKEN` (or `GH_TOKEN`) that can write to the repository: a fine-grained token limited to it with Contents: Read and write, or a classic token with the `repo` scope. Set it yourself, in your shell or the MCP server's environment; never paste it into a chat with an agent. Gameshipper never uses the `gh` CLI's login. It zips each build (on a Mac with `ditto`, so the Mac app keeps its signature however it's unzipped) and attaches them to the release `v<version>`, as a draft unless you pass `--live`. Publishing again replaces the draft's files; a published release is never changed (`GITHUB_RELEASE_PUBLISHED`: raise the version).

**iOS and Android** aren't uploaded: `publish` lists the steps in Xcode and Android Studio.

| Code | |
|---|---|
| `STEAM_LOGIN_REQUIRED`, `ITCH_LOGIN_REQUIRED` | No saved login, and nobody at a terminal to log in (an agent, `--json` or `--yes`): run the command in the fix once in your own terminal. Exit code 2. |
| `BUILD_MISSING`, `STEAM_TEST_APP`, `STEAM_DEFAULT_BRANCH`, `GITHUB_TOKEN_MISSING`, `GITHUB_AUTH_FAILED`, `GITHUB_REPO_NOT_FOUND`, `GITHUB_RELEASE_PUBLISHED` | Something to set or fix first; exit code 2. |
| `STEAM_PATH_UNSUPPORTED` | The game folder's path has a `"` (or, on macOS and Linux, a `\`), which SteamCMD's build scripts can't hold: move or rename the folder. On a Mac it's also returned when Gameshipper's cache folder has a `:`: set `GAMESHIPPER_CACHE` to another. Exit code 2. |
| `STEAM_UPLOAD_FAILED`, `STEAM_SET_LIVE_FAILED`, `STEAM_LOGIN_FAILED`, `STEAMCMD_CANT_RUN`, `ITCH_PUSH_FAILED`, `ITCH_LOGIN_FAILED`, `GITHUB_API_FAILED`, `ZIP_FAILED`, `TOOL_DOWNLOAD_FAILED`, `TOOL_CHECKSUM_MISMATCH`, `TOOL_UNSUPPORTED_HOST` | The upload or a tool failed; the message says why and the run log has the tool's output. Exit code 1. |
| `ITCH_UPLOADS_LIVE` | A warning: itch.io uploads are public at once if the page is. |

## Coming in later versions

Building, signing and uploading the iOS and Android apps themselves (Gameshipper makes the projects; Xcode and Android Studio do the rest).

## Development

```sh
npm test                  # unit tests
npm run typecheck
npm run test:integration  # builds Gameshipper, then packages and runs real apps (and drives the MCP server)
```

Each test file deletes the temp folders it made when it's done. To look at what a failing test left behind, run it with `GAMESHIPPER_KEEP_TMP=1`: a file with a failure keeps its folders and lists them.

`GAMESHIPPER_AGENT_E2E=1 npm run test:agent` has Claude Code (the `claude` CLI, logged in) ship the fixture game through the plugin, then checks what it did. It uses a little Claude usage: haiku by default (`AGENT_E2E_MODEL` to change), capped by `AGENT_E2E_BUDGET_USD` (default 1). The agent may only edit the game's copy, runs without your own Claude Code settings, and its folder and transcript are deleted afterwards unless `GAMESHIPPER_KEEP_TMP=1`.

The release steps, including the manual Steam checks on a PC, a Mac and a Steam Deck, are in [docs/release-checklist.md](docs/release-checklist.md).

The Steam end-to-end test is opt-in. It needs macOS, a running, signed-in Steam client, network access and a Steamworks SDK zip, and on the signed-in account it unlocks then clears Spacewar's `ACH_WIN_ONE_GAME` (only when the account doesn't have it yet) and writes its `NumGames` stat back with its current value (leaving the account as it was):

```sh
GAMESHIPPER_STEAM_E2E=1 GAMESHIPPER_STEAM_E2E_SDK=/path/to/steamworks_sdk_165.zip \
  npm run test:integration -- tests/integration/steam.int.test.ts --reporter=verbose
```

While it runs, Steam shows your friends that you're playing Spacewar (App ID 480, Valve's test game), once for every game the test launches, and Spacewar appears in your recent activity. Set your status to Invisible in Steam's Friends list first if you'd rather they didn't see it.

Steam's overlay can only hook a game on an unlocked screen, so on a locked one the overlay-hook test is reported as skipped, with the reason.

## License

MIT: see [LICENSE](LICENSE).
