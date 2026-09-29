import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { listFiles } from '../fsutil.js';
import { GsFailure, gsError, type GsError } from '../result.js';

const SKIP_ANYWHERE = new Set(['.git', '.DS_Store', 'Thumbs.db', 'steam_appid.txt']);
const SKIP_TOP_LEVEL = new Set(['out', '.gameshipper', 'gameshipper.json', 'gameshipper.lock', 'node_modules']);
const TEXT_FILE = /\.(html?|m?js|css)$/i;

export function stageDirFor(projectDir: string): string {
  return path.join(projectDir, '.gameshipper', 'stage');
}

export async function runBuildCommand(ctx: Ctx, config: Config): Promise<void> {
  const command = config.game.buildCommand;
  if (!command) return;
  ctx.log(`running build command: ${command}`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, { cwd: ctx.projectDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => ctx.log(`[build] ${d.toString().trimEnd()}`));
    child.stderr.on('data', (d: Buffer) => ctx.log(`[build] ${d.toString().trimEnd()}`));
    child.on('error', reject);
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    throw new GsFailure(
      'BUILD_COMMAND_FAILED',
      `\`${command}\` exited with code ${code}.`,
      `Run \`${command}\` yourself to see the error. Its output is also in ${ctx.logPath}.`,
    );
  }
}

export async function stageGame(ctx: Ctx, config: Config): Promise<{ stageDir: string; warnings: GsError[] }> {
  const { buildCommand, outputDir, dir, entry } = config.game;
  const source = path.resolve(ctx.projectDir, buildCommand ? (outputDir ?? 'dist') : dir);
  if (!fs.existsSync(source)) {
    throw new GsFailure(
      'GAME_DIR_MISSING',
      `The game folder ${path.relative(ctx.projectDir, source) || '.'} doesn't exist.`,
      buildCommand ? 'Check game.outputDir matches the folder your build writes.' : 'Fix game.dir in gameshipper.json.',
    );
  }
  const stageDir = stageDirFor(ctx.projectDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  const keep = (src: string): boolean => {
    const rel = path.relative(source, src);
    if (rel === '') return true;
    const parts = rel.split(path.sep);
    const base = parts[parts.length - 1];
    if (SKIP_ANYWHERE.has(base)) return false;
    return !(parts.length === 1 && SKIP_TOP_LEVEL.has(base));
  };
  // Copy entry by entry: when the game lives in the project root, stageDir is inside `source`,
  // and fs.cpSync refuses to copy a folder into its own subdirectory.
  fs.mkdirSync(stageDir, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    if (keep(from)) fs.cpSync(from, path.join(stageDir, name), { recursive: true, filter: keep });
  }
  ctx.log(`staged ${source} → ${stageDir}`);

  if (!fs.existsSync(path.join(stageDir, entry))) {
    throw new GsFailure(
      'ENTRY_MISSING',
      buildCommand ? `Your build didn't produce ${path.join(outputDir ?? 'dist', entry)}.` : `Can't find ${path.join(dir, entry)}.`,
      "Set game.entry in gameshipper.json to your game's HTML file.",
    );
  }

  const warnings: GsError[] = [];
  for (const rel of listFiles(stageDir).filter((f) => TEXT_FILE.test(f))) {
    if (fs.readFileSync(path.join(stageDir, rel), 'utf8').includes('node_modules/')) {
      warnings.push(
        gsError(
          'NODE_MODULES_REFERENCED',
          `${rel} loads files from node_modules, which isn't packaged.`,
          'Add a build step (e.g. Vite) or copy those files into your game folder and load them from there.',
        ),
      );
    }
  }
  return { stageDir, warnings };
}
