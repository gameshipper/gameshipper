import { describe, expect, it } from 'vitest';
import { floatingKeyboardArgs } from '../../src/shell/deck-keyboard.js';
import { chooseOverlay, overlayInjected, startRepaint } from '../../src/shell/overlay.js';

const MAC_STEAM = { DYLD_INSERT_LIBRARIES: '/Users/u/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/gameoverlayrenderer.dylib' };

describe('chooseOverlay', () => {
  it('auto: native window on macOS only when Steam injected its overlay; repaint elsewhere', () => {
    expect(chooseOverlay('auto', 'darwin', MAC_STEAM)).toBe('native');
    expect(chooseOverlay('auto', 'darwin', {})).toBe('none');
    expect(chooseOverlay('auto', 'win32', {})).toBe('repaint');
    expect(chooseOverlay('auto', 'linux', {})).toBe('repaint');
  });

  it('explicit settings win', () => {
    expect(chooseOverlay('native', 'win32', {})).toBe('native');
    expect(chooseOverlay('repaint', 'darwin', MAC_STEAM)).toBe('repaint');
    expect(chooseOverlay('off', 'win32', {})).toBe('none');
  });

  it('detects the injected renderer', () => {
    expect(overlayInjected('linux', { LD_PRELOAD: '/home/u/.steam/ubuntu12_64/gameoverlayrenderer.so' })).toBe(true);
    expect(overlayInjected('linux', {})).toBe(false);
    expect(overlayInjected('win32', {})).toBe(true);
  });
});

describe('startRepaint', () => {
  it('invalidates the window every frame until stopped or destroyed', async () => {
    let invalidated = 0;
    let destroyed = false;
    const win = { isDestroyed: () => destroyed, webContents: { isPainting: () => false, invalidate: () => void invalidated++ } };
    const stop = startRepaint(win, 200);
    await new Promise((r) => setTimeout(r, 60));
    expect(invalidated).toBeGreaterThan(2);
    stop();
    const count = invalidated;
    await new Promise((r) => setTimeout(r, 30));
    expect(invalidated).toBe(count);
    startRepaint(win, 200);
    destroyed = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(invalidated).toBe(count);
  });
});

describe('floatingKeyboardArgs', () => {
  const rect = { x: 10.2, y: 20, width: 300, height: 40 };
  it('picks the keyboard type and scales the field to window pixels', () => {
    expect(floatingKeyboardArgs({ tag: 'input', type: '', editable: false, rect, scale: 1 })).toEqual([0, 10, 20, 300, 40]);
    expect(floatingKeyboardArgs({ tag: 'input', type: 'EMAIL', editable: false, rect, scale: 2 })).toEqual([2, 20, 40, 600, 80]);
    expect(floatingKeyboardArgs({ tag: 'input', type: 'number', editable: false, rect, scale: 1 })?.[0]).toBe(3);
    expect(floatingKeyboardArgs({ tag: 'textarea', type: '', editable: false, rect, scale: 1 })?.[0]).toBe(1);
    expect(floatingKeyboardArgs({ tag: 'div', type: '', editable: true, rect, scale: 1 })?.[0]).toBe(1);
  });

  it('ignores elements that do not take text, and junk', () => {
    expect(floatingKeyboardArgs({ tag: 'input', type: 'checkbox', editable: false, rect, scale: 1 })).toBeNull();
    expect(floatingKeyboardArgs({ tag: 'button', type: '', editable: false, rect, scale: 1 })).toBeNull();
    expect(floatingKeyboardArgs('input')).toBeNull();
    expect(floatingKeyboardArgs({ tag: 'input', type: 'text' })).toEqual([0, 0, 0, 0, 0]);
  });
});
