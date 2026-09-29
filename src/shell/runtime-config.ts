import * as fs from 'node:fs';

/** Written by core/desktop/assemble.ts into <app>/shell/config.json. */
export interface RuntimeConfig {
  name: string;
  entry: string;
  window: { width: number; height: number; fullscreen: boolean; resizable: boolean };
  steamAppId: number;
}

export function readRuntimeConfig(file: string): RuntimeConfig {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeConfig;
}

export function entryUrl(entry: string): string {
  return `app://game/${entry.split('/').map(encodeURIComponent).join('/')}`;
}
