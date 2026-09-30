import * as fs from 'node:fs';
import * as path from 'node:path';
import { STEAM_USER_PATTERN, type Config, type DesktopTarget } from '../../config/schema.js';
import type { Ctx } from '../../context.js';
import { gsError, type GsError } from '../../result.js';
import { runExternal, type ToolCommand } from '../../tools/run.js';
import type { DesktopBuild } from '../builds.js';
import { failedDestination, type DestinationResult, type PublishEnv } from '../types.js';
import { steamDashboard, type SteamDashboard } from './dashboard.js';
import { judgeSteamRun, STEAM_LOGIN_PROMPT, type SteamOutcome } from './judge.js';
import { ensureSteamCmd } from './steamcmd.js';
import { writeSteamScripts, type SteamScripts } from './vdf.js';

export interface SteamDetails {
  appId: number;
  user: string;
  /** Set after a real upload. */
  buildId: number | null;
  /** The beta branch the build is live on, if it was set live. */
  branch: string | null;
  depots: Array<{ target: DesktopTarget; depotId: number }>;
  appBuildScript: string;
  dashboard: SteamDashboard;
}

export interface SteamOptions extends PublishEnv {
  /** --steam-user; else steam.user in gameshipper.json. */
  steamUser: string | null;
  /** --branch: a beta branch to set the build live on. */
  branch: string | null;
  timeoutMs?: number;
}

/** A large first upload over a slow line takes hours; this only stops a SteamCMD that hangs. */
export const STEAM_UPLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BRANCH_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
/** Never wait at a prompt: SteamCMD fails instead, so a run nobody watches can't hang. */
const NO_PROMPT = ['+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1'];

function cantRunFix(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'On Apple Silicon Macs SteamCMD needs Rosetta 2: run `softwareupdate --install-rosetta --agree-to-license`, then publish again.';
  if (platform === 'linux') {
    return 'SteamCMD is a 32-bit program: install its libraries (Debian and Ubuntu: `sudo apt install lib32gcc-s1`; Fedora: `sudo dnf install glibc.i686 libstdc++.i686`), then publish again.';
  }
  return "Check that antivirus software isn't blocking steamcmd.exe in Gameshipper's cache folder, then publish again.";
}

async function runUpload(ctx: Ctx, tool: ToolCommand, user: string, scripts: SteamScripts, appId: number, preview: boolean, timeoutMs: number): Promise<SteamOutcome> {
  const buildLog = path.join(scripts.outputDir, `app_build_${appId}.log`);
  fs.rmSync(buildLog, { force: true });
  const r = await runExternal(tool, [...NO_PROMPT, '+login', user, '+run_app_build', scripts.appBuild, '+quit'], {
    timeoutMs,
    onLine: (line) => ctx.log(`steamcmd: ${line}`),
    stopOn: STEAM_LOGIN_PROMPT,
  });
  const log = fs.existsSync(buildLog) ? fs.readFileSync(buildLog, 'utf8') : '';
  return judgeSteamRun({ appId, preview, exitCode: r.exitCode, timedOut: r.timedOut, spawnError: r.spawnError, output: `${r.output}\n${log}` });
}

/** Uploads every desktop build as one Steam build, one depot per OS, with SteamCMD. */
export async function publishSteam(ctx: Ctx, config: Config, builds: DesktopBuild[], opts: SteamOptions): Promise<DestinationResult<SteamDetails>> {
  const fail = (error: GsError, details?: SteamDetails) => failedDestination<SteamDetails>('steam', error, [], details);
  const appId = config.steam.appId;
  if (appId === 480) {
    return fail(
      gsError(
        'STEAM_TEST_APP',
        "steam.appId is 480, Valve's shared test app (Spacewar): builds can't be uploaded to it.",
        'Set steam.appId in gameshipper.json to your own App ID (from the Steamworks dashboard), build again, then publish.',
      ),
    );
  }
  const user = opts.steamUser ?? config.steam.user;
  if (!user) {
    return fail(
      gsError(
        'INPUT_REQUIRED',
        'Uploading to Steam needs the Steam account that uploads builds.',
        "Pass --steam-user <account> or set steam.user in gameshipper.json. The account needs Steamworks' Edit App Metadata and Publish App Changes To Steam permissions; Valve recommends an account just for builds.",
      ),
    );
  }
  if (!STEAM_USER_PATTERN.test(user)) {
    return fail(gsError('USAGE', `"${user}" isn't a Steam account name.`, 'Steam account names are 3-64 letters, numbers or underscores: the name you sign in with, not your profile name.'));
  }
  const branch = opts.branch;
  const dashboard = steamDashboard(config, builds.map((b) => b.target));
  if (branch !== null) {
    if (branch.toLowerCase() === 'default') {
      return fail(
        gsError(
          'STEAM_DEFAULT_BRANCH',
          "Steam doesn't let SteamCMD set a build live on the default branch; only the Steamworks website can.",
          `Publish without --branch to upload, then set the build live on "default" at ${dashboard.buildsUrl}.`,
        ),
      );
    }
    if (!BRANCH_PATTERN.test(branch)) return fail(gsError('USAGE', `"${branch}" isn't a branch name.`, 'Name an existing beta branch, e.g. --branch beta.'));
  }

  const tool = await ensureSteamCmd(ctx, { env: opts.env, platform: opts.platform, arch: opts.arch });
  const preview = opts.dryRun;
  const scripts = writeSteamScripts(ctx.projectDir, config, builds, { preview, setLive: branch });
  const details: SteamDetails = {
    appId,
    user,
    buildId: null,
    branch: null,
    depots: scripts.depots.map(({ target, depotId }) => ({ target, depotId })),
    appBuildScript: scripts.appBuild,
    dashboard,
  };
  const timeoutMs = opts.timeoutMs ?? STEAM_UPLOAD_TIMEOUT_MS;
  const loginFailed = (why: string) =>
    gsError(
      'STEAM_LOGIN_FAILED',
      `SteamCMD couldn't log in as ${user}: ${why}.`,
      'Check the account name and password, approve the login in the Steam Mobile app or type the Steam Guard code, then publish again.',
    );

  let outcome = await runUpload(ctx, tool, user, scripts, appId, preview, timeoutMs);
  if (outcome.kind === 'login-required') {
    if (!opts.interactive) {
      return fail(
        gsError(
          'STEAM_LOGIN_REQUIRED',
          `SteamCMD has no saved login for ${user} on this computer (${outcome.reason}).`,
          `Ask the human to run \`npx gameshipper publish --to steam --dry-run --steam-user ${user}\` once in their own terminal, in the game folder: SteamCMD asks for the password and Steam Guard code there, and Gameshipper never sees them. Then publish again.`,
        ),
        details,
      );
    }
    opts.notice(`Steam needs you to log in as ${user}. SteamCMD asks for the password and Steam Guard code below; Gameshipper never sees them.`);
    ctx.log(`steam: handing the terminal to SteamCMD to log in as ${user}`);
    const code = await opts.handOff(tool, ['+@ShutdownOnFailedCommand', '1', '+login', user, '+quit']);
    if (code !== 0) return fail(loginFailed(`SteamCMD exited with code ${code}; its reason is above`), details);
    outcome = await runUpload(ctx, tool, user, scripts, appId, preview, timeoutMs);
    if (outcome.kind === 'login-required') return fail(loginFailed(outcome.reason), details);
  }

  switch (outcome.kind) {
    case 'cant-run':
      return fail(gsError('STEAMCMD_CANT_RUN', `SteamCMD can't run on this computer: ${outcome.reason}`, cantRunFix(opts.platform)), details);
    case 'failed':
      return fail(
        gsError(
          'STEAM_UPLOAD_FAILED',
          `The SteamCMD ${preview ? 'preview' : 'upload'} failed: ${outcome.reasons.join('; ')}`,
          `"Access Denied" means ${user} can't upload builds for app ${appId}: give it Edit App Metadata and Publish App Changes To Steam in Steamworks (Users & Permissions), and check the depot IDs match SteamPipe → Depots (steam.depots in gameshipper.json; by default the App ID + 1, 2 and 3). SteamCMD's full output is in ${ctx.logPath}.`,
        ),
        details,
      );
    case 'previewed':
      return { to: 'steam', status: 'previewed', details, errors: [], warnings: [] };
    case 'uploaded':
      details.buildId = outcome.buildId;
      if (outcome.setLiveFailed && branch) {
        const error = gsError(
          'STEAM_SET_LIVE_FAILED',
          `Build ${outcome.buildId} was uploaded, but Steam didn't set it live on the "${branch}" branch.`,
          `Create the "${branch}" branch in Steamworks (SteamPipe → Builds; a new app gets other branches only after its default branch has had a build live) and check ${user} may set builds live. Then set build ${outcome.buildId} live at ${dashboard.buildsUrl}.`,
        );
        return { to: 'steam', status: 'uploaded', details, errors: [error], warnings: [] };
      }
      details.branch = branch;
      return { to: 'steam', status: 'uploaded', details, errors: [], warnings: [] };
  }
}
