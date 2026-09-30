import { z } from 'zod';
import { COMMANDS, type CommandHelp, type FlagHelp } from '../cli/help.js';
import { TARGETS } from '../core/config/schema.js';

/**
 * MCP tools come from the CLI's command catalog (src/cli/help.ts): one per command, or one per action (`ci init`).
 * A command added there, such as Plan 4's `publish`, becomes a tool with no change to this folder. The notes below
 * only add what an agent should know and the few flags with their own rules.
 */

export type ToolInput = Record<string, unknown>;

export interface McpTool {
  /** gameshipper_<command>, or gameshipper_<command>_<action>. */
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  /** Changes nothing: runs at once, without waiting for other calls on the same game folder. */
  readOnly: boolean;
  /** The CLI arguments for an input: the command, its action and its flags. The server adds --dir and --json. */
  toArgs(input: ToolInput): string[];
}

interface ToolNotes {
  note?: string;
  readOnly?: boolean;
  /** Flags the tool sets itself; they aren't inputs. */
  hidden?: string[];
  /** Flags added from the input. */
  extraArgs?: (input: ToolInput) => string[];
}

/** `mcp` is this server. */
const NOT_TOOLS = new Set(['mcp']);

/** Flags whose values aren't free text. Other flags with a value take text (a `<list>`, several); the rest are switches. */
const FLAG_TYPES: Record<string, z.ZodType> = {
  'app-id': z.number().int().positive(),
  seconds: z.number().positive(),
  target: z.array(z.enum(TARGETS)).min(1),
  screenshot: z.array(z.number().positive()).min(1),
};

const NOTES: Record<string, ToolNotes> = {
  status: {
    readOnly: true,
    note: "Call it first, and whenever you're unsure what happened: it shows the config, what this computer can build, the builds in out/ and each command's last result and log.",
  },
  init: {
    note: "Never prompts: pass what you know. INPUT_REQUIRED names the input to add; CONFIG_EXISTS means it's set up already, so edit gameshipper.json instead. bundleId adds the ios and android targets.",
  },
  play: {
    note:
      'With smoke: true (or seconds) it runs the game briefly, quits and returns every problem found: fix them and call it again until ok is true. ' +
      'packaged: true runs the build in out/ instead of the game folder. Without smoke, seconds or screenshot it opens the game window for the human and returns at once with data.pid.',
    hidden: ['detach'],
    // A timed run waits for the game; anything else would block the agent until the human closes the window.
    extraArgs: (input) => (input.smoke === true || input.seconds !== undefined || input.screenshot !== undefined ? [] : ['--detach']),
  },
  build: {
    note: 'The first build downloads Electron for each OS and can take several minutes: progress notifications report each step. target: ["mac"] (or windows, linux) builds only that while iterating.',
  },
  check: {
    note: "Runs this computer's build (build it first) offline at Steam Deck size, then checks the builds and store images. Fix each failed check, build again, and check again; tell the human about warnings.",
  },
  publish: {
    note: "Never asks for or accepts passwords. STEAM_LOGIN_REQUIRED or ITCH_LOGIN_REQUIRED means the human must run the command in the error's fix once in their own terminal; then call this tool again.",
  },
  ci: { note: 'Tell the human to commit the workflow it writes.' },
};

const RESULT_NOTE = "Returns the command's result: { ok, data, errors[], warnings[], logPath }. Every error has a stable code, a message and a fix to follow.";

export const camelCase = (flag: string): string => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function flagSchema(flag: FlagHelp): z.ZodType {
  const list = flag.value === '<list>' ? z.array(z.string().min(1)).min(1) : null;
  const base = FLAG_TYPES[flag.name] ?? list ?? (flag.value ? z.string().min(1) : z.boolean());
  return base.optional().describe(flag.description);
}

function toolFor(command: CommandHelp, action: string | undefined): McpTool {
  const notes = NOTES[command.name] ?? {};
  const words = action ? [command.name, action] : [command.name];
  const flags = command.flags.filter((f) => !notes.hidden?.includes(f.name));
  const shape: Record<string, z.ZodType> = {
    dir: z.string().min(1).optional().describe("The game folder: absolute, or relative to the server's folder (the default)."),
  };
  for (const f of flags) shape[camelCase(f.name)] = flagSchema(f);
  return {
    name: `gameshipper_${words.join('_')}`,
    title: `Gameshipper ${words.join(' ')}`,
    description: [command.summary, notes.note, RESULT_NOTE].filter(Boolean).join(' '),
    inputSchema: z.strictObject(shape),
    readOnly: notes.readOnly ?? false,
    toArgs(input) {
      const args = [...words];
      for (const f of flags) {
        const value = input[camelCase(f.name)];
        if (value === undefined || value === false) continue;
        // --flag=value: a value that starts with "-" is still read as the value.
        args.push(value === true ? `--${f.name}` : `--${f.name}=${Array.isArray(value) ? value.join(',') : String(value)}`);
      }
      return [...args, ...(notes.extraArgs?.(input) ?? [])];
    },
  };
}

export function mcpTools(commands: readonly CommandHelp[] = COMMANDS): McpTool[] {
  return commands.filter((c) => !NOT_TOOLS.has(c.name)).flatMap((c) => (c.actions ?? [undefined]).map((action) => toolFor(c, action)));
}
