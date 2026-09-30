import { z } from 'zod';

export const TARGETS = ['windows', 'mac', 'linux', 'ios', 'android'] as const;
export type Target = (typeof TARGETS)[number];
export const DESKTOP_TARGETS = ['windows', 'mac', 'linux'] as const;
export type DesktopTarget = (typeof DESKTOP_TARGETS)[number];
/** How the Steam overlay (Shift+Tab) gets frames to draw on; see src/shell/overlay.ts. */
export const STEAM_OVERLAY_SETTINGS = ['auto', 'native', 'repaint', 'off'] as const;
export type SteamOverlaySetting = (typeof STEAM_OVERLAY_SETTINGS)[number];
/** mobile.bundleId: dot-separated parts of letters and digits, each starting with a letter (iOS and Android both accept it). */
export const BUNDLE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

const relPath = z.string().min(1);

/** steam.user: a Steam account name, the one you sign in with (3-64 letters, digits or underscores). */
export const STEAM_USER_PATTERN = /^[A-Za-z0-9_]{3,64}$/;
/** github.repo: owner/name, where the name isn't . or .. (a path in the API's URLs, not a repository). */
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must look like 1.0.0'),
  game: z
    .strictObject({
      dir: relPath.default('.'),
      entry: relPath.default('index.html'),
      buildCommand: z.string().min(1).nullable().default(null),
      outputDir: relPath.nullable().default(null),
    })
    .prefault({}),
  icon: relPath.nullable().default(null),
  keyArt: relPath.nullable().default(null),
  keyArtFocus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0.5, 0.5]),
  logo: relPath.nullable().default(null),
  // Mobile targets are only ever added on purpose: they need a bundle ID and a different build.
  targets: z.array(z.enum(TARGETS)).min(1).default([...DESKTOP_TARGETS]),
  window: z
    .strictObject({
      width: z.number().int().min(320).default(1280),
      height: z.number().int().min(240).default(720),
      fullscreen: z.boolean().default(true),
      resizable: z.boolean().default(true),
    })
    .prefault({}),
  steam: z
    .strictObject({
      appId: z.number().int().positive().default(480),
      /** The Steam account that uploads builds (publish). A name, never a password: SteamCMD keeps the login. */
      user: z.string().regex(STEAM_USER_PATTERN, 'must be a Steam account name: 3-64 letters, numbers or _').nullable().default(null),
      depots: z
        .strictObject({
          windows: z.number().int().positive().nullable().default(null),
          mac: z.number().int().positive().nullable().default(null),
          linux: z.number().int().positive().nullable().default(null),
        })
        .prefault({}),
      /** The developer's own Steamworks SDK: a zip or folder, relative to the project. null: found automatically. */
      sdk: relPath.nullable().default(null),
      overlay: z.enum(STEAM_OVERLAY_SETTINGS).default('auto'),
    })
    .prefault({}),
  mobile: z
    .strictObject({
      bundleId: z
        .string()
        .regex(BUNDLE_ID_PATTERN, 'must look like com.yourname.yourgame')
        .nullable()
        .default(null),
      orientation: z.enum(['landscape', 'portrait']).default('landscape'),
    })
    .prefault({}),
  itch: z
    .strictObject({
      project: z.string().regex(/^[\w-]+\/[\w-]+$/, 'must look like username/game').nullable().default(null),
    })
    .prefault({}),
  /** GitHub Releases (publish). The token comes from GITHUB_TOKEN or GH_TOKEN, never from this file. */
  github: z
    .strictObject({
      repo: z.string().regex(GITHUB_REPO_PATTERN, 'must look like owner/repo').nullable().default(null),
    })
    .prefault({}),
  plugins: z.array(relPath).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export function resolveDepots(config: Config): Record<DesktopTarget, number> {
  const { appId, depots } = config.steam;
  return {
    windows: depots.windows ?? appId + 1,
    mac: depots.mac ?? appId + 2,
    linux: depots.linux ?? appId + 3,
  };
}
