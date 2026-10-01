import { isDiagnosticRun } from './capture.js';

export type Switch = [name: string, value?: string];

/**
 * GAMESHIPPER_SOFTWARE_GL=1, honoured only in runs Gameshipper makes to look at the game (capture.ts
 * isDiagnosticRun): a player's environment never changes how a shipped game renders.
 */
export function softwareGl(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  return env.GAMESHIPPER_SOFTWARE_GL === '1' && isDiagnosticRun(env, isPackaged);
}

/**
 * Chromium command-line switches, pinned with the Electron version.
 * - in-process-gpu: the Steam overlay hooks rendering in the game's main process.
 * - disable-direct-composition (Windows): lets the overlay draw over the window.
 * - no-sandbox / no-zygote / disable-dev-shm-usage (Linux): Chromium's sandbox conflicts
 *   with the Steam Linux Runtime container and breaks in paths containing spaces. Appended here they reach the
 *   processes Chromium starts from then on; its own sandbox check comes before any of this code runs, so
 *   Gameshipper also starts every game with --no-sandbox on its command line (core/smoke.ts launchArgs).
 * - enable-unsafe-swiftshader (only with `softwareGl`, see softwareGl above): machines without a GPU, such as
 *   hosted CI runners, may render WebGL in software. Chromium no longer falls back to it by itself.
 */
export function chromiumSwitches(platform: NodeJS.Platform, opts: { softwareGl?: boolean } = {}): Switch[] {
  const switches: Switch[] = [['autoplay-policy', 'no-user-gesture-required'], ['in-process-gpu']];
  if (opts.softwareGl) switches.push(['enable-unsafe-swiftshader']);
  if (platform === 'win32') switches.push(['disable-direct-composition']);
  if (platform === 'linux') switches.push(['no-sandbox'], ['no-zygote'], ['disable-dev-shm-usage']);
  return switches;
}
