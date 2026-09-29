import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';
import { fail, gsError, ok, type GsError, type Result } from '../result.js';
import { ConfigSchema, type Config } from './schema.js';

export const CONFIG_FILE = 'gameshipper.json';

type Issue = z.ZodError['issues'][number];

const FIELD_FIX = 'Edit that field in gameshipper.json, then re-run. `npx gameshipper help --json` lists every field.';

function issueToError(issue: Issue): GsError {
  const where = issue.path.length ? issue.path.join('.') : '(top level)';
  return gsError('CONFIG_INVALID', `gameshipper.json → ${where}: ${issue.message}`, FIELD_FIX);
}

export function parseConfig(raw: unknown): Result<Config> {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues.map(issueToError));
  const config = parsed.data;
  if (config.game.buildCommand && !config.game.outputDir) {
    return fail(
      gsError(
        'CONFIG_INVALID',
        'gameshipper.json → game.outputDir: required when game.buildCommand is set',
        'Set game.outputDir to the folder your build writes (often "dist").',
      ),
    );
  }
  return ok(config);
}

/**
 * Reads and validates gameshipper.json. When the config is valid but a file it names doesn't exist
 * (ENTRY_MISSING, ASSET_MISSING), the result fails but still carries the config as `data`.
 */
export function loadConfig(projectDir: string): Result<Config> {
  const file = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    return fail(gsError('CONFIG_MISSING', `No gameshipper.json in ${projectDir}.`, 'Run `npx gameshipper init` in your game folder.'));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(
      gsError(
        'CONFIG_INVALID',
        `gameshipper.json isn't valid JSON: ${(e as Error).message}`,
        'Fix the JSON syntax (a missing comma or quote is typical).',
      ),
    );
  }
  const parsed = parseConfig(raw);
  if (!parsed.ok) return parsed;
  const config = parsed.data!;

  const errors: GsError[] = [];
  if (!config.game.buildCommand) {
    const entry = path.join(projectDir, config.game.dir, config.game.entry);
    if (!fs.existsSync(entry)) {
      errors.push(
        gsError(
          'ENTRY_MISSING',
          `Can't find ${path.relative(projectDir, entry)}.`,
          "Set game.entry in gameshipper.json to your game's HTML file (relative to game.dir).",
        ),
      );
    }
  }
  for (const key of ['icon', 'keyArt', 'logo'] as const) {
    const rel = config[key];
    if (rel && !fs.existsSync(path.join(projectDir, rel))) {
      errors.push(gsError('ASSET_MISSING', `${key}: ${rel} doesn't exist.`, `Fix the ${key} path in gameshipper.json or set it to null.`));
    }
  }
  // The config itself is valid, so return it with the errors: `status` still shows it.
  return errors.length ? fail(errors, [], config) : ok(config);
}
