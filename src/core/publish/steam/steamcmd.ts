import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx } from '../../context.js';
import { GsFailure } from '../../result.js';
import { installArchive, isInstalled, type ToolArchive } from '../../tools/download.js';
import { toolCommand, withoutSecrets, type ToolCommand } from '../../tools/run.js';

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
  /** macOS: the folder first on SteamCMD's PATH, holding the stand-in `launchctl` (see steamCmdEnv). */
  shimDir: string;
  /** steamcmd.sh, or steamcmd.exe on Windows. */
  program: string;
  executable: string;
}

/** Absolute, even when the cache folder is given as a relative path: SteamCMD runs with its HOME from anywhere. */
export function steamCmdPaths(cacheDir: string, platform: NodeJS.Platform): SteamCmdPaths {
  const root = path.resolve(cacheDir, 'tools', 'steamcmd');
  const installDir = path.join(root, 'app');
  const program = platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh';
  return { installDir, homeDir: path.join(root, 'home'), shimDir: path.join(root, 'shim'), program, executable: path.join(installDir, program) };
}

/** What a shell searches when there's no PATH: an empty PATH would mean the current folder instead. */
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Where the stand-in launchctl notes each call, in SteamCMD's HOME. */
export const LAUNCHCTL_CALLS_LOG = 'launchctl-calls.log';

/**
 * SteamCMD keeps its login, logs and caches under $HOME: in ~/Library/Application Support/Steam on macOS and ~/Steam
 * on Linux, the Steam client's own folders. A HOME of its own keeps the player's Steam install untouched; on Linux the
 * XDG folders move into it too. On Windows it keeps everything beside steamcmd.exe, in the cache.
 *
 * On macOS SteamCMD also writes a com.valvesoftware.steamclean LaunchAgent into $HOME and runs `launchctl remove` and
 * `launchctl load` on it through the shell, which would replace the Steam client's loaded job with one pointing into
 * the cache. So a stand-in `launchctl` (writeLaunchctlShim) comes first on its PATH: SteamCMD never loads or removes
 * the client's background jobs. It never gets the GitHub token, butler's key or the Apple signing variables.
 */
export function steamCmdEnv(paths: SteamCmdPaths, platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = withoutSecrets(baseEnv);
  if (platform === 'win32') return env;
  // steamcmd.sh runs under bash, which would first run the file BASH_ENV (or ENV, for sh) names: it could set PATH back.
  delete env.BASH_ENV;
  delete env.ENV;
  const home = path.resolve(paths.homeDir);
  if (platform === 'darwin') return { ...env, HOME: home, PATH: `${path.resolve(paths.shimDir)}:${env.PATH || DEFAULT_PATH}` };
  const xdg =
    platform === 'linux'
      ? { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache') }
      : {};
  return { ...env, HOME: home, ...xdg };
}

/** `text` as one shell word, whatever it holds. */
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Writes the stand-in `launchctl` SteamCMD finds first on macOS (steamCmdEnv): a script that changes nothing, prints
 * nothing and succeeds, noting each call's arguments in LAUNCHCTL_CALLS_LOG in SteamCMD's HOME. It's written again
 * before every run, in case it was removed or changed, and moved into place whole, so a SteamCMD running meanwhile
 * never finds half a script. Throws if it can't be written: SteamCMD must not run without it.
 */
export function writeLaunchctlShim(paths: SteamCmdPaths): void {
  const script = [
    '#!/bin/sh',
    "# Gameshipper's stand-in for launchctl, first on SteamCMD's PATH: SteamCMD would load its own copy of the Steam",
    "# client's com.valvesoftware.steamclean job in place of the client's. This changes nothing; it notes the call.",
    `{ printf '%s\\n' "$*" >> ${shellQuote(path.join(path.resolve(paths.homeDir), LAUNCHCTL_CALLS_LOG))}; } 2>/dev/null`,
    'exit 0',
    '',
  ].join('\n');
  const dir = path.resolve(paths.shimDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  const file = path.join(dir, 'launchctl');
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, script, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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
  // PATH can't hold a folder with a colon: SteamCMD would find the real launchctl. (Only tests run the macOS setup
  // on Windows, where every path has a drive letter's colon.)
  if (platform === 'darwin' && process.platform !== 'win32' && paths.shimDir.includes(':')) {
    throw new GsFailure(
      'STEAM_PATH_UNSUPPORTED',
      `SteamCMD can't run from Gameshipper's cache folder ${ctx.cacheDir}: its path has a colon.`,
      'Set GAMESHIPPER_CACHE to a folder whose path has no colon, then publish again.',
    );
  }
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
  // Only you may read SteamCMD's saved login.
  fs.mkdirSync(path.dirname(paths.homeDir), { recursive: true });
  fs.mkdirSync(paths.homeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(paths.homeDir, 0o700);
  if (platform === 'darwin') writeLaunchctlShim(paths);
  return override ? toolCommand(override, env) : toolCommand(paths.executable, env);
}
