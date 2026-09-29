import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runBuild } from '../core/build.js';
import { detectProject } from '../core/config/detect.js';
import { initProject } from '../core/config/init.js';
import { CONFIG_FILE, loadConfig } from '../core/config/load.js';
import { TARGETS, type Target } from '../core/config/schema.js';
import { createCtx, type Ctx } from '../core/context.js';
import { checkProjectDir } from '../core/fsutil.js';
import { runPlay } from '../core/play.js';
import { capture, errorDetails, fail, gsError, internalError, ok, type Result } from '../core/result.js';
import { saveLastRun } from '../core/runs.js';
import { getStatus } from '../core/status.js';
import { GAMESHIPPER_VERSION } from '../core/version.js';
import { COMMANDS, commandHelpText, GLOBAL_FLAGS, helpData, helpText, type CommandHelp } from './help.js';
import { exitCodeFor, renderHuman, renderJson } from './output.js';
import { createPrompter, type Prompter } from './prompt.js';
import { buildSummary, initSummary, playSummary, statusSummary } from './summaries.js';

/** The compiled shell that gets bundled into every game: dist/cli/main.js → dist/shell/. */
export const SHELL_DIR = fileURLToPath(new URL('../shell/', import.meta.url));

export interface CliIO {
  /** Where results go: stdout. With --json, exactly one JSON Result is written here. */
  write(text: string): void;
  stdinIsTTY: boolean;
  /** Injectable for tests; defaults to asking on stdin, with questions on stderr. */
  prompter?: Prompter;
}

const realStdoutWrite = process.stdout.write.bind(process.stdout);
const defaultIO: CliIO = { write: (t) => void realStdoutWrite(t), stdinIsTTY: Boolean(process.stdin.isTTY) };

/**
 * Sends anything else that writes to stdout (a dependency's console.log, a debug logger) to stderr,
 * so `--json` output stays exactly one JSON document. Returns a function that undoes it.
 */
export function divertStdout(): () => void {
  const original = process.stdout.write;
  process.stdout.write = ((...args: Parameters<typeof process.stderr.write>) => process.stderr.write(...args)) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
  };
}

const FLAG_SPEC = {
  json: { type: 'boolean' },
  verbose: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  dir: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  name: { type: 'string' },
  'app-id': { type: 'string' },
  icon: { type: 'string' },
  entry: { type: 'string' },
  'build-command': { type: 'string' },
  'output-dir': { type: 'string' },
  force: { type: 'boolean' },
  smoke: { type: 'boolean' },
  seconds: { type: 'string' },
  fullscreen: { type: 'boolean' },
  target: { type: 'string' },
  'frozen-lock': { type: 'boolean' },
} as const;

type Values = Record<string, string | boolean | undefined>;
type Outcome = { result: Result<unknown>; human: string[] };
/** What the safety net knows about the command in progress. */
type RunState = { ctx?: Ctx };

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const usage = (message: string, fix: string): Outcome => ({ result: fail(gsError('USAGE', message, fix)), human: [] });
const flagsFix = (spec: CommandHelp) => {
  const own = spec.flags.map((f) => `--${f.name}`).join(', ') || 'none besides the global flags';
  return `Flags for ${spec.name}: ${own}. Run \`npx gameshipper ${spec.name} --help\` for details.`;
};

function parseTargets(raw: string | undefined): Target[] | Outcome | undefined {
  if (raw === undefined) return undefined;
  const list = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const fix = `Use any of: ${TARGETS.join(', ')}.`;
  if (!list.length) return usage('--target needs at least one target.', fix);
  const bad = list.find((t) => !(TARGETS as readonly string[]).includes(t));
  if (bad) return usage(`Unknown target "${bad}".`, fix);
  return list as Target[];
}

/** The run log starts with what ran and ends with how it went, so a reported log stands on its own. */
function startRun(projectDir: string, command: string, values: Values, run: RunState): Ctx {
  const ctx = createCtx(projectDir, command, { verbose: values.verbose === true });
  run.ctx = ctx;
  ctx.log(`gameshipper ${GAMESHIPPER_VERSION} ${command} in ${projectDir} (node ${process.version}, ${process.platform}/${process.arch})`);
  return ctx;
}

function finishRun(ctx: Ctx, command: string, result: Result<unknown>): void {
  result.logPath = ctx.logPath;
  ctx.log(result.ok ? `${command} succeeded` : `${command} failed: ${result.errors.map((e) => e.code).join(', ')}`);
  saveLastRun(ctx.projectDir, command, result);
}

async function initCommand(projectDir: string, values: Values, io: CliIO): Promise<Outcome> {
  const detected = detectProject(projectDir);
  // Asking questions only to then fail on an existing config or a missing HTML file would waste a person's time.
  const willFail = (values.force !== true && fs.existsSync(path.join(projectDir, CONFIG_FILE))) || !(str(values.entry) ?? detected.entry);
  const interactive = io.stdinIsTTY && !values.json && !values.yes && !willFail;
  const prompt = io.prompter ?? createPrompter(interactive);

  const name = str(values.name) ?? (interactive ? await prompt.ask('Game name', detected.name) : undefined);
  const appIdRaw = str(values['app-id']) ?? (interactive ? await prompt.ask('Steam App ID (480 = Valve test app)', '480') : undefined);
  let appId: number | undefined;
  if (appIdRaw !== undefined) {
    appId = Number(appIdRaw);
    if (!/^\d+$/.test(appIdRaw.trim()) || !Number.isSafeInteger(appId) || appId <= 0) {
      return usage(`--app-id must be a whole number, like 1234567 (got "${appIdRaw}").`, 'Find it in the Steamworks dashboard URL.');
    }
  }
  const iconRaw = str(values.icon) ?? (interactive ? await prompt.ask('Icon PNG, 1024x1024 ("none" to skip)', detected.icon ?? 'none') : undefined);
  const result = initProject(projectDir, {
    name,
    appId,
    icon: iconRaw === undefined ? undefined : iconRaw === 'none' ? null : iconRaw,
    entry: str(values.entry),
    buildCommand: str(values['build-command']),
    outputDir: str(values['output-dir']),
    force: values.force === true,
  });
  if (result.ok) saveLastRun(projectDir, 'init', result);
  return { result, human: initSummary(result) };
}

async function buildCommand(projectDir: string, values: Values, run: RunState): Promise<Outcome> {
  const only = parseTargets(str(values.target));
  if (only && !Array.isArray(only)) return only;
  const ctx = startRun(projectDir, 'build', values, run);
  const loaded = loadConfig(projectDir);
  // A config with a missing file still carries the config as data; that is not a build result.
  const result: Result<unknown> = loaded.ok
    ? await capture(() => runBuild(ctx, loaded.data!, { shellDir: SHELL_DIR, only, frozenLock: values['frozen-lock'] === true }), ctx.log)
    : fail(loaded.errors, loaded.warnings);
  finishRun(ctx, 'build', result);
  return { result, human: buildSummary(result as Parameters<typeof buildSummary>[0], projectDir) };
}

async function playCommand(projectDir: string, values: Values, io: CliIO, run: RunState): Promise<Outcome> {
  const secondsRaw = str(values.seconds);
  const seconds = secondsRaw === undefined ? 5 : Number(secondsRaw);
  if (!Number.isFinite(seconds) || seconds <= 0) return usage('--seconds must be a positive number.', 'For example: --seconds 10');
  const smoke = values.smoke === true || secondsRaw !== undefined;
  const ctx = startRun(projectDir, 'play', values, run);
  const loaded = loadConfig(projectDir);
  let result: Result<unknown>;
  if (loaded.ok) {
    if (!values.json) {
      io.write(smoke ? `Running the game for ${seconds} seconds to check it…\n` : "Starting the game. Close its window when you're done.\n");
    }
    const frozenLock = values['frozen-lock'] === true;
    result = await capture(
      () => runPlay(ctx, loaded.data!, { shellDir: SHELL_DIR, smokeSeconds: smoke ? seconds : undefined, fullscreen: values.fullscreen === true, frozenLock }),
      ctx.log,
    );
  } else {
    result = fail(loaded.errors, loaded.warnings);
  }
  finishRun(ctx, 'play', result);
  return { result, human: playSummary(result as Parameters<typeof playSummary>[0], { smoke }) };
}

function parseFailure(e: unknown, argv: string[]): Outcome {
  const spec = COMMANDS.find((c) => argv.includes(c.name));
  const message = e instanceof Error ? e.message : String(e);
  const unknown = /^Unknown option '([^']+)'/.exec(message);
  const fix = spec ? flagsFix(spec) : 'Run `npx gameshipper help` to see the commands and their flags.';
  return usage(unknown ? `Unknown flag ${unknown[1]}.` : message, fix);
}

async function dispatch(argv: string[], io: CliIO, json: boolean, run: RunState): Promise<number> {
  const emit = ({ result, human }: Outcome): number => {
    io.write(json ? renderJson(result) : `${renderHuman(result, human)}\n`);
    return exitCodeFor(result);
  };

  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: FLAG_SPEC, strict: true, allowPositionals: true }) as {
      values: Values;
      positionals: string[];
    });
  } catch (e) {
    return emit(parseFailure(e, argv));
  }
  const [command = 'help', ...extra] = positionals;

  if (values.version) {
    io.write(json ? renderJson(ok({ version: GAMESHIPPER_VERSION })) : `${GAMESHIPPER_VERSION}\n`);
    return 0;
  }
  if (command === 'help') {
    if (!extra.length) {
      io.write(json ? renderJson(ok(helpData())) : `${helpText()}\n`);
      return 0;
    }
    const topic = COMMANDS.find((c) => c.name === extra[0]);
    if (!topic || extra.length > 1) return emit(usage(`Unknown help topic "${extra.join(' ')}".`, 'Run `npx gameshipper help` to see the commands.'));
    io.write(json ? renderJson(ok(topic)) : `${commandHelpText(topic)}\n`);
    return 0;
  }

  const spec = COMMANDS.find((c) => c.name === command);
  if (!spec) return emit(usage(`Unknown command "${command}".`, 'Run `npx gameshipper help` to see the commands.'));
  if (extra.length) {
    return emit(usage(`${command} doesn't take "${extra[0]}"; options are flags.`, flagsFix(spec)));
  }
  const allowed = new Set([...GLOBAL_FLAGS, ...spec.flags].map((f) => f.name));
  const stray = Object.keys(values).find((k) => !allowed.has(k));
  if (stray) return emit(usage(`${command} doesn't take --${stray}.`, flagsFix(spec)));
  if (values.help) {
    io.write(json ? renderJson(ok(spec)) : `${commandHelpText(spec)}\n`);
    return 0;
  }

  // Before anything writes into it: a mistyped --dir must not leave a stray .gameshipper folder.
  const projectDir = path.resolve(str(values.dir) ?? process.cwd());
  const dirError = checkProjectDir(projectDir);
  if (dirError) return emit({ result: fail(dirError), human: [] });

  switch (command) {
    case 'init':
      return emit(await initCommand(projectDir, values, io));
    case 'build':
      return emit(await buildCommand(projectDir, values, run));
    case 'play':
      return emit(await playCommand(projectDir, values, io, run));
    default: {
      const result = getStatus(projectDir);
      return emit({ result, human: statusSummary(result) });
    }
  }
}

/** Anything unexpected: an INTERNAL_ERROR Result (exit 1), with the stack in the run log when there is one. */
function crash(e: unknown, argv: string[], io: CliIO, json: boolean, run: RunState): number {
  const error = internalError(e);
  const logPath = run.ctx?.logPath;
  try {
    run.ctx?.log(errorDetails(e));
  } catch {
    // The log itself may be what failed.
  }
  if (!logPath && argv.includes('--verbose')) process.stderr.write(`${errorDetails(e)}\n`);
  const result: Result<unknown> = { ...fail(error), ...(logPath ? { logPath } : {}) };
  try {
    io.write(json ? renderJson(result) : `✗ ${error.code}: ${error.message} ${error.fix}\n${logPath ? `Log: ${logPath}\n` : ''}`);
  } catch {
    // Nowhere left to report it; the exit code still says it failed.
  }
  return 1;
}

export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const json = argv.includes('--json');
  const restoreStdout = json && io === defaultIO ? divertStdout() : undefined;
  const run: RunState = {};
  try {
    return await dispatch(argv, io, json, run);
  } catch (e) {
    return crash(e, argv, io, json, run);
  } finally {
    restoreStdout?.();
  }
}
