import * as fs from 'node:fs';

/** A plugin copied into the app (see core/plugins.ts). */
export interface RuntimePlugin {
  name: string;
  /** Module path relative to the app folder, with forward slashes, e.g. "plugins/echo/echo.mjs". */
  entry: string;
  /** The plugin's `main` functions the game may call. */
  functions: string[];
}

/** Written by core/desktop/assemble.ts into <app>/shell/config.json. */
export interface RuntimeConfig {
  name: string;
  entry: string;
  window: { width: number; height: number; fullscreen: boolean; resizable: boolean };
  steamAppId: number;
  /** steam.overlay from gameshipper.json; see shell/overlay.ts. */
  steamOverlay: 'auto' | 'native' | 'repaint' | 'off';
  plugins: RuntimePlugin[];
}

export function readRuntimeConfig(file: string): RuntimeConfig {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeConfig;
}

export function entryUrl(entry: string): string {
  return `app://game/${entry.split('/').map(encodeURIComponent).join('/')}`;
}
