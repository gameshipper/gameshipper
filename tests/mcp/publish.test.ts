import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, type RunCli } from '../../src/mcp/run-cli.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { FAKE_BUTLER, FAKE_STEAMCMD, fakeProject } from '../helpers/fake-builds.js';
import { canRunTs, noteIfTsTestsSkipped } from '../helpers/node-features.js';
import { makeTmpDir } from '../helpers/tmp.js';

const RUNNER = fileURLToPath(new URL('../helpers/run-cli.mjs', import.meta.url));

/** The real CLI, from its sources, in a child process with stdin closed: exactly how the server runs a tool call. */
const realCli: RunCli = (args, opts) => runCli(['none', ...args], { ...opts, bin: RUNNER });

interface ToolResult {
  ok: boolean;
  data?: any;
  errors: Array<{ code: string; message: string; fix?: string }>;
  warnings: Array<{ code: string; message: string; fix?: string }>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

noteIfTsTestsSkipped('the MCP publish tests');

describe.skipIf(process.platform === 'win32' || !canRunTs)('gameshipper_publish through the MCP server', () => {
  it('is a tool, and returns login problems as structured errors instead of prompting', async () => {
    // No saved logins, and a SteamCMD that asks for a password: nobody is there to type one.
    vi.stubEnv('GAMESHIPPER_STEAMCMD', FAKE_STEAMCMD);
    vi.stubEnv('FAKE_STEAMCMD_STATE', makeTmpDir());
    vi.stubEnv('FAKE_STEAMCMD_MODE', 'prompt');
    vi.stubEnv('GAMESHIPPER_BUTLER', FAKE_BUTLER);
    vi.stubEnv('FAKE_BUTLER_STATE', makeTmpDir());
    vi.stubEnv('BUTLER_API_KEY', undefined);
    const p = fakeProject({ steam: { appId: 1234560, user: 'builder' }, itch: { project: 'moonstudio/moon-game' } });

    const server = createMcpServer({ projectDir: p.dir, run: realCli });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'gameshipper_publish');
      expect(tool?.inputSchema.properties).toHaveProperty('to');
      expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain('password');

      const started = Date.now();
      const r = await client.callTool({ name: 'gameshipper_publish', arguments: {} });
      const result = r.structuredContent as unknown as ToolResult;
      expect(r.isError).toBe(true);
      expect(result.errors.map((e) => e.code)).toEqual(['STEAM_LOGIN_REQUIRED', 'ITCH_LOGIN_REQUIRED']);
      for (const e of result.errors) expect(e.fix).toContain('in their own terminal');
      expect(result.data.destinations.map((d: { status: string }) => d.status)).toEqual(['failed', 'failed']);
      expect(Date.now() - started).toBeLessThan(60_000);

      // A dry run still needs Steam's login (Steam checks the build), but not itch.io's.
      const dry = (await client.callTool({ name: 'gameshipper_publish', arguments: { dryRun: true } })).structuredContent as unknown as ToolResult;
      expect(dry.errors.map((e) => e.code)).toEqual(['STEAM_LOGIN_REQUIRED']);
      expect(dry.warnings.map((w) => w.code)).toEqual(['ITCH_UPLOADS_LIVE', 'ITCH_LOGIN_REQUIRED']);
      expect(dry.data.destinations.map((d: { status: string }) => d.status)).toEqual(['failed', 'previewed']);
    } finally {
      await client.close();
    }
  });
});
