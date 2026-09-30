import { z } from 'zod';
import { COMMANDS, MAX_SECONDS, type CommandHelp, type FlagHelp } from '../cli/help.js';
import { TARGETS } from '../core/config/schema.js';
import { MAX_SCREENSHOT_SECONDS, MAX_SCREENSHOTS } from '../core/play.js';

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
  /** The tool's summary, when the command's own speaks of CLI flags. */
  summary?: string;
  note?: string;
  /** Input descriptions, by flag name, for flags whose CLI descriptions speak of CLI syntax or don't say which folder a path is in. */
  flags?: Record<string, string>;
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
  seconds: z.number().positive().max(MAX_SECONDS),
  target: z.array(z.enum(TARGETS)).min(1),
  screenshot: z.array(z.number().positive().max(MAX_SCREENSHOT_SECONDS)).min(1).max(MAX_SCREENSHOTS),
};

const STEAM_SDK = "Your Steamworks SDK zip or folder (instead of steam.sdk, GAMESHIPPER_STEAM_SDK or .sdk/): absolute, or relative to the server's folder.";
const IN_GAME_FOLDER = 'relative to the game folder';

const NOTES: Record<string, ToolNotes> = {
  status: {
    readOnly: true,
    note: "Call it first, and whenever you're unsure what happened: it shows the config, what this computer can build, the builds in out/ and each command's last result and log.",
  },
  init: {
    note: "Never prompts: pass what you know. INPUT_REQUIRED names the input to add; CONFIG_EXISTS means it's set up already, so edit gameshipper.json instead. bundleId adds the ios and android targets.",
    flags: {
      icon: `Square PNG icon, at least 1024x1024: a path ${IN_GAME_FOLDER}, or "none".`,
      'key-art': `Key art for the store images, PNG or JPEG, 3840x2160 recommended: a path ${IN_GAME_FOLDER}, or "none".`,
      logo: `Game logo on a transparent background, for the store images: a PNG path ${IN_GAME_FOLDER}, or "none".`,
      entry: `The game's HTML file, ${IN_GAME_FOLDER} (default: detected).`,
      'output-dir': `Folder the build command writes, ${IN_GAME_FOLDER}.`,
    },
  },
  play: {
    summary: 'Run the game in the desktop shell the builds use.',
    note:
      'With smoke: true (or seconds) it runs the game briefly, quits and returns every problem found in errors and warnings (data.smoke.eventsLog lists every event): fix them and call it again until ok is true. ' +
      'packaged: true runs the build in out/ instead of the game folder. Without smoke, seconds or screenshot it opens the game window for the human and returns at once with data.pid.',
    flags: {
      seconds: `How long a smoke run lasts after the game loads, in seconds (default 5, at most ${MAX_SECONDS}). Implies smoke.`,
      screenshot: `Seconds after the game loads at which to save 1920x1080 store screenshots to out/store/screenshots, then quit, e.g. [5, 10, 15, 20, 25] (up to ${MAX_SCREENSHOTS} times, each at most ${MAX_SCREENSHOT_SECONDS}).`,
      packaged: "Run this computer's build from out/ (made by gameshipper_build) as it is, instead of preparing the game. With smoke, tests the real build.",
      'steam-sdk': STEAM_SDK,
    },
    hidden: ['detach'],
    // A timed run waits for the game; anything else would block the agent until the human closes the window.
    extraArgs: (input) => (input.smoke === true || input.seconds !== undefined || input.screenshot !== undefined ? [] : ['--detach']),
  },
  build: {
    note: 'The first build downloads Electron for each OS and can take several minutes: progress notifications report each step. target: ["mac"] (or windows, linux) builds only that while iterating.',
    flags: {
      target: 'Build only these of the configured targets, e.g. ["mac"] (default: all of them).',
      'steam-sdk': STEAM_SDK,
    },
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

/** CLI text for agents: `--smoke` becomes the input `smoke`, `--app-id` `appId`. NOTES rewrite what reads badly. */
const withoutFlags = (text: string): string => text.replace(/--([a-z][a-z-]*)/g, (_, flag: string) => camelCase(flag));

function flagSchema(flag: FlagHelp, description: string): z.ZodType {
  const list = flag.value === '<list>' ? z.array(z.string().min(1)).min(1) : null;
  const base = FLAG_TYPES[flag.name] ?? list ?? (flag.value ? z.string().min(1) : z.boolean());
  return base.optional().describe(description);
}

function toolFor(command: CommandHelp, action: string | undefined): McpTool {
  const notes = NOTES[command.name] ?? {};
  const words = action ? [command.name, action] : [command.name];
  const flags = command.flags.filter((f) => !notes.hidden?.includes(f.name));
  const shape: Record<string, z.ZodType> = {
    dir: z.string().min(1).optional().describe("The game folder: absolute, or relative to the server's folder (the default)."),
  };
  for (const f of flags) shape[camelCase(f.name)] = flagSchema(f, notes.flags?.[f.name] ?? withoutFlags(f.description));
  return {
    name: `gameshipper_${words.join('_')}`,
    title: `Gameshipper ${words.join(' ')}`,
    description: [notes.summary ?? withoutFlags(command.summary), notes.note, RESULT_NOTE].filter(Boolean).join(' '),
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
