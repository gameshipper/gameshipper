# Release checklist

Run this for every Gameshipper release, and in full whenever the pinned Electron version changes. Copy it into the release's tracking issue and tick it there.

## One-time setup (before the first release)

- [ ] The npm package name `gameshipper` belongs to the Gameshipper npm account (never a personal account). Until it's published, `npx gameshipper` and the plugin's `npx -y gameshipper@<version> mcp` run whatever package someone else registers under that name, so claim it before telling anyone about the tool.
- [ ] On npmjs.com, under the package's Settings, add a trusted publisher: GitHub Actions, organization `gameshipper`, repository `gameshipper`, workflow `release.yml`, environment `npm`. If npm won't add a trusted publisher to a package that doesn't exist yet, do the very first publish by hand from the Gameshipper npm account, then add it.
- [ ] In the GitHub repository settings, create the environment `npm`, limit its deployment branches and tags to the tag pattern `v*`, and require a reviewer (the Gameshipper account), so every publish needs a click.
- [ ] Add a tag ruleset for `v*`: only the Gameshipper account (or repository admins) may create, update or delete those tags.
- [ ] On npmjs.com, set the package's publishing access to "Require two-factor authentication and disallow tokens", so only the trusted publisher (the Release workflow) can publish.

## 1. Automated checks

- [ ] CI is green on the commit you're releasing: unit tests on Linux, macOS and Windows, the workflow lint, and the macOS integration tests (which include the MCP end-to-end test). The Linux and Windows integration jobs can't fail CI yet: read their results anyway.
- [ ] If Electron changed since the last release: the **Electron canary** workflow passed with the new version (Actions → Electron canary → Run workflow), and section 3 is done on all four machines.
- [ ] On a Mac: `npm run test:integration` passes (it opens game windows).
- [ ] `claude plugin validate . --strict` and `claude plugin validate ./plugin --strict` both print `✔ Validation passed`.
- [ ] Optional, uses a little Claude usage (about $0.20 with the default model, haiku): `GAMESHIPPER_AGENT_E2E=1 npm run test:agent` prints only ✓ lines.
- [ ] `npm pack --dry-run` lists only files under `bin/`, `dist/` and `types/`, plus `package.json`, `README.md` and `LICENSE`: no `.sdk/`, `fixtures/`, `tests/` or `plugin/`.

## 2. Version and publish

- [ ] Set the new version in all four places: `package.json` (`npm version --no-git-tag-version X.Y.Z`), `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the `gameshipper@X.Y.Z` pin in `plugin/.mcp.json`. `npx vitest run tests/plugin` fails until all four match.
- [ ] Commit, then tag and push from the Gameshipper account only (never a personal one): `git tag vX.Y.Z && git push origin main vX.Y.Z`. The **Release** workflow checks that the tag matches `package.json`, runs the tests and packs the package, publishes that tarball to npm through trusted publishing once the `npm` environment's reviewer (again the Gameshipper account) approves, and creates the GitHub release.
- [ ] Afterwards, `npx gameshipper@X.Y.Z --version` prints `X.Y.Z`.

## 3. Manual Steam checks on real hardware

These need a signed-in Steam client, so CI can't run them. Use Valve's test app, App ID 480 (Spacewar), on a **Windows PC**, a **Mac**, a **Steam Deck** and a **desktop Linux PC** (Ubuntu or similar, with Steam from its own package).

**Prepare the test game** on a Mac, from this repo, with the Steamworks SDK zip in `.sdk/` (without it the builds have no Steam features):

```bash
npm run build
game="$TMPDIR/release-check" && rm -rf "$game" && cp -R fixtures/release-check "$game"
node bin/gameshipper.js init --yes --name "Release Check" --dir "$game"
node bin/gameshipper.js build --steam-sdk "$(ls .sdk/steamworks_sdk_*.zip | tail -1)" --dir "$game"
```

Copy `out/windows` to the PC and `out/linux` to the Deck and the Linux PC (over USB, or with `scp`; on the Deck, in Desktop Mode).

**Check each build on its own OS** first: copy the test game's folder (with `gameshipper.json` and `out/<target>`) to the PC and the Linux PC, and run `npx gameshipper@X.Y.Z check --dir <folder>` there. It runs that computer's build, and every `launch.*`, `deck.*` and `offline.*` check passes.

**Launch it through Steam** on each machine: Steam → Games → Add a Non-Steam Game to My Library → Browse, then pick `Release Check.exe` (Windows), `Release Check.app` (Mac) or `release-check` (Deck in Desktop Mode, and Linux). Start it from the Steam library; on the Deck, switch to Game Mode first. Steam only hooks its overlay into games it launched.

The page shows whether Steam is running for the game, the player's Steam name, a log of every call, live gamepad input and a text field.

| Check | How | Passes when | Win | Mac | Deck | Linux |
|---|---|---|---|---|---|---|
| Overlay | Press Shift+Tab (Deck: the Steam button) | The Steam overlay opens over the game and closes again, and the blue square keeps spinning | ☐ | ☐ | ☐ | ☐ |
| Clicks after the overlay | Open and close the overlay, then click **Load** | The click reaches the game (the log shows the call) without clicking the window first. Mac especially | ☐ | ☐ | ☐ | ☐ |
| Achievement | Click **Unlock ACH_WIN_ONE_GAME** | Steam shows Spacewar's achievement pop-up. Click **Clear ACH_WIN_ONE_GAME** afterwards to reset it | ☐ | ☐ | ☐ | ☐ |
| Gamepad with Steam Input | Connect a controller with Steam Input on for this game (Deck: the built-in controls), press buttons and move the sticks | The Gamepads panel lists the pad and follows the buttons and sticks | ☐ | ☐ | ☐ | ☐ |
| Fullscreen | Start it; on a desktop, press F11 or Alt+Enter twice | On the Deck in Game Mode it starts fullscreen. Elsewhere it follows `window.fullscreen` and the keys toggle it | ☐ | ☐ | ☐ | ☐ |
| On-screen keyboard | Deck, Game Mode: tap **Type here** | Steam's on-screen keyboard opens next to the field, and what you type appears in it (the log shows `typed:` after you leave the field) | – | – | ☐ | – |
| Clean exit | Click **Quit**; start it again and close the window instead | The library shows **Play** again within a few seconds (not Running or Stop), and no process is left over (Task Manager, Activity Monitor, `ps aux \| grep -i release`) | ☐ | ☐ | ☐ | ☐ |
| Cloud save | Needs an App ID of your own with Steam Auto-Cloud set up in the Steamworks dashboard for the saves folder ([README, Saves](../README.md#saves)): App 480 can't sync it. Build with that App ID, click **Save** on one machine, quit, then **Load** on another machine signed in to the same account | The count, time and machine from the first machine appear | ☐ | ☐ | ☐ | ☐ |

**With a real App ID** (one of your own, built with `init --app-id` or `steam.appId`), on at least one machine:

- [ ] Started outside Steam (double-click the build), it quits and Steam starts it again as the game (Steam's relaunch); started from the library it just runs.
- [ ] Signed in to a Steam account that doesn't own the App ID, `npx gameshipper play --packaged --smoke --json` reports `STEAM_INIT_FAILED`.

**Mac signing and notarization**, with the Gameshipper Apple Developer account's Developer ID certificate and notary credentials set in the environment ([README](../README.md#mac-signing-and-notarization)):

- [ ] `build --target mac` signs and notarizes with no `MAC_UNSIGNED` or `MAC_NOT_NOTARIZED` warning, and `spctl --assess --type execute -vv "out/mac/Release Check.app"` says `accepted` and `source=Notarized Developer ID`.
- [ ] `check` passes `review.mac-signing`.
- [ ] The overlay and achievement checks above pass with this signed and notarized build, launched through Steam.

**Publishing**, with the Gameshipper test accounts: a Steamworks app with Windows, Mac and Linux depots, a `beta` branch and a build account that has only Edit App Metadata and Publish App Changes To Steam; an itch.io page kept in Draft; a GitHub repository for tests and a fine-grained token limited to it, with Contents: Read and write (never a personal `gh` login). Set `steam.appId`, `steam.user`, `itch.project` and `github.repo` in the test game, build it (signed and notarized, as above), and in a terminal (on the Mac, first note what `launchctl print gui/$(id -u)/com.valvesoftware.steamclean | grep -E 'path =|program ='` prints, for the last check below):

Set `GITHUB_TOKEN` in that shell without it ever showing on a command line or in the shell's history: run `read -rs GITHUB_TOKEN && export GITHUB_TOKEN`, paste the token (nothing is echoed) and press Return. For the Claude Code check below, the MCP server needs it in its own environment: start Claude Code from that shell, or set it in the server's `env` in the MCP config. Never type the token as part of a command.

- [ ] `npx gameshipper@X.Y.Z publish --dry-run`: SteamCMD asks for the build account's password and Steam Guard code in the terminal and butler opens the browser, the first time only; every destination previews, and nothing is uploaded.
- [ ] `npx gameshipper@X.Y.Z publish --branch beta --json`, with `GITHUB_TOKEN` set as above: no prompt, exit 0. Steamworks lists the build with the version as its description and every depot has files (no `steam_appid.txt` in its manifest); the itch.io page has the `windows`, `mac` and `linux` channels tagged with their OS and the version; the GitHub repository has a draft release `v<version>` with three zips.
- [ ] Enter the launch options and Steam Cloud settings exactly as `publish` printed them, publish them in Steamworks, then install the game from the Steam library (beta branch) on each machine, not as a non-Steam game, and repeat the table above.
- [ ] On a Mac, download the Mac zip from the GitHub draft and from itch.io, open it in Finder and start the app: no Gatekeeper warning.
- [ ] Publishing again with `--to github --live` publishes the release; once more says `GITHUB_RELEASE_PUBLISHED`. With a read-only token (set the same way): `GITHUB_AUTH_FAILED`; after `unset GITHUB_TOKEN`: `GITHUB_TOKEN_MISSING`.
- [ ] From Claude Code (`gameshipper_publish`), with the logins in place, it publishes without a prompt; after deleting Gameshipper's SteamCMD login (`tools/steamcmd/home` in its cache), it returns `STEAM_LOGIN_REQUIRED`.
- [ ] On the Mac, SteamCMD left the Steam client's background job alone: `launchctl print gui/$(id -u)/com.valvesoftware.steamclean | grep -E 'path =|program ='` prints the same after the last `publish` as before the first: the Steam client's own paths, never one in Gameshipper's cache, or no such job both times if the Steam client isn't installed. `~/Library/Caches/gameshipper/tools/steamcmd/home/launchctl-calls.log` lists the `remove` and `load` calls SteamCMD made, which only Gameshipper's stand-in `launchctl` received.

**iOS and Android:** build `out/ios` and `out/android`, then run the game on an iPhone or iPad (from Xcode, or through TestFlight) and on an Android device or emulator (from Android Studio). It starts, shows the page and saves and loads.

Write down the Gameshipper version, the Electron version (`npx gameshipper status`), the Steam client version and the SteamOS and Linux versions next to the results.

## 4. Bumping the pinned Electron version

1. The Electron canary passed with the new version (section 1).
2. Set `electron` in `package.json` to that exact version, regenerate `package-lock.json` the way the plans do (in an empty folder, with `npm install --package-lock-only --ignore-scripts`), and run `npm ci`. Update the three tests that name the old version: `tests/core/targets.test.ts`, `tests/core/status.test.ts` and `tests/core/package.test.ts`.
3. Do sections 1 and 3 in full on all four machines.
4. Release as usual (section 2).
