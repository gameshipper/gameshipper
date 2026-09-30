---
name: ship-web-game
description: Use when the user wants to turn a web game (a folder with an index.html, e.g. three.js, Phaser, PixiJS, Babylon.js, plain canvas, or a Vite project) into Windows, Mac or Linux desktop apps for Steam, or iOS and Android projects, try it in a desktop window, fix what breaks outside the browser, check it against Steam and Steam Deck requirements, or set up CI builds. Drives the Gameshipper MCP tools or CLI.
---

# Ship a web game with Gameshipper

Gameshipper turns a web game folder into Steam-ready desktop apps, plus Xcode and Android Studio projects. You run it. The human steps in only to look at the game, to supply art and accounts, and to log in to stores.

## How to call it

- **MCP tools**, when your tool list has them: `gameshipper_status`, `gameshipper_init`, `gameshipper_play`, `gameshipper_build`, `gameshipper_check` and `gameshipper_ci_init` (from this plugin, Claude Code names them like `mcp__plugin_gameshipper_gameshipper__gameshipper_status`). Inputs are the CLI flags in camelCase (`appId`, `bundleId`, `target: ["mac"]`, `screenshot: [5, 10]`). `dir` picks the game folder; it defaults to the folder Claude Code runs in. A fix that says `npx gameshipper build --target mac` means `gameshipper_build` with `target: ["mac"]`: call the tool, don't run npx.
- The MCP server sees the environment variables Claude Code had when it started it. Variables the human sets later (Apple signing credentials, the Steamworks SDK path) reach it only after they restart Claude Code; or the human runs the command themselves in the terminal where they set them, e.g. `npx gameshipper build --target mac`.
- **Otherwise the CLI**: `npx gameshipper <command> --json` in the game folder, or with `--dir <path>`. It needs Node 22.12 or newer. With `--json`, stdout is one JSON object and nothing prompts. `npx gameshipper help --json` lists every command, flag and environment variable, and the JSON Schema of `gameshipper.json`.

Both return the same result: `{ ok, data, errors[], warnings[], logPath }`. Every error has a `code`, a `message` and a `fix`. **Do what the `fix` says**: it names the flag, config field or command to use. CLI exit codes: 0 success, 1 a target or check failed, 2 bad input or config (fix it and run again).

## The loop

1. **Look first.** `gameshipper_status` (`npx gameshipper status --json`) shows whether `gameshipper.json` exists, what this computer can build, which builds exist, and each command's last result and log.
2. **Set up once.** Without a config, call `gameshipper_init` (`npx gameshipper init --json`). Pass what you know: `--name`; `--app-id` (the Steam App ID; without it, Valve's test app 480); `--icon` (a square PNG, 1024x1024 or larger); `--key-art` and `--logo` for the store images; `--bundle-id com.studio.game` to add iOS and Android projects; `--entry`, or `--build-command` with `--output-dir` for a project with a bundler. `INPUT_REQUIRED` names the flag to add. `CONFIG_EXISTS` means it's set up already: edit `gameshipper.json` instead.
3. **Smoke-test.** `gameshipper_play` with `smoke: true` (`npx gameshipper play --smoke --json`) runs the game for a few seconds in the desktop shell and reports what went wrong:

   | Code | Meaning | Fix |
   |---|---|---|
   | `GAME_CONSOLE_ERROR` | A console error or uncaught exception | Fix the code at the file and line in the message |
   | `GAME_FILE_MISSING` | The game asked for a file that isn't in the build | Fix the path, or add the file to the game folder |
   | `GAME_PATH_CASE` (warning) | The path's letter case differs from the file's | Match it exactly: builds treat case as significant on every OS |
   | `GAME_USES_INTERNET` (warning) | The game loaded something from the internet while it ran | Put the file in the game folder, or load it with `<script>`, `<link>` or an import map so Gameshipper bundles it |
   | `GAME_CRASHED`, `GAME_LOAD_FAILED`, `SMOKE_NO_RESULT` | The game didn't run | Read the events log named in the result and the run log at `logPath` |

4. **Fix and repeat step 3** until `ok` is true. Change the game's own files, never `.gameshipper/` or `out/`: both are regenerated.
5. **Build.** `gameshipper_build` (`npx gameshipper build --json`) writes every configured target to `out/<target>/`. While iterating, build only this computer's OS with `--target mac` (or `windows`, `linux`). The first build downloads Electron for each OS and can take a few minutes. `STEAM_SDK_MISSING` means the builds run without Steam features: the human downloads the Steamworks SDK zip from partner.steamgames.com into the project's `.sdk/` folder, which is never committed. Then `gameshipper_play` with `packaged: true` and `smoke: true` (`npx gameshipper play --packaged --smoke --json`) smoke-tests the built app itself. Only this computer's build can be launched here: the Windows, Mac and Linux builds for other OSes are made, but the human runs them on those OSes. `out/ios` and `out/android` are Xcode and Android Studio projects: signing, running them on devices and uploading them need the human's Apple and Google accounts.
6. **Check.** `gameshipper_check` (`npx gameshipper check --json`) runs this computer's build offline at Steam Deck size, then checks the builds and the store assets. Fix each failure, build again and check again; tell the human about the warnings. Some need the human:
   - `CHECK_STORE_IMAGES`: set `keyArt` and `logo` (init's `--key-art` and `--logo`), then build: Gameshipper makes every store image from them.
   - `CHECK_SCREENSHOTS`: Steam wants at least five 1920x1080 gameplay screenshots. `gameshipper_play` with `screenshot: [5, 10, 15, 20, 25]` (`npx gameshipper play --screenshot 5,10,15,20,25`) saves them automatically, or the human presses F12 while playing; look at what they show, and let the human pick the ones that show the game well.
   - `CHECK_MAC_NOT_NOTARIZED`: signing needs the human's paid Apple Developer account, set up in environment variables on their Mac (`npx gameshipper help --json` lists them). Never ask for these credentials.
   - `CHECK_TEST_APP_ID`: set `steam.appId` in `gameshipper.json` to the real App ID from the Steamworks dashboard.
7. **Hand over when you're done.** You're done when `gameshipper_play` with `smoke: true` is ok and `gameshipper_check` fails only on what needs the human: their art (`CHECK_STORE_IMAGES`, `CHECK_DEFAULT_ICON`), screenshots they approve (`CHECK_SCREENSHOTS`), their Apple account (`CHECK_MAC_NOT_NOTARIZED`) or their App ID (`CHECK_TEST_APP_ID`). Publishing isn't a Gameshipper command yet. Tell the human where the builds are (`out/windows`, `out/mac`, `out/linux`; `out/ios` and `out/android` open in Xcode and Android Studio), and give them a list of what's left for them: each failed check and warning with what to do, and running the other OSes' builds on those OSes.

## Rules

- **Never ask for passwords, tokens, 2FA codes or signing credentials**, and never put them in commands, files or tool inputs. Logins and credentials stay with the human, in their own terminal and environment.
- To let the human try the game, call `gameshipper_play` without `smoke` (it opens the window and returns at once), or ask them to run `npx gameshipper play`. F11 toggles fullscreen; F12 saves a store screenshot.
- Steam App ID 480 is Valve's test app, fine for trying things. Set the real one before release.
- For CI, `gameshipper_ci_init` (`npx gameshipper ci init`) writes a GitHub Actions workflow that builds, runs and uploads each desktop target on its own OS. The human commits it, with `gameshipper.lock` if the game has one.
- Not sure what happened? `gameshipper_status` lists every command's last result and log path.
