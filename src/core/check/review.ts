import * as fs from 'node:fs';
import * as path from 'node:path';
import { DESKTOP_TARGETS, type Config, type DesktopTarget } from '../config/schema.js';
import { executableFor } from '../desktop/package.js';
import { listFiles } from '../fsutil.js';
import type { MacSigning } from './mac-signing.js';
import { capDetails, type CheckResult } from './types.js';

export interface BuildInfo {
  target: DesktopTarget;
  /** out/<target> */
  dir: string;
  executable: string;
  built: boolean;
}

/** The desktop targets in gameshipper.json, and whether out/<target> has a launchable build. */
export function findBuilds(projectDir: string, config: Config): BuildInfo[] {
  return DESKTOP_TARGETS.filter((t) => config.targets.includes(t)).map((target) => {
    const dir = path.join(projectDir, 'out', target);
    const executable = executableFor(config, target, dir);
    return { target, dir, executable, built: fs.existsSync(executable) };
  });
}

/** out/mac/<Name>.app, from the executable inside it. */
export function macAppPath(executable: string): string {
  return path.dirname(path.dirname(path.dirname(executable)));
}

export function buildsCheck(builds: BuildInfo[]): CheckResult {
  const base = { id: 'review.builds', group: 'review', title: 'A build for every desktop target' } as const;
  if (!builds.length) return { ...base, status: 'info', message: 'No desktop targets in gameshipper.json.' };
  const missing = builds.filter((b) => !b.built).map((b) => b.target);
  if (!missing.length) return { ...base, status: 'pass', message: `Built: ${builds.map((b) => b.target).join(', ')}.` };
  return {
    ...base,
    status: 'fail',
    code: 'CHECK_BUILD_MISSING',
    message: `No build for ${missing.join(', ')}. Steam's review launches every OS the store page lists.`,
    fix: 'Run `npx gameshipper build`, or remove the targets you don\'t ship from "targets" in gameshipper.json.',
    details: missing.map((t) => `out/${t}`),
  };
}

/** Looks everywhere under out/, not only in the targets' folders: anything there may be uploaded. */
export function steamAppIdCheck(projectDir: string): CheckResult {
  const base = { id: 'review.steam-appid', group: 'review', title: 'No steam_appid.txt in the builds' } as const;
  const outDir = path.join(projectDir, 'out');
  const found = fs.existsSync(outDir)
    ? listFiles(outDir)
        .filter((f) => path.posix.basename(f).toLowerCase() === 'steam_appid.txt')
        .map((f) => `out/${f}`)
    : [];
  if (!found.length) return { ...base, status: 'pass', message: 'No build contains steam_appid.txt.' };
  return {
    ...base,
    status: 'fail',
    code: 'CHECK_STEAM_APPID_FILE',
    message: `Found steam_appid.txt in ${found.length} place${found.length === 1 ? '' : 's'}.`,
    fix: 'Delete it from the builds (and from your game folder). steam_appid.txt is for development only and must not ship.',
    details: capDetails(found),
  };
}

export function macSigningCheck(config: Config, builds: BuildInfo[], host: NodeJS.Platform, signing: MacSigning | null): CheckResult {
  const base = { id: 'review.mac-signing', group: 'review', title: 'Mac build signed and notarized' } as const;
  if (!config.targets.includes('mac')) return { ...base, status: 'skip', message: 'mac is not in targets.' };
  if (!builds.some((b) => b.target === 'mac' && b.built)) return { ...base, status: 'skip', message: 'There is no Mac build to check (see review.builds).' };
  if (host !== 'darwin' || !signing) {
    return {
      ...base,
      status: 'warn',
      code: 'CHECK_MAC_SIGNING_UNKNOWN',
      message: 'Mac signing and notarization can only be checked on a Mac.',
      fix: 'Run `npx gameshipper check` on a Mac before you release the Mac version.',
    };
  }
  if (signing.kind === 'developer-id' && signing.valid && signing.stapled === null) {
    return {
      ...base,
      status: 'warn',
      code: 'CHECK_MAC_SIGNING_UNKNOWN',
      message: `Signed by ${signing.authority}, but whether it is notarized can't be checked: Apple's command-line tools aren't installed.`,
      fix: 'Run `xcode-select --install`, then check again.',
    };
  }
  if (signing.kind === 'developer-id' && signing.valid && signing.stapled) {
    return { ...base, status: 'pass', message: `Signed by ${signing.authority} and notarized.` };
  }
  const state =
    signing.kind === 'adhoc'
      ? 'is only ad-hoc signed (no Apple Developer ID) and not notarized'
      : signing.kind === 'unsigned'
        ? "isn't signed"
        : !signing.valid
          ? `has a broken signature (${signing.detail.split('\n')[0]})`
          : signing.kind === 'developer-id'
            ? `is signed by ${signing.authority} but not notarized (no ticket stapled)`
            : `is signed by ${signing.authority}, which isn't a Developer ID certificate`;
  return {
    ...base,
    status: 'fail',
    code: 'CHECK_MAC_NOT_NOTARIZED',
    message: `The Mac app ${state}, so macOS blocks it for players.`,
    fix: 'On a Mac with a paid Apple Developer account, set GAMESHIPPER_MAC_IDENTITY and GAMESHIPPER_NOTARY_PROFILE (`npx gameshipper help --json` lists them under "environment"), then run `npx gameshipper build --target mac`. Or remove "mac" from targets in gameshipper.json.',
    details: signing.detail ? capDetails(signing.detail.split('\n')) : undefined,
  };
}

export function iconCheck(config: Config): CheckResult {
  const base = { id: 'review.icon', group: 'review', title: 'Custom icon' } as const;
  if (config.icon) return { ...base, status: 'pass', message: `Uses ${config.icon}.` };
  return {
    ...base,
    status: 'warn',
    code: 'CHECK_DEFAULT_ICON',
    message: 'The builds use the default Electron icon.',
    fix: 'Add a square PNG icon (1024x1024 or larger), set "icon" in gameshipper.json and rebuild.',
  };
}

export function appIdCheck(config: Config): CheckResult {
  const base = { id: 'review.app-id', group: 'review', title: 'Your own Steam App ID' } as const;
  if (config.steam.appId !== 480) return { ...base, status: 'pass', message: `Steam App ID ${config.steam.appId}.` };
  return {
    ...base,
    status: 'warn',
    code: 'CHECK_TEST_APP_ID',
    message: "The builds use Valve's test app (480), so achievements and saves go to Spacewar.",
    fix: 'Set steam.appId in gameshipper.json to your App ID from the Steamworks dashboard, then rebuild.',
  };
}
