import type { OverlayMode } from './diagnostics.js';

export type OverlaySetting = 'auto' | 'native' | 'repaint' | 'off';

/** Whether Steam loaded its overlay renderer into this process (it does when Steam launches the game). */
export function overlayInjected(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'darwin') return (env.DYLD_INSERT_LIBRARIES ?? '').includes('gameoverlayrenderer');
  if (platform === 'linux') return (env.LD_PRELOAD ?? '').includes('gameoverlayrenderer');
  return true; // On Windows Steam injects the overlay without an environment variable.
}

/**
 * How the Steam overlay (Shift+Tab) gets frames to draw over, for steam.overlay = "auto":
 * - macOS: steamworks-ffi-node's native Metal window mirroring the game, and only when Steam
 *   injected its overlay. Measured on macOS with Electron 44: with Chromium's own frames
 *   isOverlayEnabled() stays false even with a canvas repainting every frame; with the native
 *   window it turns true within about 2 seconds.
 * - Windows and Linux: the repaint loop steamworks.js uses. With in-process-gpu (and
 *   disable-direct-composition on Windows), Steam hooks Chromium's GPU output directly and only
 *   needs a new frame every tick.
 */
export function chooseOverlay(setting: OverlaySetting, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): OverlayMode {
  if (setting === 'off') return 'none';
  if (setting === 'native' || setting === 'repaint') return setting;
  if (platform === 'darwin') return overlayInjected(platform, env) ? 'native' : 'none';
  return 'repaint';
}

/** The BrowserWindow parts the repaint loop uses. */
export interface RepaintWindow {
  isDestroyed(): boolean;
  webContents: { isPainting(): boolean; invalidate(): void };
}

/** Forces a new frame 60 times a second so the overlay always has something to draw over. Returns stop(). */
export function startRepaint(win: RepaintWindow, fps = 60): () => void {
  const timer = setInterval(() => {
    if (win.isDestroyed()) clearInterval(timer);
    else if (!win.webContents.isPainting()) win.webContents.invalidate();
  }, 1000 / fps);
  return () => clearInterval(timer);
}
