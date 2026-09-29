import { describe, expect, it } from 'vitest';
import {
  classifyLoadFailure,
  CROSS_ORIGIN_ISOLATION_HEADERS,
  isGameUrl,
  isPermissionAllowed,
  navigationAction,
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
