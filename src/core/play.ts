import * as path from 'node:path';
import { prepareApp, type PrepareOptions, type PreparedApp } from './build.js';
import type { Config } from './config/schema.js';
import type { Ctx } from './context.js';
import { electronBinary } from './electron.js';
import { QUIT_GRACE_MS } from './proc.js';
import { fail, GsFailure, gsError, ok, type Result } from './result.js';
import { eventsLogPath, gameEnv, launch, runSmoke, type SmokeData } from './smoke.js';

export interface PlayOptions extends PrepareOptions {
  /** Set to run a smoke test for this many seconds instead of an interactive session. */
  smokeSeconds?: number;
  fullscreen?: boolean;
  /** Injectable for tests; defaults to the Electron binary installed with Gameshipper. */
  electronPath?: string;
}

export interface PlayData {
  appDir: string;
  smoke?: SmokeData;
  eventsLog?: string;
}

export async function runPlay(ctx: Ctx, config: Config, opts: PlayOptions): Promise<Result<PlayData>> {
  let prepared: PreparedApp;
  try {
    prepared = await prepareApp(ctx, config, opts);
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error);
    throw e;
  }
  const userDataDir = path.join(ctx.projectDir, '.gameshipper', 'play-data');
  const windowed = !opts.fullscreen;

  try {
    const electron = opts.electronPath ?? electronBinary();
    if (opts.smokeSeconds) {
      const smoke = await runSmoke(ctx, { command: electron, args: [prepared.appDir], seconds: opts.smokeSeconds, userDataDir, windowed });
      return { ...smoke, data: { appDir: prepared.appDir, smoke: smoke.data }, warnings: [...prepared.warnings, ...smoke.warnings] };
    }
    const eventsLog = eventsLogPath(ctx.projectDir);
    ctx.log(`playing: ${electron} ${prepared.appDir}`);
    // On Ctrl+C the game gets to quit properly, finishing any save in flight; smoke runs are stopped at once.
    const run = await launch(ctx, electron, [prepared.appDir], { env: gameEnv(eventsLog, userDataDir, windowed), quitGraceMs: QUIT_GRACE_MS });
    const data: PlayData = { appDir: prepared.appDir, eventsLog };
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
