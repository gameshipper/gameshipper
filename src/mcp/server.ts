import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { realOrSelf } from '../core/prepare/stage.js';
import { exitProcess } from '../core/proc.js';
import { errorDetails, type GsError, type Result } from '../core/result.js';
import { GAMESHIPPER_VERSION } from '../core/version.js';
import { createProgress } from './progress.js';
import { runCli, stopAllRuns, type RunCli } from './run-cli.js';
import { mcpTools, type McpTool, type ToolInput } from './tools.js';

const IssueSchema = z.looseObject({ code: z.string(), message: z.string(), fix: z.string().optional() });

/** Every tool's structured output: the command's Result. Loose, so fields added later still validate. */
export const ResultSchema = z.looseObject({
  ok: z.boolean(),
  data: z.unknown().optional(),
  errors: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
  logPath: z.string().optional(),
});

/** What the server tells agents when they connect: the loop, how to read results, and the rule about secrets. */
export function instructions(tools: readonly McpTool[]): string {
  const publish = tools.some((t) => t.name === 'gameshipper_publish');
  return [
    'Gameshipper turns a web game folder into Windows, Mac and Linux apps for Steam, and iOS and Android projects.',
    'Loop: gameshipper_status first; gameshipper_init when there is no gameshipper.json;',
    "gameshipper_play with smoke: true, fixing each error in the game's own files until ok is true; gameshipper_build;",
    `then gameshipper_check, fixing what fails and building again${publish ? '; then gameshipper_publish' : ''}.`,
    'Every tool returns { ok, data, errors[], warnings[], logPath }; each error has a code, a message and a fix: do what the fix says.',
    'gameshipper_play without smoke opens the game for the human and returns at once.',
    'Fixes are written for the CLI: `npx gameshipper build --target mac` in a fix means the tool gameshipper_build with target: ["mac"] (each --flag-name is the input flagName, and `ci init` is gameshipper_ci_init);',
    "don't run npx yourself, and leave a command the fix says the human must run in their terminal to the human.",
    "dir and steamSdk are absolute or relative to the server's folder; init's icon, keyArt, logo, entry and outputDir are relative to the game folder.",
    'Never ask the user for passwords, tokens or 2FA codes, and never pass them to a tool: logins happen in their own terminal.',
  ].join(' ');
}

export interface McpOptions {
  /** The game folder for calls without `dir`, and the folder relative paths in inputs start from. */
  projectDir: string;
  /** Runs a CLI command; by default the real CLI, in a child process. */
  run?: RunCli;
  tools?: McpTool[];
}

/** The CLI arguments for a call: the tool's own, the game folder and --json (plus --verbose for progress). */
export function toolArgs(tool: McpTool, input: ToolInput, dir: string, verbose: boolean): string[] {
  return [...tool.toArgs(input), `--dir=${dir}`, '--json', ...(verbose ? ['--verbose'] : [])];
}

/**
 * Runs one call at a time per game folder. Agents call tools in parallel, and two commands on one folder (play and
 * build, say) would overwrite each other's files in .gameshipper/ and out/. A folder is known by its real path, so
 * a link to it or another spelling of it (/var and /private/var, other letter case on macOS) shares its lock.
 * `onWait` is called at once when the call has to wait for another.
 */
export function createFolderLock(): <T>(dir: string, fn: () => Promise<T>, onWait?: () => void) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (dir, fn, onWait) => {
    const key = realOrSelf(dir);
    const previous = tails.get(key);
    if (previous) onWait?.();
    const call = (previous ?? Promise.resolve()).then(fn, fn);
    const tail = call.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return call;
  };
}

/** The longest issue message a tool returns. The CLI's own Result, the last-run record and the logs keep all of it. */
export const MAX_AGENT_MESSAGE_CHARS = 300;
const CUT = '… (see the log) …';
/** How much of a long message's end is kept: where a console error happened, e.g. "(main.js:12)", comes last. */
const KEPT_END_CHARS = 80;

/** The issue with a message of at most MAX_AGENT_MESSAGE_CHARS: its start and its end, cut in between. */
function shortIssue(issue: GsError): GsError {
  const { message } = issue;
  if (message.length <= MAX_AGENT_MESSAGE_CHARS) return issue;
  const start = message.slice(0, MAX_AGENT_MESSAGE_CHARS - CUT.length - KEPT_END_CHARS);
  return { ...issue, message: `${start}${CUT}${message.slice(-KEPT_END_CHARS)}` };
}

/**
 * The Result as a tool returns it, well under what an agent's tool output can hold even for a noisy game. Each
 * error's and warning's message is cut to MAX_AGENT_MESSAGE_CHARS. A smoke run's summary leaves out its list of
 * events (`eventsLeftOut` counts them): every problem in it is already in errors and warnings, and
 * data.smoke.eventsLog has them all.
 */
export function resultForAgent(result: Result<unknown>): Result<unknown> {
  const short = { ...result, errors: result.errors.map(shortIssue), warnings: result.warnings.map(shortIssue) };
  const data = result.data as { smoke?: { summary?: { events?: unknown } } } | undefined;
  const summary = data?.smoke?.summary;
  if (!summary || !Array.isArray(summary.events)) return short;
  const { events, ...rest } = summary;
  return { ...short, data: { ...data, smoke: { ...data.smoke, summary: { eventsLeftOut: events.length, ...rest } } } };
}

export function createMcpServer(opts: McpOptions): McpServer {
  const run = opts.run ?? runCli;
  const tools = opts.tools ?? mcpTools();
  const lock = createFolderLock();
  const server = new McpServer({ name: 'gameshipper', version: GAMESHIPPER_VERSION }, { capabilities: { tools: {} }, instructions: instructions(tools) });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: ResultSchema,
        annotations: { readOnlyHint: tool.readOnly },
      },
      async (input, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken;
        const progress =
          token === undefined
            ? undefined
            : createProgress((update) => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, ...update } }));
        const dir = typeof input.dir === 'string' ? path.resolve(opts.projectDir, input.dir) : opts.projectDir;
        const args = toolArgs(tool, input, dir, progress !== undefined);
        const exec = () => {
          progress?.running();
          return run(args, { cwd: opts.projectDir, onLine: progress?.line, signal: ctx.mcpReq.signal });
        };
        try {
          const result = resultForAgent(tool.readOnly ? await exec() : await lock(dir, exec, progress?.waiting));
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as unknown as Record<string, unknown>,
            isError: !result.ok,
          };
        } finally {
          progress?.stop();
        }
      },
    );
  }
  return server;
}

export interface ServeOptions extends McpOptions {
  /** Where the client's messages arrive (stdin) and where the answers go (stdout). */
  input: Readable;
  output: Writable;
  /**
   * The real CLI owns the process: on SIGINT, SIGTERM or SIGHUP, and on an uncaught error, the server stops the
   * commands it's running and exits (128 + the signal's number, or 1).
   */
  handleSignals?: boolean;
  /** Where the server reports its own problems (default: stderr, which clients keep as the server's log). */
  log?: (line: string) => void;
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Stops the running commands, then exits, on a signal or an uncaught error. Returns the function that removes it. */
function exitWithRuns(log: (line: string) => void): () => void {
  let stopping = false;
  const stopThenExit = (code: number): void => {
    void stopAllRuns().finally(() => exitProcess(code));
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    const code = 128 + (os.constants.signals[signal] ?? 0);
    // A second signal while the commands are stopping: exit now.
    if (stopping) exitProcess(code);
    stopping = true;
    stopThenExit(code);
  };
  const onError = (e: unknown): void => {
    log(`unexpected error: ${errorDetails(e)}`);
    if (stopping) return;
    stopping = true;
    stopThenExit(1);
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return () => {
    for (const signal of SIGNALS) process.off(signal, onSignal);
    process.off('uncaughtException', onError);
    process.off('unhandledRejection', onError);
  };
}

/**
 * Serves the tools over stdio until the client closes its end (stdin) or the transport closes itself (a message past
 * its 10 MiB limit, say), then stops any command still running and resolves with exit code 0. Only MCP messages are
 * written to `output`.
 */
export async function serveMcp(opts: ServeOptions): Promise<number> {
  const log = opts.log ?? ((line: string) => void process.stderr.write(`gameshipper mcp: ${line}\n`));
  let transportClosed!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    transportClosed = resolve;
    opts.input.once('end', resolve);
    opts.input.once('close', resolve);
  });
  /** The SDK's transport, telling serveMcp when it closes: it stops reading stdin then, so stdin may never end. */
  class Transport extends StdioServerTransport {
    override async close(): Promise<void> {
      await super.close();
      transportClosed();
    }
  }
  const unwatch = opts.handleSignals ? exitWithRuns(log) : undefined;
  try {
    const transport = new Transport(opts.input, opts.output);
    const connection = serveStdio(() => createMcpServer(opts), { transport, onerror: (e) => log(e.message) });
    await disconnected;
    // A transport that closed itself left stdin open, and reading it would keep the process running.
    opts.input.destroy();
    // Calls still in flight are cancelled, which stops their commands.
    await connection.close();
    await stopAllRuns();
    return 0;
  } finally {
    unwatch?.();
  }
}
