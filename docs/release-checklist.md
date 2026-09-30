# Release checklist

Run this for every Gameshipper release, and in full whenever the pinned Electron version changes. Copy it into the release's tracking issue and tick it there.

## One-time setup (before the first release)

- [ ] The npm package name `gameshipper` belongs to the Gameshipper npm account (never a personal account). Until it's published, `npx gameshipper` and the plugin's `npx -y gameshipper@<version> mcp` run whatever package someone else registers under that name, so claim it before telling anyone about the tool.
- [ ] On npmjs.com, under the package's Settings, add a trusted publisher: GitHub Actions, organization `gameshipper`, repository `gameshipper`, workflow `release.yml`, environment `npm`. If npm won't add a trusted publisher to a package that doesn't exist yet, do the very first publish by hand from the Gameshipper npm account, then add it.
- [ ] In the GitHub repository settings, create the environment `npm`. Optionally require a reviewer, so every publish needs a click.

## 1. Automated checks

- [ ] CI is green on the commit you're releasing: unit tests on Linux, macOS and Windows, the workflow lint, and the macOS integration tests (which include the MCP end-to-end test). The Linux and Windows integration jobs can't fail CI yet: read their results anyway.
- [ ] If Electron changed since the last release: the **Electron canary** workflow passed with the new version (Actions → Electron canary → Run workflow), and section 3 is done on all three machines.
- [ ] On a Mac: `npm run test:integration` passes (it opens game windows).
- [ ] `claude plugin validate . --strict` and `claude plugin validate ./plugin --strict` both print `✔ Validation passed`.
- [ ] Optional, uses a little Claude usage (about $0.20 with the default model, haiku): `GAMESHIPPER_AGENT_E2E=1 npm run test:agent` prints only ✓ lines.
- [ ] `npm pack --dry-run` lists only files under `bin/`, `dist/` and `types/`, plus `package.json`, `README.md` and `LICENSE`: no `.sdk/`, `fixtures/`, `tests/` or `plugin/`.

## 2. Version and publish

- [ ] Set the new version in all four places: `package.json` (`npm version --no-git-tag-version X.Y.Z`), `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the `gameshipper@X.Y.Z` pin in `plugin/.mcp.json`. `npx vitest run tests/plugin` fails until all four match.
- [ ] Commit, then tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`. The **Release** workflow checks that the tag matches `package.json`, runs the tests, publishes to npm through trusted publishing, and creates the GitHub release.
- [ ] Afterwards, `npx gameshipper@X.Y.Z --version` prints `X.Y.Z`.

## 3. Manual Steam checks on real hardware

These need a signed-in Steam client, so CI can't run them. Use Valve's test app, App ID 480 (Spacewar), on a **Windows PC**, a **Mac** and a **Steam Deck**.

**Prepare the test game** on a Mac, from this repo, with the Steamworks SDK zip in `.sdk/` (without it the builds have no Steam features):

```bash
npm run build
game="$TMPDIR/release-check" && rm -rf "$game" && cp -R fixtures/release-check "$game"
node bin/gameshipper.js init --yes --name "Release Check" --dir "$game"
node bin/gameshipper.js build --steam-sdk "$(ls .sdk/steamworks_sdk_*.zip | tail -1)" --dir "$game"
```

Copy `out/windows` to the PC and `out/linux` to the Deck (over USB, or with `scp` in the Deck's Desktop Mode).

**Launch it through Steam** on each machine: Steam → Games → Add a Non-Steam Game to My Library → Browse, then pick `Release Check.exe` (Windows), `Release Check.app` (Mac) or `release-check` (Deck, in Desktop Mode). Start it from the Steam library; on the Deck, switch to Game Mode first. Steam only hooks its overlay into games it launched.

The page shows whether Steam is running for the game, the player's Steam name, a log of every call, and live gamepad input.

| Check | How | Passes when | Win | Mac | Deck |
|---|---|---|---|---|---|
| Overlay | Press Shift+Tab (Deck: the Steam button) | The Steam overlay opens over the game and closes again, and the blue square keeps spinning | ☐ | ☐ | ☐ |
| Achievement | Click **Unlock ACH_WIN_ONE_GAME** | Steam shows Spacewar's achievement pop-up. Click **Clear ACH_WIN_ONE_GAME** afterwards to reset it | ☐ | ☐ | ☐ |
| Gamepad with Steam Input | Connect a controller with Steam Input on for this game (Deck: the built-in controls), press buttons and move the sticks | The Gamepads panel lists the pad and follows the buttons and sticks | ☐ | ☐ | ☐ |
| Clean exit | Click **Quit**; start it again and close the window instead | The library shows **Play** again within a few seconds (not Running or Stop), and no process is left over (Task Manager, Activity Monitor, `ps aux \| grep -i release`) | ☐ | ☐ | ☐ |
| Cloud save | Needs an App ID of your own with Steam Auto-Cloud set up in the Steamworks dashboard for the saves folder ([README, Saves](../README.md#saves)): App 480 can't sync it. Build with that App ID, click **Save** on one machine, quit, then **Load** on another machine signed in to the same account | The count, time and machine from the first machine appear | ☐ | ☐ | ☐ |

Write down the Gameshipper version, the Electron version (`npx gameshipper status`), the Steam client version and the SteamOS version next to the results.

## 4. Bumping the pinned Electron version

1. The Electron canary passed with the new version (section 1).
2. Set `electron` in `package.json` to that exact version, regenerate `package-lock.json` the way the plans do (in an empty folder, with `npm install --package-lock-only --ignore-scripts`), and run `npm ci`. Update the three tests that name the old version: `tests/core/targets.test.ts`, `tests/core/status.test.ts` and `tests/core/package.test.ts`.
3. Do sections 1 and 3 in full on all three machines.
4. Release as usual (section 2).
