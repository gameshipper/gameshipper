import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDepots, type Config, type DesktopTarget } from '../../config/schema.js';
import type { DesktopBuild } from '../builds.js';

/** A quoted VDF string. Paths use forward slashes, so a backslash only appears if a name has one. */
export function vdfString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** SteamCMD takes forward slashes on every OS. */
const slashes = (p: string) => p.split(path.sep).join('/');

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

/** One depot: everything in contentRoot except steam_appid.txt, which must never ship. */
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

/** Writes the app and depot scripts to .gameshipper/steam/ (written again on every publish). */
export function writeSteamScripts(projectDir: string, config: Config, builds: DesktopBuild[], opts: { preview: boolean; setLive: string | null }): SteamScripts {
  const dir = path.join(projectDir, '.gameshipper', 'steam');
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const ids = resolveDepots(config);
  const depots = builds.map((b) => {
    const depotId = ids[b.target];
    const script = path.join(dir, `depot_build_${depotId}.vdf`);
    fs.writeFileSync(script, depotBuildVdf(depotId, b.dir));
    return { target: b.target, depotId, script };
  });
  const appBuild = path.join(dir, `app_build_${config.steam.appId}.vdf`);
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
