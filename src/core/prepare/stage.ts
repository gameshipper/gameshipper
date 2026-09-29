import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { listFiles } from '../fsutil.js';
import { GsFailure, gsError, type GsError } from '../result.js';

const SKIP_ANYWHERE = new Set(['.git', '.DS_Store', 'Thumbs.db', 'steam_appid.txt']);
/** Also skipped at the top level: every dot entry (.gameshipper, .claude, .vscode, .github, ...). */
const SKIP_TOP_LEVEL = new Set(['out', 'gameshipper.json', 'gameshipper.lock', 'node_modules', 'CLAUDE.md', 'AGENTS.md']);
const TEXT_FILE = /\.(html?|m?js|css)$/i;

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_LINES = 20;
/** Enough to hold the last lines of output without buffering a whole build log. */
const OUTPUT_TAIL_CHARS = 64 * 1024;

const isEnvFile = (name: string): boolean => name === '.env' || name.startsWith('.env.');

/** `rel` is relative to the game folder. */
function isSkipped(rel: string): boolean {
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];
  if (SKIP_ANYWHERE.has(base) || isEnvFile(base)) return true;
  return parts.length === 1 && (base.startsWith('.') || SKIP_TOP_LEVEL.has(base));
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Stop a build command and everything it started (e.g. the node process behind `npm run dev`). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () =>
      child.kill('SIGKILL'),
    );
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function formatDuration(ms: number): string {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function stageDirFor(projectDir: string): string {
  return path.join(projectDir, '.gameshipper', 'stage');
}

export async function runBuildCommand(ctx: Ctx, config: Config, opts: { timeoutMs?: number } = {}): Promise<void> {
  const command = config.game.buildCommand;
  if (!command) return;
  const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS;
  ctx.log(`running build command: ${command}`);
  let output = '';
  const outcome = await new Promise<number | 'timeout'>((resolve, reject) => {
    // On POSIX the command gets its own process group, so a timeout can stop everything it started.
    const child = spawn(command, {
      cwd: ctx.projectDir,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const onData = (text: string): void => {
      ctx.log(`[build] ${text.trimEnd()}`);
      output = (output + text).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    const timer = setTimeout(() => {
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve('timeout');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });
  const withOutput = (message: string): string => {
    const tail = output.trimEnd().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join('\n');
    return tail.trim() ? `${message} Last lines of its output:\n${tail}` : message;
  };
  if (outcome === 'timeout') {
    ctx.log(`build command timed out after ${formatDuration(timeoutMs)}`);
    throw new GsFailure(
      'BUILD_COMMAND_TIMEOUT',
      withOutput(`\`${command}\` was still running after ${formatDuration(timeoutMs)}, so Gameshipper stopped it.`),
      'Build commands must finish and exit. Use a one-shot build like `npm run build`, not a dev server or watcher like `npm run dev`.',
    );
  }
  if (outcome !== 0) {
    throw new GsFailure(
      'BUILD_COMMAND_FAILED',
      withOutput(`\`${command}\` exited with code ${outcome}.`),
      `Run \`${command}\` yourself to see the error. Its output is also in ${ctx.logPath}.`,
    );
  }
}

export async function stageGame(ctx: Ctx, config: Config): Promise<{ stageDir: string; warnings: GsError[] }> {
  const { buildCommand, outputDir, dir, entry } = config.game;
  const source = path.resolve(ctx.projectDir, buildCommand ? (outputDir ?? 'dist') : dir);
  const shown = path.relative(ctx.projectDir, source) || '.';
  const setting = buildCommand ? 'game.outputDir' : 'game.dir';
  if (!fs.existsSync(source)) {
    throw new GsFailure(
      'GAME_DIR_MISSING',
      `The game folder ${shown} doesn't exist.`,
      buildCommand ? 'Check game.outputDir matches the folder your build writes.' : 'Fix game.dir in gameshipper.json.',
    );
  }
  if (!fs.statSync(source).isDirectory()) {
    throw new GsFailure(
      'GAME_DIR_INVALID',
      `The game folder ${shown} isn't a folder.`,
      `Set ${setting} in gameshipper.json to the folder that holds your game files.`,
    );
  }
  // The stage lives in .gameshipper. Staging a folder above the project (e.g. game.dir "..")
  // or inside .gameshipper would copy the stage into itself.
  const project = fs.realpathSync(ctx.projectDir);
  const realSource = fs.realpathSync(source);
  const workDir = path.join(project, '.gameshipper');
  if (realSource !== project && (isWithin(workDir, realSource) || isWithin(realSource, workDir))) {
    throw new GsFailure(
      'GAME_DIR_INVALID',
      `The game folder ${shown} overlaps this project's .gameshipper folder, where Gameshipper stages the game.`,
      `Set ${setting} in gameshipper.json to the folder that holds your game files (e.g. "." or "dist"), not a parent folder or .gameshipper.`,
    );
  }
  const stageDir = stageDirFor(ctx.projectDir);
  fs.rmSync(stageDir, { recursive: true, force: true });
  const keep = (src: string): boolean => {
    const rel = path.relative(source, src);
    return rel === '' || !isSkipped(rel);
  };
  const warnings: GsError[] = [];
  // Copy entry by entry: when the game lives in the project root, stageDir is inside `source`,
  // and fs.cpSync refuses to copy a folder into its own subdirectory.
  fs.mkdirSync(stageDir, { recursive: true });
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, item.name);
    if (!keep(from)) continue;
    if (item.isSymbolicLink() && !fs.existsSync(from)) {
      warnings.push(
        gsError(
          'BROKEN_SYMLINK',
          `${path.relative(ctx.projectDir, from)} is a link to something that doesn't exist, so it wasn't staged.`,
          'Remove the link or point it at a real file.',
        ),
      );
      continue;
    }
    fs.cpSync(from, path.join(stageDir, item.name), { recursive: true, filter: keep });
  }
  ctx.log(`staged ${source} → ${stageDir}`);

  if (!fs.existsSync(path.join(stageDir, entry))) {
    throw new GsFailure(
      'ENTRY_MISSING',
      buildCommand ? `Your build didn't produce ${path.join(outputDir ?? 'dist', entry)}.` : `Can't find ${path.join(dir, entry)}.`,
      "Set game.entry in gameshipper.json to your game's HTML file.",
    );
  }

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
