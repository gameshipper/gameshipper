import * as fs from 'node:fs';
import * as path from 'node:path';
import { ICON_REQUIREMENT, iconFileProblem } from '../desktop/icons.js';
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

const ICON_FLAG_FIX = `Pass --icon with ${ICON_REQUIREMENT}, as a path relative to your game folder, or --icon none.`;

function unsuitableIcon(icon: string, found: string): GsError {
  return gsError(
    'ICON_UNSUITABLE',
    `${icon} ${found}; Steam needs ${ICON_REQUIREMENT}, so it wasn't used.`,
    `Export ${ICON_REQUIREMENT} and set "icon" in gameshipper.json to its path. Until then builds use the default Electron icon.`,
  );
}

interface InitPlan {
  entry: string | null;
  buildCommand: string | null;
  outputDir: string | null;
  icon: string | null;
  /** Problems that stop init before it writes anything. */
  errors: GsError[];
  warnings: GsError[];
}

/** Combines the answers with what was detected, and checks the result. Writes nothing. */
function planInit(dir: string, answers: InitAnswers, detected: Detected): InitPlan {
  const errors: GsError[] = [];
  const warnings: GsError[] = [];
  if (fs.existsSync(path.join(dir, CONFIG_FILE)) && !answers.force) {
    errors.push(gsError('CONFIG_EXISTS', 'gameshipper.json already exists.', 'Edit it directly, or pass --force to replace it.'));
  }
  const buildCommand = answers.buildCommand !== undefined ? answers.buildCommand : detected.buildCommand;
  const outputDir = answers.outputDir !== undefined ? answers.outputDir : detected.outputDir;
  const entry = answers.entry ?? detected.entry;
  if (!entry) {
    errors.push(gsError('INPUT_REQUIRED', "Couldn't find your game's HTML file.", 'Pass --entry <path-to-index.html>.'));
  } else if (!buildCommand && !fs.existsSync(path.join(dir, entry))) {
    // With a build command, the entry is in the build's output, which doesn't exist until it runs.
    errors.push(gsError('ENTRY_MISSING', `Can't find ${entry}.`, "Pass --entry with your game's HTML file, as a path relative to your game folder."));
  }

  let icon: string | null = null;
  if (answers.icon === undefined) {
    icon = detected.icon;
    if (!icon && detected.unsuitableIcon) warnings.push(unsuitableIcon(detected.unsuitableIcon.path, detected.unsuitableIcon.found));
  } else if (answers.icon !== null) {
    // An icon given explicitly must be a PNG; one that's the wrong size is only left out, like a detected one.
    const file = path.join(dir, answers.icon);
    const problem = fs.existsSync(file) ? iconFileProblem(file) : 'missing';
    if (problem === 'missing') errors.push(gsError('ASSET_MISSING', `icon: ${answers.icon} doesn't exist.`, ICON_FLAG_FIX));
    else if (problem?.code === 'ICON_INVALID') errors.push(gsError('ICON_INVALID', `icon: ${answers.icon} ${problem.found}.`, ICON_FLAG_FIX));
    else if (problem) warnings.push(unsuitableIcon(answers.icon, problem.found));
    else icon = answers.icon;
  }
  return { entry, buildCommand, outputDir, icon, errors, warnings };
}

/**
 * The errors init would stop with for these answers, without writing anything. The CLI checks this
 * before asking a person questions that would only end in an error.
 */
export function initErrors(dir: string, answers: InitAnswers = {}, detected: Detected = detectProject(dir)): GsError[] {
  return planInit(dir, answers, detected).errors;
}

export function initProject(dir: string, answers: InitAnswers = {}): Result<InitData> {
  const dirError = checkProjectDir(dir);
  if (dirError) return fail(dirError);
  const detected = detectProject(dir);
  const plan = planInit(dir, answers, detected);
  if (plan.errors.length) return fail(plan.errors);
  const parsed = parseConfig({
    name: answers.name ?? detected.name,
    version: '1.0.0',
    game: { dir: '.', entry: plan.entry, buildCommand: plan.buildCommand, outputDir: plan.outputDir },
    icon: plan.icon,
    steam: { appId: answers.appId ?? 480 },
  });
  if (!parsed.ok) return fail(parsed.errors);
  const config = parsed.data!;
  const configPath = path.join(dir, CONFIG_FILE);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const warnings = [...plan.warnings];
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
