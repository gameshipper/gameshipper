import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { PageCamera } from '../../src/shell/camera.js';

const PNG = Buffer.from('png');

/**
 * A stand-in for the game window's webContents: records every DevTools command (with the size for the resize
 * command), and runs the page's JavaScript with `run`.
 */
function fakeWebContents(opts: { run?: () => Promise<unknown>; screenshot?: () => Promise<unknown>; resize?: (width: number) => Promise<void> } = {}) {
  const commands: string[] = [];
  let attached = false;
  const wc = {
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      async sendCommand(method: string, params?: { width?: number; height?: number }) {
        commands.push(params?.width ? `${method} ${params.width}x${params.height}` : method);
        if (method === 'Emulation.setDeviceMetricsOverride') await opts.resize?.(params!.width!);
        if (method === 'Page.captureScreenshot') return opts.screenshot ? opts.screenshot() : { data: PNG.toString('base64') };
        return {};
      },
    },
    executeJavaScript: opts.run ?? (async () => true),
  };
  return { wc: wc as unknown as WebContents, commands };
}

const DECK = { width: 1280, height: 800 };
const FULL_HD = { width: 1920, height: 1080 };

describe('PageCamera.capture', () => {
  it('captures at the asked size and puts the page back at its fixed size', async () => {
    const { wc, commands } = fakeWebContents();
    const camera = new PageCamera(wc);
    await camera.fixViewport(DECK);
    expect(await camera.capture(FULL_HD)).toEqual(PNG);
    expect(commands).toEqual([
      'Emulation.setDeviceMetricsOverride 1280x800',
      'Emulation.setDeviceMetricsOverride 1920x1080',
      'Page.captureScreenshot',
      'Emulation.setDeviceMetricsOverride 1280x800',
    ]);
  });

  it('still captures, and restores the size, in a game that broke requestAnimationFrame', async () => {
    const { wc, commands } = fakeWebContents({ run: async () => Promise.reject(new TypeError('requestAnimationFrame is not a function')) });
    const camera = new PageCamera(wc);
    await camera.fixViewport(DECK);
    expect(await camera.capture(FULL_HD)).toEqual(PNG);
    expect(commands.at(-1)).toBe('Emulation.setDeviceMetricsOverride 1280x800');
  });

  it('ignores a frame the page answers too late, even when it fails then', async () => {
    const late = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the page went away')), 1200));
    const { wc } = fakeWebContents({ run: late });
    expect(await new PageCamera(wc).capture(FULL_HD)).toEqual(PNG);
    // An unhandled rejection from the late answer would fail this test file.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it('restores the size when the screenshot or the resize fails', async () => {
    const failing = fakeWebContents({ screenshot: async () => Promise.reject(new Error('no frame')) });
    const camera = new PageCamera(failing.wc);
    await camera.fixViewport(DECK);
    await expect(camera.capture(FULL_HD)).rejects.toThrow('no frame');
    expect(failing.commands.at(-1)).toBe('Emulation.setDeviceMetricsOverride 1280x800');

    const resize = fakeWebContents({ resize: async (width) => (width === 1920 ? Promise.reject(new Error('resize failed')) : undefined) });
    await expect(new PageCamera(resize.wc).capture(FULL_HD)).rejects.toThrow('resize failed');
    // With no fixed size, the page goes back to following the window.
    expect(resize.commands).toEqual(['Emulation.setDeviceMetricsOverride 1920x1080', 'Emulation.clearDeviceMetricsOverride']);
  });
});
