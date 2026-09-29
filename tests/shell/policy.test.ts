import { describe, expect, it } from 'vitest';
import { classifyLoadFailure, isGameUrl, isPermissionAllowed, navigationAction } from '../../src/shell/policy.js';

describe('isGameUrl', () => {
  it('accepts only URLs on app://game/', () => {
    expect(isGameUrl('app://game/index.html')).toBe(true);
    expect(isGameUrl('app://game/')).toBe(true);
    expect(isGameUrl('app://game/levels/1.html?x=1#top')).toBe(true);
  });
  it('rejects other hosts, schemes and non-URLs', () => {
    for (const url of ['app://other/index.html', 'app://game.evil.com/', 'http://game/index.html', 'https://example.com/', 'file:///etc/passwd', 'not a url', '', null, undefined]) {
      expect(isGameUrl(url)).toBe(false);
    }
  });
});

describe('navigationAction', () => {
  it('allows game pages, sends web links to the browser and blocks everything else', () => {
    expect(navigationAction('app://game/level2.html')).toBe('allow');
    expect(navigationAction('https://example.com/wiki')).toBe('open-external');
    expect(navigationAction('HTTP://example.com/')).toBe('open-external');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'app://other/', 'mailto:a@b.c', 'garbage']) {
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
  it('ignores iframe failures, aborted or not', () => {
    expect(classifyLoadFailure(-102, false)).toBe('ignore');
    expect(classifyLoadFailure(-3, false)).toBe('ignore');
  });
});

describe('isPermissionAllowed', () => {
  it('allows fullscreen and pointer lock only', () => {
    expect(isPermissionAllowed('fullscreen')).toBe(true);
    expect(isPermissionAllowed('pointerLock')).toBe(true);
    for (const p of ['geolocation', 'media', 'notifications', 'clipboard-read', 'openExternal', 'unknown']) {
      expect(isPermissionAllowed(p)).toBe(false);
    }
  });
});
