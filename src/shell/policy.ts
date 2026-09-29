/** True for pages and files of the game itself: app://game/... */
export function isGameUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.host === 'game';
  } catch {
    return false;
  }
}

export type NavigationAction = 'allow' | 'open-external' | 'block';

/** Links the system opens for the player: the web browser, their mail app, or Steam. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'steam:']);

/** The game window may only show game pages; web, mail and Steam links go to the system. */
export function navigationAction(url: string): NavigationAction {
  if (isGameUrl(url)) return 'allow';
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol) ? 'open-external' : 'block';
  } catch {
    return 'block';
  }
}

/** The origin of the game's own pages and of frames they create (about:blank, srcdoc). */
export const GAME_ORIGIN = 'app://game';

export type LeaveAction = 'open-external' | 'block';

/**
 * What to do when something asks to take the player to `url`, which isn't a game page: in a new window, or by
 * navigating the game window. `from` is the origin of the frame that asked, or null when that isn't known.
 * Only the game itself may open web, mail and Steam links in the player's browser or app: a link from any
 * other frame (an embedded site or ad) is blocked, like every other URL.
 */
export function leaveAction(url: string, from: string | null | undefined): LeaveAction {
  return from === GAME_ORIGIN && navigationAction(url) === 'open-external' ? 'open-external' : 'block';
}

/**
 * The origin of the frame behind a new-window request (window.open, a target=_blank link), as far as it can be
 * known. Electron 44's window-open handler doesn't say which frame asked (its details have no frame, and
 * Chromium sends no referrer from app:// pages), so it's the game only when every frame in the window is the
 * game's; otherwise null. `frameOrigins` are the origins of all the window's frames, the main frame included.
 * A frame that failed to load, or a sandboxed one, has the origin "null", so it counts as not the game's.
 */
export function newWindowSource(frameOrigins: readonly string[]): string | null {
  return frameOrigins.length > 0 && frameOrigins.every((origin) => origin === GAME_ORIGIN) ? GAME_ORIGIN : null;
}

/** Landing off the game again this soon after being sent back counts as a loop. */
export const RETURN_LOOP_MS = 5000;

/**
 * When the window lands on a page that isn't the game (about:blank, say), whether to load the game again.
 * `lastReturn` is when it was last sent back (null if never): a game that keeps navigating away within
 * RETURN_LOOP_MS would otherwise be reloaded forever.
 */
export function returnToGame(lastReturn: number | null, now: number): boolean {
  return lastReturn === null || now - lastReturn >= RETURN_LOOP_MS;
}

/** Chromium's net::ERR_ABORTED: the load was stopped or cancelled, not broken. */
export const ERR_ABORTED = -3;

export type LoadFailure = 'fatal' | 'stopped' | 'frame-failed' | 'ignore';

/**
 * What a did-fail-load means for the game. Only the main page failing to load is fatal.
 * ERR_ABORTED on the main page means its load was stopped (e.g. window.stop()): the page is
 * still running, but did-finish-load won't follow. A failed iframe (for example one blocked by
 * cross-origin isolation) doesn't stop the game but is worth reporting; aborted ones aren't.
 */
export function classifyLoadFailure(errorCode: number, isMainFrame: boolean): LoadFailure {
  if (isMainFrame) return errorCode === ERR_ABORTED ? 'stopped' : 'fatal';
  return errorCode === ERR_ABORTED ? 'ignore' : 'frame-failed';
}

const ALLOWED_PERMISSIONS = new Set([
  'fullscreen',
  'automatic-fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'screen-wake-lock',
  'persistent-storage',
]);

/**
 * Games get fullscreen, pointer and keyboard lock, clipboard writes (share codes), keeping the
 * screen awake and persistent storage. Everything else (camera, microphone, location,
 * notifications, clipboard reads...) is denied.
 */
export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Cross-origin isolation, so SharedArrayBuffer works for threaded engines (Emscripten, Godot).
 * `credentialless` still lets the game load images and scripts from other sites.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'credentialless',
};
