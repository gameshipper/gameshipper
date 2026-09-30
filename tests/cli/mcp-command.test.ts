import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { helpText } from '../../src/cli/help.js';
import { main, type CliIO } from '../../src/cli/main.js';
import { canRunTs, noteIfTsTestsSkipped } from '../helpers/node-features.js';
import { makeTmpDir } from '../helpers/tmp.js';

const RUNNER = fileURLToPath(new URL('../helpers/run-cli.mjs', import.meta.url));

async function run(argv: string[]): Promise<{ code: number; json: () => any }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY: false };
  const code = await main(argv, io);
  return { code, json: () => JSON.parse(out) };
}

describe('gameshipper mcp', () => {
  it('is in the catalog, with help', async () => {
    const help = await run(['mcp', '--help', '--json']);
    expect([help.code, help.json().data.usage]).toEqual([0, 'npx gameshipper mcp [--dir <path>]']);
    expect(helpText()).toContain('`npx gameshipper mcp` serves every command as a tool');
    const bogus = await run(['mcp', '--smoke', '--json']);
    expect([bogus.code, bogus.json().errors[0].message]).toEqual([2, "mcp doesn't take --smoke."]);
    const missing = await run(['mcp', '--json', '--dir', `${makeTmpDir()}/nope`]);
    expect([missing.code, missing.json().errors[0].code]).toEqual([2, 'DIR_MISSING']);
  });
});

noteIfTsTestsSkipped('the mcp process tests');

/** The real CLI, from its sources, as its own process: `mcp` owns stdin, stdout and the process's signals. */
function startServer(failure: 'none' | 'slow-load' = 'none') {
  const child = spawn(process.execPath, [RUNNER, failure, 'mcp', '--dir', makeTmpDir()], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  /** Every line on stdout, each parsed as JSON: anything that isn't would throw. */
  const messages = () =>
    stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { jsonrpc: string; id?: number; result?: any });
  const reply = async (id: number) => {
    for (let i = 0; i < 300; i++, await new Promise((r) => setTimeout(r, 50))) {
      const found = messages().find((m) => m.id === id);
      if (found) return found;
    }
    throw new Error(`no reply to ${id}; stderr: ${stderr}`);
  };
  const initialize = async () => {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const init = await reply(1);
    send({ method: 'notifications/initialized' });
    return init;
  };
  return { child, closed, send, reply, initialize, messages, stderr: () => stderr, stdout: () => stdout };
}

describe.skipIf(process.platform === 'win32' || !canRunTs)('the mcp process', () => {
  it('speaks only MCP on stdout, and exits 0 when the client closes stdin', async () => {
    const server = startServer();
    try {
      expect((await server.initialize()).result.serverInfo.name).toBe('gameshipper');
      server.send({ id: 2, method: 'tools/list' });
      const tools = (await server.reply(2)).result.tools.map((t: { name: string }) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['gameshipper_status', 'gameshipper_check', 'gameshipper_ci_init']));
      server.child.stdin.end();
      expect(await server.closed).toEqual({ code: 0, signal: null });
      expect(server.messages().every((m) => m.jsonrpc === '2.0')).toBe(true);
    } finally {
      server.child.kill('SIGKILL');
    }
  });

  it('exits 0 when the transport gives up on a message past its 10 MiB limit, though stdin is still open', async () => {
    const server = startServer();
    try {
      await server.initialize();
      // Without a newline, the message never ends. Stdin stays open: only the transport closes.
      server.child.stdin.write('x'.repeat(10 * 1024 * 1024 + 1));
      expect(await server.closed).toEqual({ code: 0, signal: null });
      expect(server.stderr()).toContain('maximum size');
    } finally {
      server.child.kill('SIGKILL');
    }
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s stops the server with exit code %i and no Result on stdout', async (signal, code) => {
    const server = startServer();
    try {
      await server.initialize();
      server.child.kill(signal);
      expect(await server.closed).toEqual({ code, signal: null });
      expect(server.messages().every((m) => m.jsonrpc === '2.0')).toBe(true);
      expect(server.stdout()).not.toContain('INTERRUPTED');
    } finally {
      server.child.kill('SIGKILL');
    }
  });

  it('a signal while the CLI loads says INTERRUPTED on stderr, keeping stdout for MCP', async () => {
    const server = startServer('slow-load');
    try {
      for (let i = 0; i < 200 && !server.stderr().includes('loading'); i++) await new Promise((r) => setTimeout(r, 50));
      server.child.kill('SIGTERM');
      expect((await server.closed).code).toBe(143);
      expect(server.stdout()).toBe('');
      expect(server.stderr()).toContain('✗ INTERRUPTED: Stopped by SIGTERM before finishing.');
    } finally {
      server.child.kill('SIGKILL');
    }
  });
});
