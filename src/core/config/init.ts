import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkProjectDir } from '../fsutil.js';
import { fail, gsError, ok, type GsError, type Result } from '../result.js';
import { detectProject, type Detected } from './detect.js';
import { CONFIG_FILE, parseConfig } from './load.js';
import type { Config } from './schema.js';

export interface InitAnswers {
  name?: string;
  appId?: number;
  icon?: string | null;
  entry?: string;
  buildCommand?: string | null;
  outputDir?: string | null;
  force?: boolean;
}

export interface InitData {
  configPath: string;
  config: Config;
  detected: Detected;
  gitignoreUpdated: boolean;
}

const IGNORE_LINES = ['.gameshipper/', 'out/'];

function updateGitignore(dir: string): boolean {
  const file = path.join(dir, '.gitignore');
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, 'utf8');
  const lines = current.split(/\r?\n/);
  const missing = IGNORE_LINES.filter((l) => !lines.includes(l));
  if (!missing.length) return false;
  const prefix = current.endsWith('\n') || current === '' ? '' : '\n';
  fs.appendFileSync(file, `${prefix}# Gameshipper\n${missing.join('\n')}\n`);
  return true;
}

export function initProject(dir: string, answers: InitAnswers = {}): Result<InitData> {
  const dirError = checkProjectDir(dir);
  if (dirError) return fail(dirError);
  const configPath = path.join(dir, CONFIG_FILE);
  if (fs.existsSync(configPath) && !answers.force) {
    return fail(gsError('CONFIG_EXISTS', 'gameshipper.json already exists.', 'Edit it directly, or pass --force to replace it.'));
  }
  const detected = detectProject(dir);
  const buildCommand = answers.buildCommand !== undefined ? answers.buildCommand : detected.buildCommand;
  const outputDir = answers.outputDir !== undefined ? answers.outputDir : detected.outputDir;
  const entry = answers.entry ?? detected.entry;
  if (!entry) {
    return fail(gsError('INPUT_REQUIRED', "Couldn't find your game's HTML file.", 'Pass --entry <path-to-index.html>.'));
  }
  const parsed = parseConfig({
    name: answers.name ?? detected.name,
    version: '1.0.0',
    game: { dir: '.', entry, buildCommand, outputDir },
    icon: answers.icon !== undefined ? answers.icon : detected.icon,
    steam: { appId: answers.appId ?? 480 },
  });
  if (!parsed.ok) return fail(parsed.errors);
  const config = parsed.data!;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const warnings: GsError[] = [];
  if (config.steam.appId === 480) {
    warnings.push(
      gsError(
        'STEAM_TEST_APP',
        "Using Valve's test app (480) until you set your own Steam App ID.",
        'When you have one, set steam.appId in gameshipper.json (or re-run init with --app-id).',
      ),
    );
  }
  return ok({ configPath, config, detected, gitignoreUpdated: updateGitignore(dir) }, warnings);
}
