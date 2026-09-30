import { z } from 'zod';
import { ConfigSchema } from '../core/config/schema.js';
import { APPLE_ENV } from '../core/sign/credentials.js';
import { GAMESHIPPER_VERSION } from '../core/version.js';

export interface FlagHelp {
  name: string;
  /** One-letter form, e.g. `y` for `-y`. */
  short?: string;
  /** Present when the flag takes a value; the CLI parses these as strings and the rest as booleans. */
  value?: string;
  description: string;
}

export interface CommandHelp {
  name: string;
  /** Words the command needs right after its name, exactly one of them: `ci init`. */
  actions?: string[];
  summary: string;
  usage: string;
  flags: FlagHelp[];
}

export const GLOBAL_FLAGS: FlagHelp[] = [
  { name: 'json', description: 'Print the result as JSON on stdout and nothing else (for agents and scripts).' },
  { name: 'verbose', description: 'Also stream the run log to stderr.' },
  { name: 'yes', short: 'y', description: 'Never prompt; use detected defaults and flags.' },
  { name: 'dir', value: '<path>', description: 'Game folder (default: the current folder).' },
  { name: 'help', short: 'h', description: 'Show help for a command.' },
  { name: 'version', short: 'v', description: 'Print the Gameshipper version.' },
];

const FROZEN_LOCK: FlagHelp = {
  name: 'frozen-lock',
  description: 'Fail instead of accepting changed or new CDN files; for CI.',
};

const STEAM_SDK: FlagHelp = {
  name: 'steam-sdk',
  value: '<path>',
  description: 'Your Steamworks SDK zip or folder (instead of steam.sdk, GAMESHIPPER_STEAM_SDK or .sdk/).',
};

export const COMMANDS: CommandHelp[] = [
  {
    name: 'init',
    summary: 'Detect the game and write gameshipper.json.',
    usage: 'npx gameshipper init [--name <name>] [--app-id <id>] [--icon <png>] [--key-art <file>] [--logo <png>] [--bundle-id <id>]',
    flags: [
      { name: 'name', value: '<name>', description: 'Game name shown in windows and stores.' },
      { name: 'app-id', value: '<id>', description: "Steam App ID (default 480, Valve's test app)." },
      { name: 'icon', value: '<png|none>', description: 'Square PNG icon, at least 1024x1024.' },
      { name: 'key-art', value: '<file|none>', description: 'Key art for the store images: PNG or JPEG, 3840x2160 recommended.' },
      { name: 'logo', value: '<png|none>', description: 'Game logo on a transparent background, for the store images.' },
      {
        name: 'bundle-id',
        value: '<id|none>',
        description: 'Bundle ID like com.yourname.yourgame: adds the ios and android targets (Xcode and Android Studio projects). It can never change once the game is in a store.',
      },
      { name: 'entry', value: '<file>', description: "The game's HTML file (default: detected)." },
      { name: 'build-command', value: '<cmd>', description: 'Command that builds the game (default: detected).' },
      { name: 'output-dir', value: '<dir>', description: 'Folder the build command writes.' },
      { name: 'force', description: 'Overwrite an existing gameshipper.json.' },
    ],
  },
  {
    name: 'play',
    summary: 'Run the game in the desktop shell; F12 saves a 1920x1080 store screenshot. --smoke runs it briefly and reports problems.',
    usage: 'npx gameshipper play [--smoke [--seconds <n>]] [--screenshot <s,s,...>] [--packaged] [--detach] [--fullscreen] [--frozen-lock] [--steam-sdk <path>]',
    flags: [
      { name: 'smoke', description: 'Run for a few seconds, quit, and report errors, missing files, internet use and crashes.' },
      { name: 'seconds', value: '<n>', description: 'How long a smoke run lasts after loading (default 5, at most 600). Implies --smoke.' },
      {
        name: 'screenshot',
        value: '<s,s,...>',
        description: 'Save 1920x1080 store screenshots to out/store/screenshots this many seconds after loading, then quit (e.g. 5,10,15,20,25; up to 20 times, each at most 600).',
      },
      { name: 'fullscreen', description: 'Honour window.fullscreen (play is windowed by default).' },
      {
        name: 'packaged',
        description: "Run this computer's build from out/ (made by `build`) as it is, instead of preparing the game. With --smoke, tests the real build.",
      },
      { name: 'detach', description: 'Start the game and return at once, leaving it running. Not with --smoke, --seconds or --screenshot.' },
      FROZEN_LOCK,
      STEAM_SDK,
    ],
  },
  {
    name: 'build',
    summary: 'Build desktop apps and iOS/Android projects into out/<target>.',
    usage: 'npx gameshipper build [--target windows,mac,linux,ios,android] [--frozen-lock] [--steam-sdk <path>]',
    flags: [{ name: 'target', value: '<list>', description: 'Comma-separated subset of the configured targets.' }, FROZEN_LOCK, STEAM_SDK],
  },
  {
    name: 'check',
    summary: 'Launch the build for this computer and check it against Steam, Steam Deck and store requirements.',
    usage: 'npx gameshipper check [--seconds <n>]',
    flags: [{ name: 'seconds', value: '<n>', description: 'How long the game runs with the network blocked (default 15, at most 600).' }],
  },
  {
    name: 'status',
    summary: 'Show config, what this computer can build, outputs and the last result of each command.',
    usage: 'npx gameshipper status',
    flags: [],
  },
  {
    name: 'ci',
    actions: ['init'],
    summary: 'ci init: write a GitHub Actions workflow that builds, runs and uploads each desktop target on its own OS.',
    usage: 'npx gameshipper ci init [--force]',
    flags: [{ name: 'force', description: 'Replace an existing .github/workflows/gameshipper.yml.' }],
  },
  {
    name: 'mcp',
    summary: 'Serve every command as an MCP tool over stdio, for AI agents (Claude Code, Cursor, ...). --dir sets the default game folder.',
    usage: 'npx gameshipper mcp [--dir <path>]',
    flags: [],
  },
];

export const EXIT_CODES = { '0': 'success', '1': 'a target or check failed', '2': 'invalid config, usage or missing input' };

/** Every environment variable Gameshipper reads. Secrets (Apple's) only ever come from here, never from gameshipper.json. */
export const ENVIRONMENT: Array<{ name: string; description: string }> = [
  { name: 'GAMESHIPPER_CACHE', description: "Gameshipper's download cache (CDN files, Steamworks SDK libraries, native Steam bridges). Default: the OS's user cache folder." },
  { name: 'GAMESHIPPER_STEAM_SDK', description: 'Your Steamworks SDK zip or folder (after --steam-sdk and steam.sdk).' },
  {
    name: 'GAMESHIPPER_NPM_REGISTRY',
    description: "The npm registry other OSes' native Steam bridges (@koromix/koffi-*) are downloaded from. Default: npm_config_registry, then https://registry.npmjs.org.",
  },
  {
    name: 'GAMESHIPPER_SOFTWARE_GL',
    description:
      "Set to 1 on machines without a GPU (hosted CI runners) so games may render WebGL in software in play, smoke runs and check; a player's launch of a shipped game ignores it. The `ci init` workflow sets it.",
  },
  ...Object.entries(APPLE_ENV).map(([name, description]) => ({ name, description })),
];

export function helpData() {
  return {
    name: 'gameshipper',
    version: GAMESHIPPER_VERSION,
    commands: COMMANDS,
    globalFlags: GLOBAL_FLAGS,
    exitCodes: EXIT_CODES,
    environment: ENVIRONMENT,
    resultShape:
      'Every command prints { ok, data, errors[], warnings[], logPath }. logPath (the run log) is present for build, play and check, unless gameshipper.json is missing or invalid. Each error has code, message and fix; fix may be absent on warnings.',
    agentLoop: [
      'npx gameshipper status --json',
      'npx gameshipper init --yes --json',
      'npx gameshipper play --smoke --json   (fix errors, repeat until ok is true)',
      'npx gameshipper build --json',
      'npx gameshipper check --json   (fix what failed, build again, repeat)',
    ],
    /** Every gameshipper.json field; fields with defaults are optional. */
    configSchema: z.toJSONSchema(ConfigSchema, { io: 'input' }),
  };
}

/** One line per flag; when any flag in the list has a short form, long-only flags line up after it. */
function flagLines(flags: FlagHelp[]): string[] {
  const shortWidth = flags.some((f) => f.short) ? 4 : 0;
  return flags.map((f) => {
    const short = (f.short ? `-${f.short}, ` : '').padStart(shortWidth);
    return `  ${short}--${f.name}${f.value ? ` ${f.value}` : ''}`.padEnd(26 + shortWidth) + f.description;
  });
}

export function commandHelpText(c: CommandHelp): string {
  return [c.summary, '', `Usage: ${c.usage}`, ...(c.flags.length ? ['', 'Flags:', ...flagLines(c.flags)] : [])].join('\n');
}

export function helpText(): string {
  return [
    `gameshipper ${GAMESHIPPER_VERSION}: turn a web game folder into Steam-ready desktop builds.`,
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(8)}${c.summary}`),
    '',
    'Global flags:',
    ...flagLines(GLOBAL_FLAGS),
    '',
    'Typical run:',
    '  npx gameshipper init',
    '  npx gameshipper play --smoke',
    '  npx gameshipper build',
    '  npx gameshipper check',
    '',
    'AI agents: add --json to any command; nothing prompts when --json or --yes is set.',
    'MCP clients (Claude Code, Cursor, ...): `npx gameshipper mcp` serves every command as a tool.',
    'Run `npx gameshipper <command> --help` for its flags, or `npx gameshipper help --json` for',
    'this catalog as JSON, including every gameshipper.json field.',
  ].join('\n');
}
