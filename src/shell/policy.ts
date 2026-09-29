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
