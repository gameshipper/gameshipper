import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { runBuild } from '../core/build.js';
import { detectProject } from '../core/config/detect.js';
import { initErrors, initProject, type InitAnswers } from '../core/config/init.js';
import { loadConfig } from '../core/config/load.js';
import { TARGETS, type Target } from '../core/config/schema.js';
import { createCtx, type Ctx } from '../core/context.js';
import { checkProjectDir } from '../core/fsutil.js';
import { runPlay, type PlayData } from '../core/play.js';
import { childrenStopped, QUIT_GRACE_MS } from '../core/proc.js';
import { capture, errorDetails, fail, gsError, internalError, ok, type GsError, type Result } from '../core/result.js';
import { saveLastRun } from '../core/runs.js';
import { getStatus } from '../core/status.js';
import { GAMESHIPPER_VERSION } from '../core/version.js';
import { COMMANDS, commandHelpText, GLOBAL_FLAGS, helpData, helpText, type CommandHelp } from './help.js';
import { exitCodeFor, renderHuman, renderJson } from './output.js';
import { createPrompter, type Prompter } from './prompt.js';
import { buildSummary, initSummary, playSummary, plural, statusSummary } from './summaries.js';

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
/**
 * The real CLI. Only with this IO does `main` take over the process: stray stdout writes, signals and
 * uncaught errors. A caller passing its own IO (tests, an embedding tool) keeps its process as it is.
 */
const defaultIO: CliIO = { write: (t) => void realStdoutWrite(t), stdinIsTTY: Boolean(process.stdin.isTTY) };

/**
 * Sends anything else that writes to stdout (a dependency's console.log, a debug logger) to stderr,
 * so stdout only ever carries the command's output. Returns a function that undoes it.
 */
export function divertStdout(): () => void {
  const original = process.stdout.write;
  process.stdout.write = ((...args: Parameters<typeof process.stderr.write>) => process.stderr.write(...args)) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
  };
}

/** Every flag the help catalog documents, parsed the way it documents it. */
const ALL_FLAGS = [...GLOBAL_FLAGS, ...COMMANDS.flatMap((c) => c.flags)];
const FLAG_SPEC: ParseArgsOptionsConfig = Object.fromEntries(
  ALL_FLAGS.map((f) => [f.name, { type: f.value ? ('string' as const) : ('boolean' as const), ...(f.short ? { short: f.short } : {}) }]),
);
const BOOLEAN_FLAGS = new Set(ALL_FLAGS.filter((f) => !f.value).map((f) => f.name));
const STRING_FLAGS = new Set(ALL_FLAGS.filter((f) => f.value).map((f) => f.name));

const INTERRUPT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

type Values = Record<string, string | boolean | undefined>;
type Outcome = { result: Result<unknown>; human: string[] };

/** What the output, the safety net and the signal handlers know about the command in progress. */
interface RunState {
  json: boolean;
  verbose: boolean;
  /** Set once a Result has been printed: nothing else is printed or recorded after it. */
  done: boolean;
  /** Set when a signal or an uncaught error decided how the process exits. */
  exitCode?: number;
  /** build and play: the command and its run log, for the last-run record. */
  command?: string;
  ctx?: Ctx;
  /**
   * Set once an interactive play session's game is running, with what its result would carry. A person
   * ends such a session with Ctrl+C as often as by closing the window.
   */
  playing?: { data: PlayData; warnings: GsError[] };
}

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const usage = (message: string, fix: string): Outcome => ({ result: fail(gsError('USAGE', message, fix)), human: [] });
const flagsFix = (spec: CommandHelp) => {
  const own = spec.flags.map((f) => `--${f.name}`).join(', ') || 'none besides the global flags';
  return `Flags for ${spec.name}: ${own}. Run \`npx gameshipper ${spec.name} --help\` for details.`;
};

/** Before parsing succeeds (or when it fails): --json, or --json=<anything but false>. */
const jsonInArgv = (argv: string[]) => argv.some((a) => a === '--json' || (a.startsWith('--json=') && a.toLowerCase() !== '--json=false'));

/** parseArgs takes no value for a boolean flag, so `--json=true` becomes `--json` and `--json=false` is dropped. */
function normalizeBooleanFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    const m = /^--([^=]+)=(true|false)$/i.exec(arg);
    if (m && BOOLEAN_FLAGS.has(m[1])) {
      if (m[2].toLowerCase() === 'true') out.push(`--${m[1]}`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** The command a person typed, skipping flags and the values of flags that take one. */
function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return argv[i + 1];
    if (!arg.startsWith('-') || arg === '-') return arg;
    if (arg.startsWith('--') && !arg.includes('=') && STRING_FLAGS.has(arg.slice(2))) i++;
  }
  return undefined;
}

function parseFailure(e: unknown, argv: string[]): Outcome {
  const command = firstPositional(argv);
  const spec = COMMANDS.find((c) => c.name === command);
  const fix = spec ? flagsFix(spec) : 'Run `npx gameshipper help` to see the commands and their flags.';
  const message = e instanceof Error ? e.message : String(e);
  const unknown = /^Unknown option '([^']+)'/.exec(message);
  if (unknown) return usage(`Unknown flag ${unknown[1]}.`, fix);
  const valued = /^Option '(--[^' ]+)' does not take an argument/.exec(message);
  if (valued) return usage(`${valued[1]} doesn't take a value (use ${valued[1]}, ${valued[1]}=true or ${valued[1]}=false).`, fix);
  return usage(message, fix);
}

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

/** Records the run for `status`. Best-effort: a failure becomes a warning on the result. */
function recordRun(projectDir: string, command: string, result: Result<unknown>): void {
  const warning = saveLastRun(projectDir, command, result);
  if (warning) result.warnings = [...result.warnings, warning];
}

/** The run log starts with what ran and ends with how it went, so a reported log stands on its own. */
function startRun(projectDir: string, command: string, run: RunState): Ctx {
  const ctx = createCtx(projectDir, command, { verbose: run.verbose });
  run.ctx = ctx;
  run.command = command;
  ctx.log(`gameshipper ${GAMESHIPPER_VERSION} ${command} in ${projectDir} (node ${process.version}, ${process.platform}/${process.arch})`);
  return ctx;
}

function finishRun(ctx: Ctx, command: string, result: Result<unknown>, run: RunState): void {
  // An interrupt or uncaught error already reported and recorded this run.
  if (run.done) return;
  result.logPath = ctx.logPath;
  ctx.log(result.ok ? `${command} succeeded` : `${command} failed: ${result.errors.map((e) => e.code).join(', ')}`);
  recordRun(ctx.projectDir, command, result);
}

function emit(io: CliIO, run: RunState, { result, human }: Outcome): number {
  if (run.done) return run.exitCode ?? exitCodeFor(result);
  run.done = true;
  io.write(run.json ? renderJson(result) : `${renderHuman(result, human)}\n`);
  return exitCodeFor(result);
}

async function initCommand(projectDir: string, values: Values, io: CliIO, run: RunState): Promise<Outcome> {
  const detected = detectProject(projectDir);
  const iconFlag = str(values.icon);
  const flags: InitAnswers = {
    icon: iconFlag === undefined ? undefined : iconFlag === 'none' ? null : iconFlag,
    entry: str(values.entry),
    buildCommand: str(values['build-command']),
    outputDir: str(values['output-dir']),
    force: values.force === true,
  };
  // Asking questions only to then fail (an existing config, a missing HTML file or icon) would waste a person's time.
  const willFail = initErrors(projectDir, flags, detected).length > 0;
  const interactive = io.stdinIsTTY && !run.json && !values.yes && !willFail;
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
  const iconAnswer =
    flags.icon !== undefined || !interactive ? undefined : await prompt.ask('Icon PNG, 1024x1024 ("none" to skip)', detected.icon ?? 'none');
  const result = initProject(projectDir, {
    ...flags,
    name,
    appId,
    ...(iconAnswer === undefined ? {} : { icon: iconAnswer === 'none' ? null : iconAnswer }),
  });
  if (result.ok) recordRun(projectDir, 'init', result);
  return { result, human: initSummary(result) };
}

/**
 * build and play read gameshipper.json before they write anything: without a valid one the folder isn't a
 * Gameshipper project, so it gets no .gameshipper folder, run log or last-run record.
 */
const notAProject = (loaded: Result<unknown>): Outcome | null => (loaded.data ? null : { result: fail(loaded.errors, loaded.warnings), human: [] });

async function buildCommand(projectDir: string, values: Values, run: RunState): Promise<Outcome> {
  const only = parseTargets(str(values.target));
  if (only && !Array.isArray(only)) return only;
  const loaded = loadConfig(projectDir);
  const invalid = notAProject(loaded);
  if (invalid) return invalid;
  const ctx = startRun(projectDir, 'build', run);
  // A config with a missing file still carries the config as data; that is not a build result.
  const result: Result<unknown> = loaded.ok
    ? await capture(() => runBuild(ctx, loaded.data!, { shellDir: SHELL_DIR, only, frozenLock: values['frozen-lock'] === true }), ctx.log)
    : fail(loaded.errors, loaded.warnings);
  finishRun(ctx, 'build', result, run);
  return { result, human: buildSummary(result as Parameters<typeof buildSummary>[0], projectDir) };
}

async function playCommand(projectDir: string, values: Values, io: CliIO, run: RunState): Promise<Outcome> {
  const secondsRaw = str(values.seconds);
  const seconds = secondsRaw === undefined ? 5 : Number(secondsRaw);
  if (!Number.isFinite(seconds) || seconds <= 0) return usage('--seconds must be a positive number.', 'For example: --seconds 10');
  const smoke = values.smoke === true || secondsRaw !== undefined;
  const loaded = loadConfig(projectDir);
  const invalid = notAProject(loaded);
  if (invalid) return invalid;
  const ctx = startRun(projectDir, 'play', run);
  let result: Result<unknown>;
  if (loaded.ok) {
    if (!run.json) {
      io.write(smoke ? `Running the game for ${plural(seconds, 'second')} to check it…\n` : "Starting the game. Close its window when you're done.\n");
    }
    const frozenLock = values['frozen-lock'] === true;
    result = await capture(
      () =>
        runPlay(ctx, loaded.data!, {
          shellDir: SHELL_DIR,
          smokeSeconds: smoke ? seconds : undefined,
          fullscreen: values.fullscreen === true,
          frozenLock,
          onGameStarted: (data, warnings) => (run.playing = { data, warnings }),
        }),
      ctx.log,
    );
  } else {
    result = fail(loaded.errors, loaded.warnings);
  }
  finishRun(ctx, 'play', result, run);
  return { result, human: playSummary(result as Parameters<typeof playSummary>[0], { smoke }) };
}

async function dispatch(argv: string[], io: CliIO, run: RunState): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: normalizeBooleanFlags(argv), options: FLAG_SPEC, strict: true, allowPositionals: true }) as {
      values: Values;
      positionals: string[];
    });
  } catch (e) {
    return emit(io, run, parseFailure(e, argv));
  }
  run.json = values.json === true;
  run.verbose = values.verbose === true;
  const [command = 'help', ...extra] = positionals;

  if (values.version) {
    io.write(run.json ? renderJson(ok({ version: GAMESHIPPER_VERSION })) : `${GAMESHIPPER_VERSION}\n`);
    return 0;
  }
  if (command === 'help') {
    if (!extra.length) {
      io.write(run.json ? renderJson(ok(helpData())) : `${helpText()}\n`);
      return 0;
    }
    const topic = COMMANDS.find((c) => c.name === extra[0]);
    if (!topic || extra.length > 1) return emit(io, run, usage(`Unknown help topic "${extra.join(' ')}".`, 'Run `npx gameshipper help` to see the commands.'));
    io.write(run.json ? renderJson(ok(topic)) : `${commandHelpText(topic)}\n`);
    return 0;
  }

  const spec = COMMANDS.find((c) => c.name === command);
  if (!spec) return emit(io, run, usage(`Unknown command "${command}".`, 'Run `npx gameshipper help` to see the commands.'));
  if (extra.length) return emit(io, run, usage(`${command} doesn't take "${extra[0]}"; options are flags.`, flagsFix(spec)));
  const allowed = new Set([...GLOBAL_FLAGS, ...spec.flags].map((f) => f.name));
  const stray = Object.keys(values).find((k) => !allowed.has(k));
  if (stray) return emit(io, run, usage(`${command} doesn't take --${stray}.`, flagsFix(spec)));
  if (values.help) {
    io.write(run.json ? renderJson(ok(spec)) : `${commandHelpText(spec)}\n`);
    return 0;
  }

  const dirFlag = str(values.dir);
  if (dirFlag !== undefined && !dirFlag.trim()) {
    return emit(io, run, usage('--dir needs a folder path.', 'Pass your game folder, like --dir ./my-game, or leave --dir out to use the current folder.'));
  }
  // Before anything writes into it: a mistyped --dir must not leave a stray .gameshipper folder.
  const projectDir = path.resolve(dirFlag ?? process.cwd());
  const dirError = checkProjectDir(projectDir);
  if (dirError) return emit(io, run, { result: fail(dirError), human: [] });

  switch (command) {
    case 'init':
      return emit(io, run, await initCommand(projectDir, values, io, run));
    case 'build':
      return emit(io, run, await buildCommand(projectDir, values, run));
    case 'play':
      return emit(io, run, await playCommand(projectDir, values, io, run));
    default: {
      const result = getStatus(projectDir);
      return emit(io, run, { result, human: statusSummary(result) });
    }
  }
}

/**
 * Finishes the Result for a run that ended abnormally (a signal, or an unexpected error): logged, with the
 * log path, and recorded as the command's last run so `status` doesn't keep showing an earlier success.
 */
function abnormalResult(run: RunState, result: Result<unknown>, details: string): Result<unknown> {
  const { ctx, command } = run;
  if (ctx) {
    result.logPath = ctx.logPath;
    try {
      ctx.log(details);
    } catch {
      // The log itself may be what failed.
    }
    if (command) recordRun(ctx.projectDir, command, result);
  } else if (run.verbose) {
    process.stderr.write(`${details}\n`);
  }
  return result;
}

/** INTERNAL_ERROR for a person: one line, plus the log path when there is one. */
function renderCrash(result: Result<unknown>, json: boolean): string {
  if (json) return renderJson(result);
  const [error] = result.errors;
  return `✗ ${error.code}: ${error.message} ${error.fix}\n${result.logPath ? `Log: ${result.logPath}\n` : ''}`;
}

/** Anything thrown out of a command: an INTERNAL_ERROR Result (exit 1), with the stack in the run log. */
function crash(e: unknown, io: CliIO, run: RunState): number {
  if (run.done) return run.exitCode ?? 1;
  run.done = true;
  const result = abnormalResult(run, fail(internalError(e)), errorDetails(e));
  try {
    io.write(renderCrash(result, run.json));
  } catch {
    // Nowhere left to report it; the exit code still says it failed.
  }
  return 1;
}

/**
 * Writes the final output, then exits once it's flushed (a pipe to an agent may be asynchronous) and any
 * game asked to quit has stopped (exiting kills it). The backstop covers a write that never finishes.
 */
function exitAfterWriting(text: string, code: number): void {
  process.exitCode = code;
  const backstop = setTimeout(() => process.exit(code), 2000 + QUIT_GRACE_MS);
  // Runs after the signal's other listeners (like the one asking the game to quit), so it waits for them.
  const exit = (): void => {
    void childrenStopped().then(() => {
      clearTimeout(backstop);
      process.exit(code);
    });
  };
  try {
    realStdoutWrite(text, exit);
  } catch {
    setImmediate(exit);
  }
}

/**
 * While the real CLI runs a command: a signal ends it with an INTERRUPTED Result (exit 128 + signal number;
 * Ctrl+C in an interactive play session is an ok Result with a PLAY_STOPPED warning, still exit 130),
 * and an uncaught error or unhandled rejection with an INTERNAL_ERROR Result (exit 1). Either is printed
 * once and recorded as the last run. The child-stopping handlers in core/proc.ts still stop builds and games
 * (an interactive game is first asked to quit), and leave the exit to these. Returns the function that
 * removes the handlers.
 */
function watchProcess(run: RunState): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    const code = 128 + (os.constants.signals[signal] ?? 0);
    // A second signal while the result is being written: stop now.
    if (run.done) process.exit(run.exitCode ?? code);
    run.done = true;
    run.exitCode = code;
    // Ctrl+C is one of the ways a person ends an interactive play session, not a failed play. Before the
    // game is running (its build step, say), it interrupts the run like any other.
    const outcome =
      run.playing && signal === 'SIGINT'
        ? ok(run.playing.data, [...run.playing.warnings, gsError('PLAY_STOPPED', 'Stopped by Ctrl+C.')])
        : fail(gsError('INTERRUPTED', `Stopped by ${signal} before finishing.`, "Run the command again when you're ready."));
    const result = abnormalResult(run, outcome, `stopped by ${signal}`);
    exitAfterWriting(run.json ? renderJson(result) : `${renderHuman(result, [])}\n`, code);
  };
  const onUncaught = (e: unknown): void => {
    // Already on the way out with a Result printed.
    if (run.done) return;
    run.done = true;
    run.exitCode = 1;
    exitAfterWriting(renderCrash(abnormalResult(run, fail(internalError(e)), errorDetails(e)), run.json), 1);
  };
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, onSignal);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  return () => {
    for (const signal of INTERRUPT_SIGNALS) process.off(signal, onSignal);
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
  };
}

export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  // Refined from the parsed flags; this covers output before (or instead of) a successful parse.
  const run: RunState = { json: jsonInArgv(argv), verbose: argv.includes('--verbose'), done: false };
  const ownProcess = io === defaultIO;
  const restoreStdout = ownProcess ? divertStdout() : undefined;
  const unwatch = ownProcess ? watchProcess(run) : undefined;
  try {
    const code = await dispatch(argv, io, run);
    return run.exitCode ?? code;
  } catch (e) {
    return crash(e, io, run);
  } finally {
    unwatch?.();
    restoreStdout?.();
  }
}
