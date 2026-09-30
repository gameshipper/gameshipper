import type { Config, DesktopTarget } from '../../config/schema.js';
import type { Ctx } from '../../context.js';
import { gsError, type GsError } from '../../result.js';
import { runExternal, type ToolCommand } from '../../tools/run.js';
import type { DesktopBuild } from '../builds.js';
import { failedDestination, type DestinationResult, type PublishEnv } from '../types.js';
import { butlerErrors, butlerResult, ensureButler, parseButlerJson } from './butler.js';

export interface ItchDetails {
  project: string;
  pageUrl: string;
  channels: Array<{ target: DesktopTarget; channel: string; buildId: number | null }>;
}

export type ItchOptions = PublishEnv & { timeoutMs?: number };

/** Channel names itch.io tags as Windows, macOS and Linux downloads by themselves. */
const CHANNELS: Record<DesktopTarget, string> = { windows: 'windows', mac: 'mac', linux: 'linux' };
const PUSH_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const LOGIN_CHECK_TIMEOUT_MS = 2 * 60 * 1000;

/** Asks butler whether its login works, without it ever prompting (no stdin). */
export async function checkButlerLogin(ctx: Ctx, tool: ToolCommand): Promise<{ ok: boolean; reason: string }> {
  const r = await runExternal(tool, ['--json', 'login'], { timeoutMs: LOGIN_CHECK_TIMEOUT_MS, onLine: (l) => ctx.log(`butler: ${l}`) });
  const messages = parseButlerJson(r.output);
  if (r.exitCode === 0 && butlerResult(messages)?.status === 'success') return { ok: true, reason: '' };
  return { ok: false, reason: butlerErrors(messages)[0] ?? r.spawnError ?? `butler exited with code ${r.exitCode}` };
}

/** Pushes out/windows, out/mac and out/linux to the itch.io channels windows, mac and linux, versioned. */
export async function publishItch(ctx: Ctx, config: Config, builds: DesktopBuild[], opts: ItchOptions): Promise<DestinationResult<ItchDetails>> {
  const project = config.itch.project;
  if (!project) {
    return failedDestination<ItchDetails>(
      'itch',
      gsError(
        'INPUT_REQUIRED',
        'Uploading to itch.io needs your game there.',
        'Create the game on itch.io, then set itch.project in gameshipper.json to your-username/your-game (from its page, https://your-username.itch.io/your-game).',
      ),
    );
  }
  const [user, game] = project.split('/');
  const details: ItchDetails = {
    project,
    pageUrl: `https://${user}.itch.io/${game}`,
    channels: builds.map((b) => ({ target: b.target, channel: CHANNELS[b.target], buildId: null })),
  };
  const warnings: GsError[] = [
    gsError(
      'ITCH_UPLOADS_LIVE',
      `itch.io makes uploads downloadable at once if ${details.pageUrl} is public.`,
      'To try a build privately first, keep the page in Draft or Restricted until you are ready.',
    ),
  ];
  const tool = await ensureButler(ctx, { env: opts.env, platform: opts.platform, arch: opts.arch });

  const login = await checkButlerLogin(ctx, tool);
  if (!login.ok) {
    const apiKey = Boolean(opts.env.BUTLER_API_KEY);
    const required = apiKey
      ? gsError(
          'ITCH_LOGIN_REQUIRED',
          `itch.io refused BUTLER_API_KEY (${login.reason}).`,
          "Set BUTLER_API_KEY to a working key from itch.io (Settings → API keys), or unset it to use butler's own login, then publish again.",
        )
      : gsError(
          'ITCH_LOGIN_REQUIRED',
          `butler isn't logged in to itch.io (${login.reason}).`,
          'Ask the human to run `npx gameshipper publish --to itch --dry-run` once in their own terminal, in the game folder: butler opens the browser to log in to itch.io and keeps the login. In CI, set BUTLER_API_KEY instead. Then publish again.',
        );
    if (!opts.interactive || apiKey) {
      // A dry run needs no login: it can still list what would be pushed.
      if (!opts.dryRun) return failedDestination('itch', required, warnings, details);
      warnings.push(required);
    } else {
      opts.notice('itch.io needs you to log in: butler opens your browser (or prints a link) to do it, and keeps the login itself.');
      ctx.log('itch: handing the terminal to butler to log in');
      const code = await opts.handOff(tool, ['login']);
      const again = code === 0 ? await checkButlerLogin(ctx, tool) : { ok: false, reason: `butler exited with code ${code}` };
      if (!again.ok) {
        return failedDestination(
          'itch',
          gsError('ITCH_LOGIN_FAILED', `butler couldn't log in to itch.io: ${again.reason}.`, 'Finish the login in the browser window butler opens, then publish again.'),
          warnings,
          details,
        );
      }
    }
  }

  const errors: GsError[] = [];
  for (const [i, build] of builds.entries()) {
    const channel = details.channels[i];
    const args = ['--json', 'push', ...(opts.dryRun ? ['--dry-run'] : []), build.dir, `${project}:${channel.channel}`, '--userversion', config.version];
    const r = await runExternal(tool, args, { timeoutMs: opts.timeoutMs ?? PUSH_TIMEOUT_MS, onLine: (l) => ctx.log(`butler: ${l}`) });
    const messages = parseButlerJson(r.output);
    const pushed = butlerResult(messages);
    if (r.exitCode === 0 && pushed) {
      channel.buildId = typeof pushed.buildId === 'number' && pushed.buildId > 0 ? pushed.buildId : null;
      continue;
    }
    const reason = butlerErrors(messages).join('; ') || r.spawnError || (r.timedOut ? "it didn't finish in time" : `butler exited with code ${r.exitCode}`);
    errors.push(
      gsError(
        'ITCH_PUSH_FAILED',
        `Pushing ${build.target} to ${project}:${channel.channel} failed: ${reason}`,
        `Check that itch.project (${project}) is a game your itch.io account owns: create its page on itch.io first. butler's full output is in ${ctx.logPath}.`,
      ),
    );
  }
  if (errors.length) return failedDestination('itch', errors, warnings, details);
  return { to: 'itch', status: opts.dryRun ? 'previewed' : 'uploaded', details, errors: [], warnings };
}
