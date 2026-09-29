import { z } from 'zod';

export const TARGETS = ['windows', 'mac', 'linux', 'ios', 'android'] as const;
export type Target = (typeof TARGETS)[number];
export const DESKTOP_TARGETS = ['windows', 'mac', 'linux'] as const;
export type DesktopTarget = (typeof DESKTOP_TARGETS)[number];

const relPath = z.string().min(1);

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
  targets: z.array(z.enum(TARGETS)).min(1).default([...TARGETS]),
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
      depots: z
        .strictObject({
          windows: z.number().int().positive().nullable().default(null),
          mac: z.number().int().positive().nullable().default(null),
          linux: z.number().int().positive().nullable().default(null),
        })
        .prefault({}),
    })
    .prefault({}),
  mobile: z
    .strictObject({
      bundleId: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/, 'must look like com.yourname.yourgame')
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
