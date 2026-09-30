import type { Config } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { errorDetails, fail, GsFailure, gsError, internalError, ok, type Result } from '../result.js';
import { handOff as realHandOff, type HandOff } from '../tools/run.js';
import { findDesktopBuilds, mobileNextSteps, type MobileNextSteps } from './builds.js';
import { publishGithub, type GithubDetails } from './github/publish.js';
import { publishItch, type ItchDetails } from './itch/publish.js';
import { publishSteam, type SteamDetails } from './steam/publish.js';
import { DESTINATIONS, failedDestination, type Destination, type DestinationResult, type PublishEnv } from './types.js';

export type AnyDetails = SteamDetails | ItchDetails | GithubDetails;
export type AnyDestinationResult = DestinationResult<AnyDetails>;

export interface PublishData {
  version: string;
  dryRun: boolean;
  destinations: AnyDestinationResult[];
  /** iOS and Android aren't uploaded: what to do in Xcode and Android Studio. */
  mobile: MobileNextSteps[];
}

export interface PublishOptions {
  /** --to; by default every destination gameshipper.json configures. */
  to?: Destination[];
  dryRun?: boolean;
  branch?: string | null;
  steamUser?: string | null;
  repo?: string | null;
  live?: boolean;
  /** A person is at a terminal: SteamCMD and butler may take it over to log in. */
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
  handOff?: HandOff;
  notice?: (message: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Steam when it has an App ID of its own (not 480), itch.io when itch.project is set, GitHub when github.repo is. */
export function defaultDestinations(config: Config): Destination[] {
  const to: Destination[] = [];
  if (config.steam.appId !== 480) to.push('steam');
  if (config.itch.project) to.push('itch');
  if (config.github.repo) to.push('github');
  return to;
}

/** Flags that only one destination uses, and which one. */
const FLAG_DESTINATION: Array<[keyof PublishOptions, string, Destination]> = [
  ['branch', '--branch', 'steam'],
  ['steamUser', '--steam-user', 'steam'],
  ['live', '--live', 'github'],
  ['repo', '--repo', 'github'],
];

/**
 * Uploads the desktop builds in out/ to each destination, in turn: Steam, itch.io, GitHub Releases. One failing (or
 * crashing) never stops the others; each one's result is in data.destinations, and their errors and warnings are the
 * Result's.
 */
export async function runPublish(ctx: Ctx, config: Config, opts: PublishOptions = {}): Promise<Result<PublishData>> {
  const to = opts.to ?? defaultDestinations(config);
  if (!to.length) {
    return fail(
      gsError(
        'INPUT_REQUIRED',
        "There is nowhere to publish to: steam.appId is Valve's test app 480, and neither itch.project nor github.repo is set.",
        'Set steam.appId (and steam.user), itch.project or github.repo in gameshipper.json, or pass --to steam,itch,github.',
      ),
    );
  }
  for (const [option, flag, destination] of FLAG_DESTINATION) {
    if (opts[option] && !to.includes(destination)) {
      return fail(gsError('USAGE', `${flag} only applies to ${destination}, which isn't being published to.`, `Add ${destination} to --to, or leave out ${flag}.`));
    }
  }
  const found = findDesktopBuilds(ctx.projectDir, config);
  if (found.errors.length) return fail(found.errors);

  const env: PublishEnv = {
    dryRun: opts.dryRun ?? false,
    interactive: opts.interactive ?? false,
    env: opts.env ?? process.env,
    handOff: opts.handOff ?? realHandOff,
    notice: opts.notice ?? (() => {}),
    platform: opts.platform ?? process.platform,
    arch: opts.arch ?? process.arch,
  };
  const destinations: AnyDestinationResult[] = [];
  for (const dest of DESTINATIONS.filter((d) => to.includes(d))) {
    ctx.log(`publish: ${dest}${env.dryRun ? ' (dry run)' : ''}`);
    try {
      if (dest === 'steam') destinations.push(await publishSteam(ctx, config, found.builds, { ...env, steamUser: opts.steamUser ?? null, branch: opts.branch ?? null }));
      else if (dest === 'itch') destinations.push(await publishItch(ctx, config, found.builds, env));
      else destinations.push(await publishGithub(ctx, config, found.builds, { ...env, repo: opts.repo ?? null, live: opts.live ?? false }));
    } catch (e) {
      if (!(e instanceof GsFailure)) ctx.log(`publish: ${dest} crashed: ${errorDetails(e)}`);
      destinations.push(failedDestination<AnyDetails>(dest, e instanceof GsFailure ? e.error : internalError(e)));
    }
  }
  const data: PublishData = { version: config.version, dryRun: env.dryRun, destinations, mobile: mobileNextSteps(ctx.projectDir, config) };
  const errors = destinations.flatMap((d) => d.errors);
  const warnings = destinations.flatMap((d) => d.warnings);
  return errors.length ? fail(errors, warnings, data) : ok(data, warnings);
}
