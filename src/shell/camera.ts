import type { WebContents } from 'electron';
import type { Size } from './capture.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lays the page out at an exact CSS size with devicePixelRatio 1 and takes pixel-exact PNGs, through Chromium's
 * DevTools protocol. webContents.capturePage() can't: its image size follows the window and the display's scaling
 * (3840x2160 for a 1920x1080 page on a Retina Mac). Page.captureScreenshot returns exactly the emulated size,
 * even when the window is smaller than it.
 */
export class PageCamera {
  private readonly wc: WebContents;
  private fixed: Size | null = null;

  constructor(wc: WebContents) {
    this.wc = wc;
  }

  /** The size the page is kept at, or null when it follows the window. */
  get viewport(): Size | null {
    return this.fixed;
  }

  /**
   * Keeps the page at `size` for the rest of the run. Call it once the window has loaded a page (about:blank will
   * do): DevTools commands sent to a webContents that has never loaded anything never answer.
   */
  async fixViewport(size: Size): Promise<void> {
    await this.emulate(size);
    this.fixed = size;
  }

  /**
   * PNG of the page at exactly `size`, briefly laying the page out at that size if it isn't already. Whatever
   * fails, the page goes back to its own size afterwards.
   */
  async capture(size: Size): Promise<Buffer> {
    const temporary = this.fixed?.width !== size.width || this.fixed?.height !== size.height;
    try {
      if (temporary) {
        await this.emulate(size);
        await this.settle();
      }
      const shot = (await this.wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })) as { data: string };
      return Buffer.from(shot.data, 'base64');
    } finally {
      if (temporary) {
        if (this.fixed) await this.emulate(this.fixed);
        else await this.wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
      }
    }
  }

  private async emulate(size: Size): Promise<void> {
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    await this.wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  }

  /**
   * Lets the game handle the resize and draw a frame at the new size (at most about a second). Never fails: a game
   * that replaced or broke requestAnimationFrame is captured as it is.
   */
  private async settle(): Promise<void> {
    await sleep(150);
    let frame: Promise<unknown>;
    try {
      frame = this.wc
        .executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
        // Caught here, so an answer that fails after the wait below is over is never an unhandled rejection.
        .catch(() => undefined);
    } catch {
      return;
    }
    await Promise.race([frame, sleep(1000)]);
  }
}
