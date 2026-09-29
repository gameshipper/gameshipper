import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuntimeConfig } from '../../shell/runtime-config.js';
import type { Config } from '../config/schema.js';
import { fileSafeName, slugify } from '../names.js';
import { copyPlugins, type LoadedPlugin } from '../plugins.js';

export interface AssembleInput {
  stageDir: string;
  /** Compiled shell (dist/shell in the published package). */
  shellDir: string;
  iconPng: string | null;
  /** Plugins to copy into <app>/plugins/ (default none). */
  plugins?: LoadedPlugin[];
}

export function appDirFor(projectDir: string): string {
  return path.join(projectDir, '.gameshipper', 'app');
}

/** Builds <project>/.gameshipper/app: package.json, shell/, game/, plugins/. This folder is what Electron runs. */
export function assembleApp(projectDir: string, config: Config, input: AssembleInput): string {
  const appDir = appDirFor(projectDir);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });

  // Electron names the save folder (userData) after productName before the shell runs, so it must be a
  // valid folder name on every OS ("Moon: Rising" isn't on Windows). The shell still shows config.name.
  const pkg = { name: slugify(config.name), productName: fileSafeName(config.name), version: config.version, main: 'shell/main.js', private: true };
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const shellOut = path.join(appDir, 'shell');
  fs.cpSync(input.shellDir, shellOut, { recursive: true, filter: (src) => !src.endsWith('.map') });
  const runtime: RuntimeConfig = {
    name: config.name,
    entry: config.game.entry,
    window: config.window,
    steamAppId: config.steam.appId,
    steamOverlay: config.steam.overlay,
    plugins: copyPlugins(appDir, input.plugins ?? []),
  };
  fs.writeFileSync(path.join(shellOut, 'config.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  if (input.iconPng) fs.copyFileSync(input.iconPng, path.join(shellOut, 'icon.png'));

  fs.cpSync(input.stageDir, path.join(appDir, 'game'), { recursive: true });
  return appDir;
}
