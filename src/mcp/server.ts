import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { exitProcess } from '../core/proc.js';
import { errorDetails } from '../core/result.js';
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
 * build, say) would overwrite each other's files in .gameshipper/ and out/.
 */
export function createFolderLock(): <T>(dir: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (dir, fn) => {
    const call = (tails.get(dir) ?? Promise.resolve()).then(fn, fn);
    const tail = call.catch(() => undefined);
    tails.set(dir, tail);
    void tail.then(() => {
      if (tails.get(dir) === tail) tails.delete(dir);
    });
    return call;
  };
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
        const exec = () => run(args, { cwd: opts.projectDir, onLine: progress?.line, signal: ctx.mcpReq.signal });
        try {
          const result = tool.readOnly ? await exec() : await lock(dir, exec);
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
 * Serves the tools over stdio until the client closes its end (stdin), then stops any command still running and
 * resolves with exit code 0. Only MCP messages are written to `output`.
 */
export async function serveMcp(opts: ServeOptions): Promise<number> {
  const log = opts.log ?? ((line: string) => void process.stderr.write(`gameshipper mcp: ${line}\n`));
  const disconnected = new Promise<void>((resolve) => {
    opts.input.once('end', resolve);
    opts.input.once('close', resolve);
  });
  const unwatch = opts.handleSignals ? exitWithRuns(log) : undefined;
  try {
    const transport = new StdioServerTransport(opts.input, opts.output);
    const connection = serveStdio(() => createMcpServer(opts), { transport, onerror: (e) => log(e.message) });
    await disconnected;
    // Calls still in flight are cancelled, which stops their commands.
    await connection.close();
    await stopAllRuns();
    return 0;
  } finally {
    unwatch?.();
  }
}
