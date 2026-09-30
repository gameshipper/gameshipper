#!/usr/bin/env node
// Real-agent check: Claude Code ships the fixture game with the Gameshipper plugin (skill + MCP server).
// Opt-in, because it uses a little Claude usage: GAMESHIPPER_AGENT_E2E=1 npm run test:agent
// Needs a built checkout (`npm run test:agent` builds it) and a logged-in `claude` CLI.
// AGENT_E2E_MODEL picks the model (default haiku); AGENT_E2E_BUDGET_USD caps the spend (default 1).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST_TARGET = { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform];
const MODEL = process.env.AGENT_E2E_MODEL || 'haiku';
const BUDGET = process.env.AGENT_E2E_BUDGET_USD || '1';

if (process.env.GAMESHIPPER_AGENT_E2E !== '1') {
  console.log('SKIPPED: set GAMESHIPPER_AGENT_E2E=1 to run it (it uses a little Claude usage).');
  process.exit(0);
}
if (spawnSync('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status !== 0) {
  console.log('SKIPPED: the claude CLI is not installed.');
  process.exit(0);
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'cli', 'main.js'))) {
  console.error('Run `npm run build` first.');
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-agent-'));
const game = path.join(work, 'game');
fs.cpSync(path.join(ROOT, 'fixtures', 'threejs-cdn'), game, { recursive: true });

// The plugin as users get it, except that its MCP server runs this checkout instead of the npm package.
const plugin = path.join(work, 'plugin');
fs.cpSync(path.join(ROOT, 'plugin'), plugin, { recursive: true });
const server = { command: process.execPath, args: [path.join(ROOT, 'bin', 'gameshipper.js'), 'mcp'] };
fs.writeFileSync(path.join(plugin, '.mcp.json'), `${JSON.stringify({ gameshipper: server }, null, 2)}\n`);

const PREFIX = 'mcp__plugin_gameshipper_gameshipper__';
const tools = ['gameshipper_status', 'gameshipper_init', 'gameshipper_play', 'gameshipper_build', 'gameshipper_check'].map((t) => PREFIX + t);
const prompt = [
  'Use Gameshipper to turn the web game in the current folder into a desktop app for this computer.',
  'Call it "Spinning Cube". Smoke-test it and fix anything that fails, build it for this computer\'s OS only, then run the readiness check.',
  'Do not open a game window for a human. Finish by replying with the path of the built executable and the checks that failed.',
].join(' ');

console.log(`Running Claude Code (${MODEL}, at most $${BUDGET}) in ${game} ...`);
// Bash is off, so the agent must use the MCP tools: `npx gameshipper` would run whatever npm has under that name.
const run = spawnSync(
  'claude',
  [
    '-p',
    prompt,
    '--plugin-dir',
    plugin,
    '--model',
    MODEL,
    '--max-budget-usd',
    BUDGET,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    [...tools, 'Read', 'Glob', 'Grep', 'Edit'].join(','),
    '--disallowedTools',
    'Bash',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
  ],
  { cwd: game, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 },
);
const events = run.stdout.split('\n').flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
fs.writeFileSync(path.join(work, 'transcript.jsonl'), run.stdout);

const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
const calls = events
  .filter((e) => e.type === 'assistant')
  .flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name.replace(PREFIX, ''), input: c.input ?? {} })));
const names = calls.map((c) => c.name);
const result = events.findLast((e) => e.type === 'result');
const lastRun = (command) => {
  const file = path.join(game, '.gameshipper', 'last', `${command}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

const checks = [
  // The server is often still "pending" when the session starts; the tool calls below prove it connected.
  ['plugin MCP server loaded', init?.mcp_servers?.some((s) => s.name === 'plugin:gameshipper:gameshipper' && s.status !== 'failed')],
  ['skill available', init?.skills?.includes('gameshipper:ship-web-game')],
  ['checked status first', names.find((n) => n.startsWith('gameshipper_')) === 'gameshipper_status'],
  ['smoke-tested', calls.some((c) => c.name === 'gameshipper_play' && (c.input.smoke === true || c.input.seconds !== undefined))],
  ['built', names.includes('gameshipper_build') && lastRun('build')?.ok === true],
  [`out/${HOST_TARGET} exists`, fs.existsSync(path.join(game, 'out', HOST_TARGET))],
  ['ran the check', names.includes('gameshipper_check') && lastRun('check') !== null],
  ['never opened a window for a human', !calls.some((c) => c.name === 'gameshipper_play' && !c.input.smoke && c.input.seconds === undefined && !c.input.screenshot)],
  ['agent finished', result?.subtype === 'success'],
];
for (const [name, pass] of checks) console.log(`${pass ? '✓' : '✗'} ${name}`);
console.log(`Tool calls: ${names.join(', ')}`);
console.log(`Cost: $${result?.total_cost_usd ?? '?'}  Transcript: ${path.join(work, 'transcript.jsonl')}`);
console.log(`Agent's answer: ${result?.result ?? '(none)'}`);
process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
