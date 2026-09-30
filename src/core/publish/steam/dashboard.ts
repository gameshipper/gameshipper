import * as path from 'node:path';
import type { Config, DesktopTarget } from '../../config/schema.js';
import { executableFor, macAppFor } from '../../desktop/package.js';
import { fileSafeName } from '../../names.js';

/** The OS names Steamworks shows in its launch option and Auto-Cloud menus. */
export type SteamOs = 'Windows' | 'macOS' | 'Linux + SteamOS';

const OS: Record<DesktopTarget, SteamOs> = { windows: 'Windows', mac: 'macOS', linux: 'Linux + SteamOS' };

export interface SteamDashboard {
  /** SteamPipe → Builds: where a build is set live on the default branch. */
  buildsUrl: string;
  /** Installation → General Installation: the launch options. */
  settingsUrl: string;
  /** Steam Cloud settings. */
  cloudUrl: string;
  launchOptions: Array<{ os: SteamOs; executable: string }>;
  autoCloud: {
    bytesPerUser: number;
    filesPerUser: number;
    paths: Array<{ os: SteamOs; root: string; subdirectory: string; pattern: string; recursive: boolean }>;
  };
}

/**
 * What the developer sets once by hand in Steamworks after the first upload (spec §10).
 * Launch options name the files players run, relative to the depot. For macOS Valve prefers the .app bundle to the
 * binary inside it (partner.steamgames.com/doc/sdk/uploading), so it's the bundle.
 * Auto-Cloud mirrors where the shell keeps saves: <appData>/<fileSafeName(name)>/saves (src/shell/main.ts pins
 * Electron's userData to the file-safe productName), where appData is %APPDATA% on Windows, ~/Library/Application
 * Support on macOS and ~/.config on Linux. Steam has no root for ~/.config, so Linux uses LinuxHome + .config.
 */
export function steamDashboard(config: Config, targets: DesktopTarget[]): SteamDashboard {
  const appId = config.steam.appId;
  const depot = path.resolve('depot');
  const launchOptions = targets.map((target) => {
    const file = target === 'mac' ? macAppFor(config, depot) : executableFor(config, target, depot);
    return { os: OS[target], executable: path.relative(depot, file).split(path.sep).join('/') };
  });
  const folder = fileSafeName(config.name);
  const roots: Record<DesktopTarget, { root: string; subdirectory: string }> = {
    windows: { root: 'WinAppDataRoaming', subdirectory: `${folder}/saves` },
    mac: { root: 'MacAppSupport', subdirectory: `${folder}/saves` },
    linux: { root: 'LinuxHome', subdirectory: `.config/${folder}/saves` },
  };
  return {
    buildsUrl: `https://partner.steamgames.com/apps/builds/${appId}`,
    settingsUrl: `https://partner.steamgames.com/apps/config/${appId}`,
    cloudUrl: `https://partner.steamgames.com/apps/cloud/${appId}`,
    launchOptions,
    autoCloud: {
      bytesPerUser: 10_000_000,
      filesPerUser: 100,
      paths: targets.map((target) => ({ os: OS[target], ...roots[target], pattern: '*.json', recursive: false })),
    },
  };
}
