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

/** The game window may only show game pages; web links open in the player's browser. */
export function navigationAction(url: string): NavigationAction {
  if (isGameUrl(url)) return 'allow';
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? 'open-external' : 'block';
  } catch {
    return 'block';
  }
}

/** Chromium's net::ERR_ABORTED: the load was stopped or cancelled, not broken. */
export const ERR_ABORTED = -3;

export type LoadFailure = 'fatal' | 'stopped' | 'ignore';

/**
 * What a did-fail-load means for the game. Only the main page failing to load is fatal.
 * ERR_ABORTED on the main page means its load was stopped (e.g. window.stop()): the page is
 * still running, but did-finish-load won't follow. Iframe failures don't affect the game.
 */
export function classifyLoadFailure(errorCode: number, isMainFrame: boolean): LoadFailure {
  if (!isMainFrame) return 'ignore';
  return errorCode === ERR_ABORTED ? 'stopped' : 'fatal';
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock']);

/** Games get fullscreen and pointer lock; everything else (camera, location, notifications...) is denied. */
export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}
