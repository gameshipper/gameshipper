export type Switch = [name: string, value?: string];

/**
 * Chromium command-line switches, pinned with the Electron version.
 * - in-process-gpu: the Steam overlay hooks rendering in the game's main process.
 * - disable-direct-composition (Windows): lets the overlay draw over the window.
 * - no-sandbox / no-zygote / disable-dev-shm-usage (Linux): Chromium's sandbox conflicts
 *   with the Steam Linux Runtime container and breaks in paths containing spaces.
 */
export function chromiumSwitches(platform: NodeJS.Platform): Switch[] {
  const switches: Switch[] = [['autoplay-policy', 'no-user-gesture-required'], ['in-process-gpu']];
  if (platform === 'win32') switches.push(['disable-direct-composition']);
  if (platform === 'linux') switches.push(['no-sandbox'], ['no-zygote'], ['disable-dev-shm-usage']);
  return switches;
}
