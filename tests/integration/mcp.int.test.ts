import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST_TARGET, readEvents, ROOT } from '../helpers/built-cli.js';
import { FAKE_STEAMCMD, fakeProject } from '../helpers/fake-builds.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const BRIDGE_OK = 'gameshipper-bridge:{"ok":true}';
/** A first build may download Electron; progress notifications keep the call alive meanwhile. */
const LONG = { timeout: 14 * 60_000, resetTimeoutOnProgress: true };

interface ToolResult {
  ok: boolean;
  data?: any;
  errors: Array<{ code: string; message: string; fix?: string }>;
  warnings: Array<{ code: string; message: string; fix?: string }>;
  logPath?: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('gameshipper mcp, driven by a real MCP client', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let dir: string;

  beforeAll(async () => {
    dir = makeTmpDir('gs-mcp-');
    fs.cpSync(path.join(ROOT, 'fixtures', 'threejs-cdn'), dir, { recursive: true });
    writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
    // The SDK passes a server only a few safe variables by default; the tests' GAMESHIPPER_* settings must reach it.
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    // publish gets the fake SteamCMD, with no saved login.
    Object.assign(env, { GAMESHIPPER_STEAMCMD: FAKE_STEAMCMD, FAKE_STEAMCMD_STATE: makeTmpDir('gs-mcp-steamcmd-') });
    transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'gameshipper.js'), 'mcp', '--dir', dir], env, stderr: 'inherit' });
    client = new Client({ name: 'gameshipper-integration-test', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}, onprogress?: (p: { progress: number; message?: string }) => void) {
    const r = await client.callTool({ name, arguments: args }, { ...LONG, onprogress });
    return { isError: r.isError === true, result: r.structuredContent as unknown as ToolResult };
  }

  it('lists one tool per command, check included, and tells agents never to ask for passwords', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['gameshipper_init', 'gameshipper_play', 'gameshipper_build', 'gameshipper_check', 'gameshipper_publish', 'gameshipper_status', 'gameshipper_ci_init']);
    expect(client.getInstructions()).toContain('Never ask the user for passwords');
  });

  it('status → init → play smoke → build → check, then the packaged build, a window for the human and ci init', async () => {
    const before = await call('gameshipper_status');
    expect([before.isError, before.result.data.config]).toEqual([false, null]);
    expect(before.result.warnings[0].code).toBe('CONFIG_MISSING');

    const init = await call('gameshipper_init', { name: 'Spinning Cube' });
    expect(init.result.errors).toEqual([]);
    expect(init.result.data.config.icon).toBe('icon.png');

    const smoke = await call('gameshipper_play', { smoke: true, seconds: 3 });
    expect(smoke.result.errors).toEqual([]);
    expect(smoke.isError).toBe(false);
    expect(readEvents(smoke.result.data.smoke.eventsLog).map((e) => e.message)).toContain(BRIDGE_OK);

    const progress: string[] = [];
    const build = await call('gameshipper_build', { target: [HOST_TARGET] }, (p) => void progress.push(p.message ?? ''));
    expect(build.result.errors).toEqual([]);
    const output = build.result.data.targets.find((t: { target: string }) => t.target === HOST_TARGET).output;
    expect(fs.existsSync(output.executable)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);

    // check runs this computer's build offline at Steam Deck size. The game passes; the release isn't ready (only one
    // OS built, no store images or screenshots), so the call is a tool error carrying the whole report.
    const check = await call('gameshipper_check', { seconds: 5 });
    expect(check.isError).toBe(true);
    expect(check.result.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['CHECK_BUILD_MISSING', 'CHECK_STORE_IMAGES', 'CHECK_SCREENSHOTS']));
    expect(check.result.data.launched.target).toBe(HOST_TARGET);
    const statuses = Object.fromEntries(check.result.data.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    // A check that didn't pass says why in its message.
    const said = check.result.data.checks.map((c: { id: string; status: string; message?: string }) => `${c.id} ${c.status}: ${c.message ?? ''}`).join('\n');
    expect(statuses, said).toMatchObject({ 'offline.requests': 'pass', 'launch.run': 'pass', 'launch.errors': 'pass', 'launch.frame': 'pass', 'launch.exit': 'pass' });

    const packaged = await call('gameshipper_play', { packaged: true, smoke: true, seconds: 3 });
    expect(packaged.result.errors).toEqual([]);
    expect(packaged.result.data.appDir).toBe(path.join(dir, 'out', HOST_TARGET));
    expect(readEvents(packaged.result.data.smoke.eventsLog).map((e) => e.message)).toContain(BRIDGE_OK);

    // Without smoke, play opens the window for a human and returns while the game keeps running.
    const human = await call('gameshipper_play', { packaged: true });
    expect(human.result.errors).toEqual([]);
    const pid: number = human.result.data.pid;
    expect(alive(pid)).toBe(true);
    process.kill(pid);

    const ci = await call('gameshipper_ci_init');
    expect(ci.result.errors).toEqual([]);
    expect(fs.readFileSync(path.join(dir, '.github', 'workflows', 'gameshipper.yml'), 'utf8')).toContain('play --packaged --smoke');

    const after = await call('gameshipper_status');
    expect(Object.keys(after.result.data.lastRuns).sort()).toEqual(['build', 'check', 'ci', 'init', 'play']);
  });

  it('publish never prompts: a missing Steam login is a tool error that says what the human runs', async () => {
    const p = fakeProject({ steam: { appId: 1234560, user: 'builder' } });
    const r = await call('gameshipper_publish', { dir: p.dir, dryRun: true });
    expect(r.isError).toBe(true);
    expect(r.result.errors[0]).toMatchObject({ code: 'STEAM_LOGIN_REQUIRED', fix: expect.stringContaining('npx gameshipper publish --to steam --dry-run --steam-user builder') });
  });

  it('returns failures as tool errors with their fix, and rejects inputs a command does not take', async () => {
    const missing = await call('gameshipper_build', { dir: makeTmpDir('gs-mcp-empty-') });
    expect(missing.isError).toBe(true);
    expect(missing.result.errors[0]).toMatchObject({ code: 'CONFIG_MISSING', fix: expect.stringContaining('init') });
    const bad = await client.callTool({ name: 'gameshipper_build', arguments: { target: ['xbox'] } });
    expect(bad.isError).toBe(true);
  });

  it('exits by itself as soon as the client closes its stdin', async () => {
    const pid = transport.pid!;
    const started = Date.now();
    await client.close();
    // The SDK waits 2 s for the server to exit on its own before it sends SIGTERM.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(alive(pid)).toBe(false);
  });
});
