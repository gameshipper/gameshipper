import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureEnv, SCREENSHOT_SIZE, type CaptureSettings } from '../shell/capture.js';
import { screenshotDirFor } from './assets/sizes.js';
import { prepareApp, type PrepareOptions, type PreparedApp } from './build.js';
import { hostTarget } from './check/run.js';
import type { Config } from './config/schema.js';
import type { Ctx } from './context.js';
import { executableFor } from './desktop/package.js';
import { electronBinary } from './electron.js';
import { storeArtNames } from './prepare/stage.js';
import { QUIT_GRACE_MS } from './proc.js';
import { fail, GsFailure, gsError, ok, type GsError, type Result } from './result.js';
import { eventsLogPath, gameEnv, launch, launchDetached, readLoggedEvents, runSmoke, type SmokeData } from './smoke.js';

export interface PlayOptions extends PrepareOptions {
  /** Set to run a smoke test for this many seconds instead of an interactive session. */
  smokeSeconds?: number;
  fullscreen?: boolean;
  /** Injectable for tests; defaults to the Electron binary installed with Gameshipper. */
  electronPath?: string;
  /**
   * Interactive play: called once the game has launched, with the data and warnings its result will
   * carry. The CLI uses them to report a session a person ends with Ctrl+C.
   */
  onGameStarted?: (data: PlayData, warnings: GsError[]) => void;
  /** `--screenshot`: save a 1920x1080 store screenshot this many seconds after the game loads, for each entry, then quit. */
  screenshotAt?: number[];
  /** Interactive play: called with what the shell tells the person playing, such as a failed F12 screenshot. */
  onNotice?: (message: string) => void;
  /** `--packaged`: run this computer's build in out/<target> (made by `build`) as it is, instead of preparing the game. */
  packaged?: boolean;
  /** `--detach`, interactive play only: start the game and return at once with its process ID. */
  detach?: boolean;
  /** Injectable for tests; defaults to this computer's OS. */
  host?: NodeJS.Platform;
}

export interface PlayData {
  appDir: string;
  smoke?: SmokeData;
  eventsLog?: string;
  /**
   * Store screenshots saved in out/store/screenshots during the run (F12, or `--screenshot`). Set once the game has
   * closed; a session ended with Ctrl+C reports without them (the events log lists them).
   */
  screenshots?: string[];
  /** `--detach`: the game's process ID. It keeps running after play returns. */
  pid?: number;
}

/** Most screenshot times `--screenshot` takes, and the latest (in seconds after the game loads). */
export const MAX_SCREENSHOTS = 20;
export const MAX_SCREENSHOT_SECONDS = 600;
/** A screenshot run quits this long after its last screenshot. */
const SCREENSHOT_TAIL_SECONDS = 2;

/** `--screenshot 5,10,15`: 1 to MAX_SCREENSHOTS positive numbers of seconds, each at most MAX_SCREENSHOT_SECONDS. null if invalid. */
export function parseScreenshotTimes(raw: string): number[] | null {
  const parts = raw.split(',').map((s) => s.trim());
  const times = parts.map(Number);
  const valid =
    parts.length <= MAX_SCREENSHOTS && parts.every((s) => s !== '') && times.every((t) => Number.isFinite(t) && t > 0 && t <= MAX_SCREENSHOT_SECONDS);
  return valid ? times : null;
}

/** How long a `--screenshot` run lasts: until shortly after its last screenshot, or `smokeSeconds` if that's longer. */
export function screenshotRunSeconds(at: number[], smokeSeconds?: number): number {
  return Math.max(smokeSeconds ?? 0, Math.max(...at) + SCREENSHOT_TAIL_SECONDS);
}

/** The screenshots a run saved, from its events log. */
function savedScreenshots(eventsLog: string): string[] {
  return readLoggedEvents(eventsLog, ['screenshot']).map((e) => e.file);
}

/** What play starts: Electron with the prepared app, or (`--packaged`) the build in out/<target>. */
interface Game {
  command: string;
  args: string[];
  /** The app folder: .gameshipper/app, or out/<target>. */
  appDir: string;
}

/** This computer's build in out/<target>, as `build` made it. PACKAGED_BUILD_MISSING when there's none. */
export function packagedGame(projectDir: string, config: Config, host: NodeJS.Platform): Game {
  const target = hostTarget(host);
  if (!target) {
    throw new GsFailure('PACKAGED_BUILD_MISSING', `Gameshipper doesn't make builds for ${host}.`, 'Run `npx gameshipper play` without --packaged.');
  }
  const appDir = path.join(projectDir, 'out', target);
  const command = executableFor(config, target, appDir);
  if (!fs.existsSync(command)) {
    const build = `npx gameshipper build --target ${target}`;
    throw new GsFailure(
      'PACKAGED_BUILD_MISSING',
      `There's no ${target} build at ${path.relative(projectDir, command).split(path.sep).join('/')}.`,
      config.targets.includes(target) ? `Run \`${build}\` first.` : `Add "${target}" to "targets" in gameshipper.json, then run \`${build}\`.`,
    );
  }
  return { command, args: [], appDir };
}

export async function runPlay(ctx: Ctx, config: Config, opts: PlayOptions): Promise<Result<PlayData>> {
  if (opts.detach && (opts.smokeSeconds || opts.screenshotAt?.length)) {
    return fail(
      gsError(
        'USAGE',
        "detach can't be combined with a timed run (smokeSeconds or screenshotAt).",
        'Drop detach: timed runs always wait for the game to finish.',
      ),
    );
  }
  let prepared: PreparedApp | null = null;
  try {
    // --packaged runs the build as it is. Otherwise the app is prepared with Steam support for this computer only:
    // play runs the unpackaged app here.
    if (!opts.packaged) prepared = await prepareApp(ctx, config, opts, 'play', [{ platform: process.platform, arch: process.arch }]);
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error);
    throw e;
  }
  const warnings = prepared?.warnings ?? [];
  const userDataDir = path.join(ctx.projectDir, '.gameshipper', 'play-data');
  const windowed = !opts.fullscreen;
  // F12 saves store screenshots in every play session. Shipped games never get this setting, so F12 stays Steam's.
  const capture: CaptureSettings = { screenshotDir: screenshotDirFor(ctx.projectDir) };
  const at = opts.screenshotAt ?? [];
  if (at.length) {
    // Laid out at 1920x1080 from the start, so even a game that never handles a resize fills the frame.
    capture.screenshotAt = at;
    capture.viewport = SCREENSHOT_SIZE;
  }
  const smokeSeconds = at.length ? screenshotRunSeconds(at, opts.smokeSeconds) : opts.smokeSeconds;

  try {
    const game: Game = prepared
      ? { command: opts.electronPath ?? electronBinary(), args: [prepared.appDir], appDir: prepared.appDir }
      : packagedGame(ctx.projectDir, config, opts.host ?? process.platform);
    if (smokeSeconds) {
      const storeArt = storeArtNames(config);
      const smoke = await runSmoke(ctx, { command: game.command, args: game.args, seconds: smokeSeconds, userDataDir, windowed, capture, storeArt });
      const screenshots = smoke.data ? savedScreenshots(smoke.data.eventsLog) : [];
      const errors = [...smoke.errors];
      if (smoke.data && screenshots.length < at.length) {
        errors.push(
          gsError(
            'SCREENSHOT_FAILED',
            `Saved ${screenshots.length} of the ${at.length} screenshot${at.length === 1 ? '' : 's'} asked for.`,
            'The SCREENSHOT_FAILED warnings say why. A screenshot time later than the game ran is skipped too: check the times, then try again.',
          ),
        );
      }
      const data: PlayData = { appDir: game.appDir, smoke: smoke.data, screenshots };
      return { ...smoke, ok: errors.length === 0, errors, data, warnings: [...warnings, ...smoke.warnings] };
    }
    const eventsLog = eventsLogPath(ctx.projectDir);
    ctx.log(`playing: ${[game.command, ...game.args].join(' ')}`);
    const data: PlayData = { appDir: game.appDir, eventsLog };
    const env = { ...gameEnv(eventsLog, userDataDir, windowed), ...captureEnv(capture) };
    if (opts.detach) {
      data.pid = await launchDetached(ctx, game.command, game.args, env);
      return ok(data, warnings);
    }
    // On Ctrl+C the game gets to quit properly, finishing any save in flight; smoke runs are stopped at once.
    const running = launch(ctx, game.command, game.args, { env, quitGraceMs: QUIT_GRACE_MS, onNotice: opts.onNotice });
    opts.onGameStarted?.(data, warnings);
    const run = await running;
    data.screenshots = savedScreenshots(eventsLog);
    // Interactive play has no timeout, so any signal came from outside Gameshipper (a crash or a kill), or
    // from stopping a game that didn't quit after Ctrl+C, which the CLI has already reported.
    if (run.exitCode === 0) return ok(data, warnings);
    const how = run.signal ? `stopped by ${run.signal}` : `exit code ${run.exitCode}`;
    const message = run.outputTail.trim()
      ? `The game quit unexpectedly (${how}). Last lines of its output:\n${run.outputTail}`
      : `The game quit unexpectedly (${how}).`;
    return fail(
      gsError('GAME_EXITED', message, `Its full output is in ${ctx.logPath}. Run \`npx gameshipper play --smoke --json\` to collect the game's errors.`),
      warnings,
      data,
    );
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error, warnings);
    throw e;
  }
}
