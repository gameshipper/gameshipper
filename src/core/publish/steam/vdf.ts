import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDepots, type Config, type DesktopTarget } from '../../config/schema.js';
import type { DesktopBuild } from '../builds.js';

/**
 * A quoted VDF string. SteamCMD's VDF parser has no escapes: a " in a value fails the build with "App build file has
 * invalid format", and on macOS and Linux a \ breaks it even earlier. So a value never has either: numbers, names
 * checked against patterns, and paths that steamUnreadablePath found none in. Throws if one does anyway.
 */
export function vdfString(value: string): string {
  if (/["\\]/.test(value)) throw new Error(`SteamCMD's build scripts can't hold ${JSON.stringify(value)}: it has a quote or a backslash.`);
  return `"${value}"`;
}

/** SteamCMD takes forward slashes on every OS. */
const slashes = (p: string) => p.split(path.sep).join('/');

/** The first path SteamCMD couldn't read from its scripts: one with a ", or a \ on macOS and Linux. */
export function steamUnreadablePath(paths: string[], platform: NodeJS.Platform): string | null {
  return paths.find((p) => p.includes('"') || (platform !== 'win32' && p.includes('\\'))) ?? null;
}

const scriptsDir = (projectDir: string) => path.join(projectDir, '.gameshipper', 'steam');
const appBuildScript = (dir: string, appId: number) => path.join(dir, `app_build_${appId}.vdf`);
const depotBuildScript = (dir: string, depotId: number) => path.join(dir, `depot_build_${depotId}.vdf`);

export interface AppBuildInput {
  appId: number;
  description: string;
  /** --dry-run: Steam checks the build and uploads nothing. */
  preview: boolean;
  /** A beta branch to set the build live on, or null to only upload it. */
  setLive: string | null;
  contentRoot: string;
  buildOutput: string;
  depots: Array<{ depotId: number; script: string }>;
}

/** The app build script (partner.steamgames.com/doc/sdk/uploading). */
export function appBuildVdf(input: AppBuildInput): string {
  const lines = [
    '"AppBuild"',
    '{',
    `\t"AppID" ${vdfString(String(input.appId))}`,
    `\t"Desc" ${vdfString(input.description)}`,
    `\t"Preview" ${vdfString(input.preview ? '1' : '0')}`,
    ...(input.setLive ? [`\t"SetLive" ${vdfString(input.setLive)}`] : []),
    `\t"ContentRoot" ${vdfString(slashes(input.contentRoot))}`,
    `\t"BuildOutput" ${vdfString(slashes(input.buildOutput))}`,
    '\t"Depots"',
    '\t{',
    ...input.depots.map((d) => `\t\t${vdfString(String(d.depotId))} ${vdfString(slashes(d.script))}`),
    '\t}',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * One depot: everything in contentRoot except steam_appid.txt, which must never ship. SteamCMD matches an exclusion
 * against the path relative to the content root, with * matching / too: the first line is the file at the top, the
 * second one in any folder.
 */
export function depotBuildVdf(depotId: number, contentRoot: string): string {
  const lines = [
    '"DepotBuild"',
    '{',
    `\t"DepotID" ${vdfString(String(depotId))}`,
    `\t"ContentRoot" ${vdfString(slashes(contentRoot))}`,
    '\t"FileMapping"',
    '\t{',
    '\t\t"LocalPath" "*"',
    '\t\t"DepotPath" "."',
    '\t\t"Recursive" "1"',
    '\t}',
    '\t"FileExclusion" "steam_appid.txt"',
    '\t"FileExclusion" "*/steam_appid.txt"',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

export interface SteamScripts {
  appBuild: string;
  /** SteamCMD's BuildOutput: its app_build_<appid>.log and depot logs land here. */
  outputDir: string;
  depots: Array<{ target: DesktopTarget; depotId: number; script: string }>;
}

/** Every path writeSteamScripts writes into the scripts or passes to SteamCMD: SteamCMD must be able to read each. */
export function steamScriptPaths(projectDir: string, config: Config, builds: DesktopBuild[]): string[] {
  const dir = scriptsDir(projectDir);
  const ids = resolveDepots(config);
  return [
    path.join(projectDir, 'out'),
    path.join(dir, 'output'),
    appBuildScript(dir, config.steam.appId),
    ...builds.flatMap((b) => [b.dir, depotBuildScript(dir, ids[b.target])]),
  ];
}

/**
 * Writes the app and depot scripts to .gameshipper/steam/ (written again on every publish). Check steamScriptPaths
 * with steamUnreadablePath first: this throws on a path SteamCMD can't read.
 */
export function writeSteamScripts(projectDir: string, config: Config, builds: DesktopBuild[], opts: { preview: boolean; setLive: string | null }): SteamScripts {
  const dir = scriptsDir(projectDir);
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const ids = resolveDepots(config);
  const depots = builds.map((b) => {
    const depotId = ids[b.target];
    const script = depotBuildScript(dir, depotId);
    fs.writeFileSync(script, depotBuildVdf(depotId, b.dir));
    return { target: b.target, depotId, script };
  });
  const appBuild = appBuildScript(dir, config.steam.appId);
  fs.writeFileSync(
    appBuild,
    appBuildVdf({
      appId: config.steam.appId,
      description: config.version,
      preview: opts.preview,
      setLive: opts.setLive,
      contentRoot: path.join(projectDir, 'out'),
      buildOutput: outputDir,
      depots: depots.map(({ depotId, script }) => ({ depotId, script })),
    }),
  );
  return { appBuild, outputDir, depots };
}
