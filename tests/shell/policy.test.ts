import { describe, expect, it } from 'vitest';
import {
  classifyLoadFailure,
  CROSS_ORIGIN_ISOLATION_HEADERS,
  GAME_ORIGIN,
  isGameUrl,
  isPermissionAllowed,
  leaveAction,
  navigationAction,
  newWindowSource,
  RETURN_LOOP_MS,
  returnToGame,
} from '../../src/shell/policy.js';

describe('isGameUrl', () => {
  it('accepts only URLs on app://game/', () => {
    expect(isGameUrl('app://game/index.html')).toBe(true);
    expect(isGameUrl('app://game/')).toBe(true);
    expect(isGameUrl('app://game/levels/1.html?x=1#top')).toBe(true);
  });
  it('rejects other hosts, schemes and non-URLs', () => {
    for (const url of ['app://other/index.html', 'app://game.evil.com/', 'http://game/index.html', 'https://example.com/', 'file:///etc/passwd', 'about:blank', 'not a url', '', null, undefined]) {
      expect(isGameUrl(url)).toBe(false);
    }
  });
});

describe('navigationAction', () => {
  it('allows game pages', () => {
    expect(navigationAction('app://game/level2.html')).toBe('allow');
  });
  it('sends web, mail and Steam links to the system', () => {
    for (const url of ['https://example.com/wiki', 'HTTP://example.com/', 'mailto:help@example.com', 'steam://run/480', 'steam://store/480']) {
      expect(navigationAction(url)).toBe('open-external');
    }
  });
  it('blocks everything else, including about:blank', () => {
    for (const url of ['about:blank', 'about:blank#x', 'about:srcdoc', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'app://other/', 'chrome://gpu', 'garbage']) {
      expect(navigationAction(url)).toBe('block');
    }
  });
});

describe('leaveAction', () => {
  const external = ['https://example.com/wiki', 'http://example.com/', 'mailto:help@example.com', 'steam://run/480'];

  it("opens web, mail and Steam links in the system when the game's own frame asked", () => {
    expect(GAME_ORIGIN).toBe('app://game');
    for (const url of external) expect(leaveAction(url, 'app://game')).toBe('open-external');
  });

  it('blocks those links when another frame asked, or when nobody knows who did', () => {
    for (const from of ['https://ads.example.com', 'app://other', 'null', '', null, undefined]) {
      for (const url of external) expect(leaveAction(url, from)).toBe('block');
    }
  });

  it('blocks everything else, whoever asked', () => {
    for (const url of ['about:blank', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://gpu', 'garbage']) {
      expect(leaveAction(url, 'app://game')).toBe('block');
    }
  });
});

describe('newWindowSource', () => {
  it('is the game when every frame in the window is the game', () => {
    expect(newWindowSource(['app://game'])).toBe('app://game');
    // about:blank and srcdoc frames the game creates share its origin.
    expect(newWindowSource(['app://game', 'app://game', 'app://game'])).toBe('app://game');
  });

  it('is unknown when any frame belongs to someone else, is sandboxed or failed to load', () => {
    expect(newWindowSource(['app://game', 'https://www.youtube.com'])).toBeNull();
    expect(newWindowSource(['app://game', 'null'])).toBeNull();
    expect(newWindowSource([])).toBeNull();
  });
});

describe('classifyLoadFailure', () => {
  it('is fatal only when the main page fails for a reason other than being stopped', () => {
    expect(classifyLoadFailure(-105, true)).toBe('fatal');
    expect(classifyLoadFailure(-102, true)).toBe('fatal');
  });
  it('treats an aborted main page (window.stop()) as stopped: the page keeps running', () => {
    expect(classifyLoadFailure(-3, true)).toBe('stopped');
  });
  it('reports failed iframes separately and ignores aborted ones', () => {
    expect(classifyLoadFailure(-102, false)).toBe('frame-failed');
    expect(classifyLoadFailure(-27, false)).toBe('frame-failed');
    expect(classifyLoadFailure(-3, false)).toBe('ignore');
  });
});

describe('isPermissionAllowed', () => {
  it('allows what games need', () => {
    for (const p of ['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock', 'screen-wake-lock', 'persistent-storage', 'automatic-fullscreen']) {
      expect(isPermissionAllowed(p)).toBe(true);
    }
  });
  it('denies everything else', () => {
    for (const p of ['geolocation', 'media', 'notifications', 'clipboard-read', 'openExternal', 'midi', 'hid', 'unknown']) {
      expect(isPermissionAllowed(p)).toBe(false);
    }
  });
});

describe('CROSS_ORIGIN_ISOLATION_HEADERS', () => {
  it('isolates the game so SharedArrayBuffer works, without blocking credentialless loads', () => {
    expect(CROSS_ORIGIN_ISOLATION_HEADERS).toEqual({
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'credentialless',
    });
  });
});

describe('returnToGame', () => {
  it('returns the first time the game lands on a page that is not the game', () => {
    expect(returnToGame(null, 1_000)).toBe(true);
  });

  it('stops when it lands there again within 5 seconds of the last return', () => {
    expect(RETURN_LOOP_MS).toBe(5000);
    expect(returnToGame(1_000, 1_000)).toBe(false);
    expect(returnToGame(1_000, 5_999)).toBe(false);
  });

  it('returns again once 5 seconds have passed', () => {
    expect(returnToGame(1_000, 6_000)).toBe(true);
    expect(returnToGame(1_000, 60_000)).toBe(true);
  });
});
