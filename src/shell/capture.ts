// What `gameshipper play` and `gameshipper check` ask the shell to capture, passed as GAMESHIPPER_* environment
// variables. Imported by core (src/core/smoke.ts, src/core/check/) as well as the shell: it must never import
// `electron`. Keep it to plain code.

export interface Size {
  width: number;
  height: number;
}

/** Steam's store screenshot size. */
export const SCREENSHOT_SIZE: Size = { width: 1920, height: 1080 };
/** Steam Deck's screen, in CSS pixels at devicePixelRatio 1. */
export const DECK_SIZE: Size = { width: 1280, height: 800 };

/** A `check` run closes the game's window like a player; if the game is still running this long after, the shell stops it. */
export const QUIT_TIMEOUT_MS = 10_000;
/** The shell's exit code when it had to stop a game that didn't quit after its window closed. */
export const QUIT_TIMEOUT_EXIT_CODE = 3;

export interface CaptureSettings {
  /** F12 (and screenshotAt) save a 1920x1080 PNG here. Only `play` sets it, so shipped games keep F12 for Steam. */
  screenshotDir?: string;
  /** `play --screenshot`: seconds after the game loads at which to save a screenshot. */
  screenshotAt?: number[];
  /** Lay the page out at exactly this CSS size, devicePixelRatio 1, from before the game's first script. */
  viewport?: Size;
  /** `check`: block every request that isn't the game's own files, and record each one. */
  offline?: boolean;
  /** `check`: at the end of the run, save the last frame here, measure the page, then close the window like a player. */
  probeDir?: string;
}

const ENV = {
  screenshotDir: 'GAMESHIPPER_SCREENSHOT_DIR',
  screenshotAt: 'GAMESHIPPER_SCREENSHOT_AT',
  viewport: 'GAMESHIPPER_VIEWPORT',
  offline: 'GAMESHIPPER_OFFLINE',
  probeDir: 'GAMESHIPPER_PROBE_DIR',
} as const;

/** Every variable captureEnv can set. Core removes them from the environment a game inherits. */
export const CAPTURE_ENV_NAMES: readonly string[] = Object.values(ENV);

/** "1280x800" → { width: 1280, height: 800 }; null for anything else. */
export function parseSize(raw: string | undefined): Size | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(raw ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** "3, 6.5,9" → [3, 6.5, 9]. Anything that isn't a positive number is ignored. */
export function parseSecondsList(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** The environment variables for `settings`: what core passes to the shell. */
export function captureEnv(settings: CaptureSettings): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings.screenshotDir) env[ENV.screenshotDir] = settings.screenshotDir;
  if (settings.screenshotAt?.length) env[ENV.screenshotAt] = settings.screenshotAt.join(',');
  if (settings.viewport) env[ENV.viewport] = `${settings.viewport.width}x${settings.viewport.height}`;
  if (settings.offline) env[ENV.offline] = '1';
  if (settings.probeDir) env[ENV.probeDir] = settings.probeDir;
  return env;
}

/** The settings in the shell's environment: what the shell reads back. */
export function captureSettings(env: NodeJS.ProcessEnv): CaptureSettings {
  const settings: CaptureSettings = {};
  const screenshotDir = env[ENV.screenshotDir];
  if (screenshotDir) settings.screenshotDir = screenshotDir;
  const screenshotAt = parseSecondsList(env[ENV.screenshotAt]);
  if (screenshotAt.length) settings.screenshotAt = screenshotAt;
  const viewport = parseSize(env[ENV.viewport]);
  if (viewport) settings.viewport = viewport;
  if (env[ENV.offline] === '1') settings.offline = true;
  const probeDir = env[ENV.probeDir];
  if (probeDir) settings.probeDir = probeDir;
  return settings;
}

/**
 * The capture settings the shell honours. Only runs Gameshipper makes to look at the game use them: a smoke run
 * (`play --smoke`, `play --screenshot`, `check`) or the unpackaged app `play` runs. A player's launch of a shipped
 * game ignores them, so nothing in a player's environment can make it save screenshots or cut it off the network.
 */
export function shellCaptureSettings(env: NodeJS.ProcessEnv, isPackaged: boolean): CaptureSettings {
  const smoke = Number(env.GAMESHIPPER_SMOKE_SECONDS ?? '0') > 0;
  return smoke || !isPackaged ? captureSettings(env) : {};
}

/**
 * Starts a line the shell prints on stderr for the person playing (a failed F12 screenshot, say). The game's
 * output only goes to the run log; interactive `play` also shows these lines on its own stderr.
 */
const NOTICE_PREFIX = 'gameshipper-notice: ';
/** Longest output line searched for a notice; longer lines are only logged. */
const MAX_NOTICE_LINE_CHARS = 4096;

/** The line the shell prints for `message`, on one line. */
export function noticeLine(message: string): string {
  return `${NOTICE_PREFIX}${message.replace(/\s*[\r\n]+\s*/g, ' ')}\n`;
}

/**
 * A handler for one output stream's text, in chunks as they arrive: calls `onNotice` with the message of each
 * notice line (noticeLine), however the chunks split it.
 */
export function noticesIn(onNotice: (message: string) => void): (chunk: string) => void {
  let pending = '';
  return (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    if (pending.length > MAX_NOTICE_LINE_CHARS) pending = '';
    for (const line of lines) {
      const at = line.indexOf(NOTICE_PREFIX);
      if (at !== -1) onNotice(line.slice(at + NOTICE_PREFIX.length).trimEnd());
    }
  };
}

/** screenshot-2026-09-29T10-15-30-123Z.png: sorts by time and is a valid file name on every OS. */
export function screenshotFileName(now: Date = new Date()): string {
  return `screenshot-${now.toISOString().replace(/[:.]/g, '-')}.png`;
}

/** What stays allowed when `check` blocks the network: the game's own files and in-memory URLs. */
const OFFLINE_ALLOWED = /^(app|data|blob|about|devtools|chrome|chrome-extension):/i;

export function isAllowedOffline(url: string): boolean {
  return OFFLINE_ALLOWED.test(url);
}
