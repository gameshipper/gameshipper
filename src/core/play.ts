import * as path from 'node:path';
import { prepareApp, type PrepareOptions, type PreparedApp } from './build.js';
import type { Config } from './config/schema.js';
import type { Ctx } from './context.js';
import { electronBinary } from './electron.js';
import { fail, GsFailure, ok, type Result } from './result.js';
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
    await launch(ctx, electron, [prepared.appDir], { env: gameEnv(eventsLog, userDataDir, windowed) });
    return ok({ appDir: prepared.appDir, eventsLog }, prepared.warnings);
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error, prepared.warnings);
    throw e;
  }
}
