import * as path from 'node:path';
import { captureEnv, SCREENSHOT_SIZE, type CaptureSettings } from '../shell/capture.js';
import { screenshotDirFor } from './assets/sizes.js';
import { prepareApp, type PrepareOptions, type PreparedApp } from './build.js';
import type { Config } from './config/schema.js';
import type { Ctx } from './context.js';
import { electronBinary } from './electron.js';
import { QUIT_GRACE_MS } from './proc.js';
import { fail, GsFailure, gsError, ok, type GsError, type Result } from './result.js';
import { eventsLogPath, gameEnv, launch, readLoggedEvents, runSmoke, type SmokeData } from './smoke.js';

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

export async function runPlay(ctx: Ctx, config: Config, opts: PlayOptions): Promise<Result<PlayData>> {
  let prepared: PreparedApp;
  try {
    // Steam support for this computer only: play runs the unpackaged app here.
    prepared = await prepareApp(ctx, config, opts, 'play', [{ platform: process.platform, arch: process.arch }]);
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error);
    throw e;
  }
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
    const electron = opts.electronPath ?? electronBinary();
    if (smokeSeconds) {
      const smoke = await runSmoke(ctx, { command: electron, args: [prepared.appDir], seconds: smokeSeconds, userDataDir, windowed, capture });
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
      const data: PlayData = { appDir: prepared.appDir, smoke: smoke.data, screenshots };
      return { ...smoke, ok: errors.length === 0, errors, data, warnings: [...prepared.warnings, ...smoke.warnings] };
    }
    const eventsLog = eventsLogPath(ctx.projectDir);
    ctx.log(`playing: ${electron} ${prepared.appDir}`);
    const data: PlayData = { appDir: prepared.appDir, eventsLog };
    // On Ctrl+C the game gets to quit properly, finishing any save in flight; smoke runs are stopped at once.
    const env = { ...gameEnv(eventsLog, userDataDir, windowed), ...captureEnv(capture) };
    const running = launch(ctx, electron, [prepared.appDir], { env, quitGraceMs: QUIT_GRACE_MS, onNotice: opts.onNotice });
    opts.onGameStarted?.(data, prepared.warnings);
    const run = await running;
    data.screenshots = savedScreenshots(eventsLog);
    // Interactive play has no timeout, so any signal came from outside Gameshipper (a crash or a kill), or
    // from stopping a game that didn't quit after Ctrl+C, which the CLI has already reported.
    if (run.exitCode === 0) return ok(data, prepared.warnings);
    const how = run.signal ? `stopped by ${run.signal}` : `exit code ${run.exitCode}`;
    const message = run.outputTail.trim()
      ? `The game quit unexpectedly (${how}). Last lines of its output:\n${run.outputTail}`
      : `The game quit unexpectedly (${how}).`;
    return fail(
      gsError('GAME_EXITED', message, `Its full output is in ${ctx.logPath}. Run \`npx gameshipper play --smoke --json\` to collect the game's errors.`),
      prepared.warnings,
      data,
    );
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error, prepared.warnings);
    throw e;
  }
}
