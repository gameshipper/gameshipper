import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/cli/help.js';
import { fail, gsError, ok, type Result } from '../../src/core/result.js';
import type { RunCli, RunOptions } from '../../src/mcp/run-cli.js';
import { createFolderLock, createMcpServer, instructions, serveMcp } from '../../src/mcp/server.js';
import { mcpTools } from '../../src/mcp/tools.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Call {
  args: string[];
  opts?: RunOptions;
}

/** A CLI stand-in that records each run and answers `result`, after writing `lines` to its log. */
function fakeRun(result: Result<unknown>, lines: string[] = []): { run: RunCli; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCli = async (args, opts) => {
    calls.push({ args, opts });
    for (const line of lines) {
      opts?.onLine?.(line);
      await sleep(5);
    }
    return result;
  };
  return { run, calls };
}

async function connect(run: RunCli, tools = mcpTools()): Promise<Client> {
  const server = createMcpServer({ projectDir: '/games/moon', run, tools });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('MCP server', () => {
  it('lists the tools with input and output schemas, and tells agents the loop', async () => {
    const client = await connect(fakeRun(ok({})).run);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(mcpTools().map((t) => t.name));
    const build = tools.find((t) => t.name === 'gameshipper_build');
    expect(build?.inputSchema.properties).toHaveProperty('target');
    expect(build?.outputSchema?.properties).toHaveProperty('errors');
    expect(tools.find((t) => t.name === 'gameshipper_status')?.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toBe(instructions(mcpTools()));
    expect(client.getInstructions()).toContain('Never ask the user for passwords');
  });

  it('mentions publish in the loop only once the tool exists', () => {
    expect(instructions(mcpTools())).not.toContain('gameshipper_publish');
    const publish = { name: 'publish', summary: 'Upload the builds.', usage: 'npx gameshipper publish', flags: [] };
    expect(instructions(mcpTools([...COMMANDS, publish]))).toContain('gameshipper_publish');
  });

  it('runs the CLI command for the tool and returns its Result as structured content', async () => {
    const result = { ...ok({ outDir: '/games/moon/out' }), logPath: '/games/moon/.gameshipper/logs/build.log' };
    const { run, calls } = fakeRun(result);
    const client = await connect(run);
    const r = await client.callTool({ name: 'gameshipper_build', arguments: { target: ['mac'] } });
    expect(calls[0].args).toEqual(['build', '--target=mac', '--dir=/games/moon', '--json']);
    expect(calls[0].opts?.cwd).toBe('/games/moon');
    expect(r.structuredContent).toEqual(result);
    expect(r.isError).toBe(false);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toEqual(result);
  });

  it("resolves dir against the server's folder", async () => {
    const { run, calls } = fakeRun(ok({}));
    const client = await connect(run);
    await client.callTool({ name: 'gameshipper_status', arguments: { dir: 'sub/game' } });
    await client.callTool({ name: 'gameshipper_status', arguments: { dir: '/elsewhere' } });
    expect(calls.map((c) => c.args.find((a) => a.startsWith('--dir=')))).toEqual([`--dir=${path.resolve('/games/moon', 'sub/game')}`, `--dir=${path.resolve('/elsewhere')}`]);
  });

  it('marks a failed Result as a tool error and passes it on untouched, login errors included', async () => {
    const result = fail(gsError('STEAM_LOGIN_REQUIRED', 'Steam needs you to log in.', 'Ask the human to run `npx gameshipper publish` in a terminal.'));
    const client = await connect(fakeRun(result).run);
    const r = await client.callTool({ name: 'gameshipper_status', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual(result);
  });

  it('rejects inputs the command does not take, before running anything', async () => {
    const { run, calls } = fakeRun(ok({}));
    const client = await connect(run);
    for (const args of [{ target: ['xbox'] }, { app_id: 480 }]) {
      const r = await client.callTool({ name: 'gameshipper_build', arguments: args });
      expect(r.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('sends progress from the --verbose log when the client asks for it', async () => {
    const { run, calls } = fakeRun(ok({}), ['staging', 'packaging mac']);
    const client = await connect(run);
    const progress: Array<{ progress: number; message?: string }> = [];
    await client.callTool({ name: 'gameshipper_build', arguments: {} }, { onprogress: (p) => void progress.push(p) });
    expect(calls[0].args.at(-1)).toBe('--verbose');
    expect(progress[0]).toEqual({ progress: 1, message: 'staging' });
    await client.callTool({ name: 'gameshipper_build', arguments: {} });
    expect(calls[1].args).not.toContain('--verbose');
  });

  it('never runs two commands on the same game folder at once; status never waits', async () => {
    let running = 0;
    let most = 0;
    const statusWhileBusy: number[] = [];
    let busy!: () => void;
    const firstStarted = new Promise<void>((resolve) => (busy = resolve));
    const run: RunCli = async (args) => {
      if (args[0] === 'status') {
        statusWhileBusy.push(running);
        return ok({});
      }
      most = Math.max(most, ++running);
      busy();
      await sleep(200);
      running--;
      return ok({});
    };
    const client = await connect(run);
    await Promise.all([
      client.callTool({ name: 'gameshipper_build', arguments: {} }),
      client.callTool({ name: 'gameshipper_play', arguments: { smoke: true } }),
      firstStarted.then(() => client.callTool({ name: 'gameshipper_status', arguments: {} })),
    ]);
    expect(most).toBe(1);
    expect(statusWhileBusy).toEqual([1]);
  });
});

describe('createFolderLock', () => {
  it('runs calls for one folder one at a time, and other folders in parallel', async () => {
    const lock = createFolderLock();
    const events: string[] = [];
    const job = (name: string, ms: number) => async () => {
      events.push(`${name} start`);
      await sleep(ms);
      events.push(`${name} end`);
      return name;
    };
    const results = await Promise.all([lock('/a', job('a1', 40)), lock('/a', job('a2', 5)), lock('/b', job('b1', 5))]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    expect(events.indexOf('a2 start')).toBeGreaterThan(events.indexOf('a1 end'));
    expect(events.indexOf('b1 start')).toBeLessThan(events.indexOf('a1 end'));
  });

  it('keeps going after a call throws', async () => {
    const lock = createFolderLock();
    await expect(
      lock('/a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await lock('/a', async () => 'next')).toBe('next');
  });
});

describe('serveMcp', () => {
  /** Newline-delimited JSON-RPC over two in-memory pipes, as a client would speak it over stdio. */
  function pipes() {
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: any[] = [];
    let buffered = '';
    output.setEncoding('utf8').on('data', (d: string) => {
      buffered += d;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
    });
    const send = (message: object) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const reply = async (id: number) => {
      for (let i = 0; i < 200; i++, await sleep(10)) {
        const found = messages.find((m) => m.id === id);
        if (found) return found;
      }
      throw new Error(`no reply to ${id}`);
    };
    return { input, output, messages, send, reply };
  }

  it('answers on its output only with protocol messages, and returns 0 once the client closes its input', async () => {
    const io = pipes();
    let aborted = false;
    const run: RunCli = (_args, opts) =>
      new Promise((resolve) => {
        opts?.signal?.addEventListener('abort', () => {
          aborted = true;
          resolve(fail(gsError('INTERRUPTED', 'Stopped.')));
        });
      });
    const serving = serveMcp({ projectDir: '/games/moon', run, input: io.input, output: io.output });
    io.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect((await io.reply(1)).result.serverInfo.name).toBe('gameshipper');
    io.send({ method: 'notifications/initialized' });
    io.send({ id: 2, method: 'tools/list' });
    expect((await io.reply(2)).result.tools.map((t: { name: string }) => t.name)).toContain('gameshipper_check');
    // A build still running when the client leaves is stopped.
    io.send({ id: 3, method: 'tools/call', params: { name: 'gameshipper_build', arguments: {} } });
    await sleep(50);
    io.input.end();
    expect(await serving).toBe(0);
    expect(aborted).toBe(true);
    expect(io.messages.every((m) => m.jsonrpc === '2.0')).toBe(true);
  });
});
