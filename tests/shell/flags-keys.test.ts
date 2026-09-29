import { describe, expect, it } from 'vitest';
import { chromiumSwitches } from '../../src/shell/flags.js';
import { isFullscreenToggle } from '../../src/shell/keys.js';

describe('chromiumSwitches', () => {
  it('always allows autoplay and keeps the GPU in-process for the Steam overlay', () => {
    const mac = chromiumSwitches('darwin');
    expect(mac).toContainEqual(['autoplay-policy', 'no-user-gesture-required']);
    expect(mac).toContainEqual(['in-process-gpu']);
    expect(mac).not.toContainEqual(['no-sandbox']);
  });
  it('adds disable-direct-composition on Windows', () => {
    expect(chromiumSwitches('win32')).toContainEqual(['disable-direct-composition']);
  });
  it('adds the Steam Linux Runtime switches on Linux', () => {
    const linux = chromiumSwitches('linux');
    for (const s of ['no-sandbox', 'no-zygote', 'disable-dev-shm-usage']) expect(linux).toContainEqual([s]);
  });
});

describe('isFullscreenToggle', () => {
  const key = (k: Partial<{ type: string; key: string; alt: boolean; isAutoRepeat: boolean }>) => ({
    type: 'keyDown',
    key: '',
    alt: false,
    ...k,
  });
  it('F11 and Alt+Enter toggle fullscreen on key down', () => {
    expect(isFullscreenToggle(key({ key: 'F11' }))).toBe(true);
    expect(isFullscreenToggle(key({ key: 'Enter', alt: true }))).toBe(true);
  });
  it('ignores key up and plain Enter', () => {
    expect(isFullscreenToggle(key({ key: 'F11', type: 'keyUp' }))).toBe(false);
    expect(isFullscreenToggle(key({ key: 'Enter' }))).toBe(false);
  });
  it('ignores auto-repeat key downs so holding F11 does not flicker', () => {
    expect(isFullscreenToggle(key({ key: 'F11', isAutoRepeat: true }))).toBe(false);
    expect(isFullscreenToggle(key({ key: 'Enter', alt: true, isAutoRepeat: true }))).toBe(false);
    expect(isFullscreenToggle(key({ key: 'F11', isAutoRepeat: false }))).toBe(true);
  });
});
