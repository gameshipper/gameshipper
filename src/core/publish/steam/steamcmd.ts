import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx } from '../../context.js';
import { GsFailure } from '../../result.js';
import { installArchive, isInstalled, type ToolArchive } from '../../tools/download.js';
import { toolCommand, type ToolCommand } from '../../tools/run.js';

/**
 * Valve's official SteamCMD bootstrap archives, re-checked 2026-09-29 (unchanged since 2020, 2018 and 2013). SteamCMD
 * updates itself from Valve on its first run (to about 80 MB); that update is Valve-signed and not pinned here.
 * Don't change a hash without downloading the file again and hashing it.
 */
export const STEAMCMD_ARCHIVES: Partial<Record<NodeJS.Platform, ToolArchive>> = {
  darwin: {
    url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz',
    sha256: '8ecc17c8988e5acadcc78e631c48490f76150f2dfaa6cf8d7b4b67b097bd753b',
    format: 'tar.gz',
  },
  linux: {
    url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
    sha256: 'cebf0046bfd08cf45da6bc094ae47aa39ebf4155e5ede41373b579b8f1071e7c',
    format: 'tar.gz',
  },
  win32: {
    url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
    sha256: '7669b170dee42db8ee2273775ed7dfb2d173bdba1b849f70d2c7b379290bce13',
    format: 'zip',
  },
};

export interface SteamCmdPaths {
  /** Where SteamCMD is unpacked and updates itself. On macOS it also puts a Frameworks link beside this folder. */
  installDir: string;
  /** The HOME SteamCMD runs with on macOS and Linux; its saved login lives under it. */
  homeDir: string;
  /** steamcmd.sh, or steamcmd.exe on Windows. */
  program: string;
  executable: string;
}

export function steamCmdPaths(cacheDir: string, platform: NodeJS.Platform): SteamCmdPaths {
  const root = path.join(cacheDir, 'tools', 'steamcmd');
  const installDir = path.join(root, 'app');
  const program = platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh';
  return { installDir, homeDir: path.join(root, 'home'), program, executable: path.join(installDir, program) };
}

/**
 * SteamCMD keeps its login, logs and caches under $HOME: in ~/Library/Application Support/Steam on macOS and ~/Steam
 * on Linux, the Steam client's own folders. On macOS it also rewrites the client's LaunchAgent,
 * ~/Library/LaunchAgents/com.valvesoftware.steamclean.plist. A HOME of its own keeps the player's Steam install
 * untouched. On Windows it keeps everything beside steamcmd.exe, in the cache.
 */
export function steamCmdEnv(paths: SteamCmdPaths, platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return platform === 'win32' ? { ...baseEnv } : { ...baseEnv, HOME: paths.homeDir };
}

export interface EnsureSteamCmdOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replaces the pinned archive (tests). */
  archive?: ToolArchive;
}

/**
 * How to run SteamCMD, downloading it into the cache on first use. GAMESHIPPER_STEAMCMD=<path> runs that program
 * instead (tests use a fake), with the same HOME. Throws GsFailure: TOOL_UNSUPPORTED_HOST, or a download error.
 */
export async function ensureSteamCmd(ctx: Ctx, opts: EnsureSteamCmdOptions): Promise<ToolCommand> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const paths = steamCmdPaths(ctx.cacheDir, platform);
  const env = steamCmdEnv(paths, platform, opts.env);
  const override = opts.env.GAMESHIPPER_STEAMCMD;
  if (!override) {
    const archive = opts.archive ?? STEAMCMD_ARCHIVES[platform];
    if (!archive || (platform === 'linux' && arch !== 'x64')) {
      throw new GsFailure(
        'TOOL_UNSUPPORTED_HOST',
        `Valve doesn't make SteamCMD for ${platform}/${arch}.`,
        'Upload to Steam from a Windows PC, a Mac, or an x64 Linux computer.',
      );
    }
    if (!isInstalled(paths.installDir, archive, paths.program)) await installArchive(ctx, 'SteamCMD', archive, paths.installDir, paths.program);
  }
  fs.mkdirSync(paths.homeDir, { recursive: true });
  return override ? toolCommand(override, env) : toolCommand(paths.executable, env);
}
