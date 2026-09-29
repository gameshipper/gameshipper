import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { divertStdout, main, type CliIO } from '../../src/cli/main.js';
import type { Prompter } from '../../src/cli/prompt.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

async function run(
  argv: string[],
  stdinIsTTY = false,
  prompter?: Prompter,
): Promise<{ code: number; out: string; json: () => any }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY, prompter };
  const code = await main(argv, io);
  return { code, out, json: () => JSON.parse(out) };
}

const CONFIG = JSON.stringify({ name: 'x', version: '1.0.0' });

describe('gameshipper CLI', () => {
  it('help --json returns the catalog', async () => {
    const r = await run(['help', '--json']);
    expect(r.code).toBe(0);
    expect(r.json().data.commands.map((c: { name: string }) => c.name)).toEqual(['init', 'play', 'build', 'status']);
  });

  it('help --json describes every gameshipper.json field', async () => {
    const schema = (await run(['help', '--json'])).json().data.configSchema;
    expect(Object.keys(schema.properties)).toContain('steam');
    expect(schema.properties.steam.properties.appId.type).toBe('integer');
  });

  it('no arguments prints human help', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Commands:');
  });

  it('shows one command’s help with --help or `help <command>`', async () => {
    const a = await run(['build', '--help']);
    expect(a.code).toBe(0);
    expect(a.out).toContain('Usage: npx gameshipper build');
    expect(a.out).toContain('--frozen-lock');
    expect((await run(['help', 'play'])).out).toContain('--smoke');
    expect((await run(['build', '--help', '--json'])).json()).toMatchObject({ ok: true, data: { name: 'build' } });
  });

  it('unknown commands and flags are USAGE errors (exit 2)', async () => {
    const a = await run(['launch', '--json']);
    expect([a.code, a.json().errors[0].code]).toEqual([2, 'USAGE']);
    const b = await run(['build', '--bogus', '--json']);
    expect([b.code, b.json().errors[0].code]).toEqual([2, 'USAGE']);
    expect(b.json().errors[0]).toMatchObject({ message: 'Unknown flag --bogus.', fix: expect.stringContaining('--target') });
    const c = await run(['status', '--smoke', '--json']);
    expect([c.code, c.json().errors[0].message]).toEqual([2, "status doesn't take --smoke."]);
    const d = await run(['build', 'windows', '--json']);
    expect([d.code, d.json().errors[0].code]).toEqual([2, 'USAGE']);
    const e = await run(['status', '--frozen-lock', '--json']);
    expect([e.code, e.json().errors[0].message]).toEqual([2, "status doesn't take --frozen-lock."]);
  });

  it('flags may come before the command', async () => {
    const r = await run(['--json', 'status', '--dir', makeTmpDir()]);
    expect([r.code, r.json().ok]).toEqual([0, true]);
  });

  it('init --yes --json writes the config without prompting', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    const prompter: Prompter = { ask: vi.fn(async () => 'nope') };
    const r = await run(['init', '--yes', '--json', '--dir', dir, '--name', 'Moon', '--app-id', '1234567'], true, prompter);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, data: { config: { name: 'Moon', steam: { appId: 1234567 } } } });
    expect(fs.existsSync(path.join(dir, 'gameshipper.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.gameshipper', 'last', 'init.json'))).toBe(true);
    expect(prompter.ask).not.toHaveBeenCalled();
  });

  it('init asks a person at a terminal, and only when it can succeed', async () => {
    const dir = path.join(makeTmpDir(), 'moon-game');
    writeFiles(dir, { 'index.html': '' });
    const answers: Record<string, string> = { 'Game name': 'Sun Game', 'Steam App ID (480 = Valve test app)': '7654321' };
    const ask = vi.fn(async (q: string, fallback: string) => answers[q] ?? fallback);
    const r = await run(['init', '--dir', dir], true, { ask });
    expect(r.code).toBe(0);
    expect(ask.mock.calls.map((c) => c[0])).toEqual(['Game name', 'Steam App ID (480 = Valve test app)', 'Icon PNG, 1024x1024 ("none" to skip)']);
    expect(ask.mock.calls[0][1]).toBe('Moon Game');
    expect(JSON.parse(readText(dir, 'gameshipper.json'))).toMatchObject({ name: 'Sun Game', icon: null, steam: { appId: 7654321 } });
    expect(r.out).toContain('✓ Wrote gameshipper.json for "Sun Game"');

    // The config exists now: say so straight away instead of asking questions first.
    ask.mockClear();
    const again = await run(['init', '--dir', dir], true, { ask });
    expect([again.code, ask.mock.calls.length]).toEqual([2, 0]);
    expect(again.out).toContain('CONFIG_EXISTS');
  });

  it('init reports INPUT_REQUIRED instead of prompting when nothing is detectable', async () => {
    const r = await run(['init', '--json', '--dir', makeTmpDir()]);
    expect([r.code, r.json().errors[0].code]).toEqual([2, 'INPUT_REQUIRED']);
  });

  it('rejects a non-numeric --app-id', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    const r = await run(['init', '--json', '--dir', dir, '--app-id', 'abc']);
    expect([r.code, r.json().errors[0].code]).toEqual([2, 'USAGE']);
  });

  it('build without a config explains how to start', async () => {
    const r = await run(['build', '--json', '--dir', makeTmpDir()]);
    expect([r.code, r.json().errors[0].code]).toEqual([2, 'CONFIG_MISSING']);
    expect(r.json().logPath).toMatch(/build-.+\.log$/);
  });

  it('build --target rejects unknown targets', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'gameshipper.json': CONFIG });
    const r = await run(['build', '--json', '--dir', dir, '--target', 'windows,xbox']);
    expect([r.code, r.json().errors[0].message]).toEqual([2, 'Unknown target "xbox".']);
    const empty = await run(['build', '--json', '--dir', dir, '--target', ',']);
    expect([empty.code, empty.json().errors[0].code]).toEqual([2, 'USAGE']);
  });

  it('a config whose files are missing fails without passing the config off as a result', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'gameshipper.json': CONFIG });
    for (const command of ['build', 'play']) {
      const r = await run([command, '--json', '--dir', dir]);
      expect(r.code).toBe(2);
      const json = r.json();
      expect(json.errors[0].code).toBe('ENTRY_MISSING');
      expect(json).not.toHaveProperty('data');
      expect(json.logPath).toMatch(new RegExp(`${command}-.+\\.log$`));
    }
    const human = await run(['play', '--dir', dir]);
    expect(human.out).not.toContain('Game closed');
    expect(human.out).not.toContain('Starting');
    expect(human.out).toContain('✗ ENTRY_MISSING');
  });

  it('--frozen-lock reaches build and play: an unrecorded CDN file is an input error', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<script src="http://127.0.0.1:9/lib.js"></script>', 'gameshipper.json': CONFIG });
    for (const command of ['build', 'play']) {
      const r = await run([command, '--frozen-lock', '--json', '--dir', dir]);
      expect([r.code, r.json().errors[0].code]).toEqual([2, 'CDN_NOT_LOCKED']);
    }
  });

  it('every project command reports a missing --dir without creating anything', async () => {
    const parent = makeTmpDir();
    const missing = path.join(parent, 'nope');
    for (const command of ['init', 'play', 'build', 'status']) {
      const r = await run([command, '--json', '--dir', missing]);
      expect([command, r.code, r.json().errors[0].code]).toEqual([command, 2, 'DIR_MISSING']);
      expect(r.json().errors[0].fix).toBe('Check the path, or run the command from your game folder.');
    }
    writeFiles(parent, { 'file.txt': '' });
    const file = await run(['build', '--dir', path.join(parent, 'file.txt')]);
    expect([file.code, file.out]).toEqual([2, expect.stringContaining("isn't a folder")]);
    expect(fs.readdirSync(parent)).toEqual(['file.txt']);
  });

  it('status --json always succeeds', async () => {
    const r = await run(['status', '--json', '--dir', makeTmpDir()]);
    expect(r.code).toBe(0);
    expect(r.json().data.buildableHere.length).toBeGreaterThan(0);
  });

  it('--version prints the version', async () => {
    const r = await run(['--version']);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('safety net', () => {
  it('turns an unexpected failure into a JSON INTERNAL_ERROR with the log, which holds the stack', async () => {
    const dir = makeTmpDir();
    // Recording the last run fails: .gameshipper/last is a file.
    writeFiles(dir, { '.gameshipper/last': '' });
    const r = await run(['build', '--json', '--dir', dir]);
    expect(r.code).toBe(1);
    const json = r.json();
    expect(json).toMatchObject({ ok: false, errors: [{ code: 'INTERNAL_ERROR', fix: expect.stringContaining('report the log') }] });
    expect(json.logPath).toMatch(/build-.+\.log$/);
    expect(fs.readFileSync(json.logPath, 'utf8')).toMatch(/Error: .*\n\s+at /);
  });

  it('prints one line, plus the log path when there is one, for a person', async () => {
    const dir = makeTmpDir();
    // The run log can't be created: .gameshipper is a file.
    writeFiles(dir, { '.gameshipper': '' });
    const r = await run(['build', '--dir', dir]);
    expect(r.code).toBe(1);
    expect(r.out.trimEnd().split('\n')).toEqual([expect.stringMatching(/^✗ INTERNAL_ERROR: Unexpected error: .+/)]);

    const withLog = makeTmpDir();
    writeFiles(withLog, { '.gameshipper/last': '' });
    const lines = (await run(['build', '--dir', withLog])).out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Log: .+build-.+\.log$/);
  });
});

describe('divertStdout', () => {
  it('sends stray stdout writes to stderr until restored', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const original = process.stdout.write;
    const restore = divertStdout();
    try {
      process.stdout.write('stray\n');
      expect(stderr).toHaveBeenCalledWith('stray\n');
    } finally {
      restore();
      stderr.mockRestore();
    }
    expect(process.stdout.write).toBe(original);
  });
});
