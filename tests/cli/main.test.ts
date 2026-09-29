import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { divertStdout, main, type CliIO } from '../../src/cli/main.js';
import type { Prompter } from '../../src/cli/prompt.js';
import { makeSolidPng } from '../helpers/png.js';
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
    expect(r.json().data.commands.map((c: { name: string }) => c.name)).toEqual(['init', 'play', 'build', 'check', 'status']);
  });

  it('help --json describes every gameshipper.json field', async () => {
    const schema = (await run(['help', '--json'])).json().data.configSchema;
    expect(Object.keys(schema.properties)).toContain('steam');
    expect(schema.properties.steam.properties.appId.type).toBe('integer');
  });

  it('help --json says when logPath and fix are there, and that --seconds implies --smoke', async () => {
    const data = (await run(['help', '--json'])).json().data;
    expect(data.resultShape).toContain('logPath (the run log) is present for build, play and check');
    expect(data.resultShape).toContain('fix may be absent on warnings');
    const play = data.commands.find((c: { name: string }) => c.name === 'play');
    expect(play.flags.find((f: { name: string }) => f.name === 'seconds').description).toContain('Implies --smoke.');
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

  it('the fix for a bad flag names the command that was run', async () => {
    const a = await run(['status', '--dir', 'build', '--bogus', '--json']);
    expect(a.json().errors[0].fix).toMatch(/^Flags for status: none besides the global flags\./);
    const b = await run(['--dir', 'play', 'build', '--bogus', '--json']);
    expect(b.json().errors[0].fix).toMatch(/^Flags for build: /);
    const c = await run(['--bogus', '--json']);
    expect(c.json().errors[0].fix).toBe('Run `npx gameshipper help` to see the commands and their flags.');
  });

  it('boolean flags accept =true and =false', async () => {
    const dir = makeTmpDir();
    const a = await run(['status', '--json=true', '--dir', dir]);
    expect([a.code, a.json().ok]).toEqual([0, true]);
    const b = await run(['status', '--json=false', '--dir', dir]);
    expect(b.out).toMatch(/^Gameshipper /);
    // Still JSON when parsing fails, so an agent can read the error.
    const c = await run(['status', '--json=true', '--verbose=maybe', '--dir', dir]);
    expect([c.code, c.json().errors[0].code]).toEqual([2, 'USAGE']);
  });

  it('--dir "" is a usage error, not the current folder', async () => {
    const r = await run(['status', '--json', '--dir', '']);
    expect([r.code, r.json().errors[0].code, r.json().errors[0].message]).toEqual([2, 'USAGE', '--dir needs a folder path.']);
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
    expect(ask.mock.calls.map((c) => c[0])).toEqual([
      'Game name',
      'Steam App ID (480 = Valve test app)',
      'Icon PNG, 1024x1024 ("none" to skip)',
      'Key art for the store images, PNG or JPEG, 3840x2160 ("none" to skip)',
      'Logo for the store images, PNG with a transparent background ("none" to skip)',
      'Bundle ID for the iOS and Android projects, like com.yourname.yourgame ("none" for desktop only)',
    ]);
    expect(ask.mock.calls[0][1]).toBe('Moon Game');
    expect(JSON.parse(readText(dir, 'gameshipper.json'))).toMatchObject({ name: 'Sun Game', icon: null, steam: { appId: 7654321 } });
    expect(r.out).toContain('✓ Wrote gameshipper.json for "Sun Game"');

    // The config exists now: say so straight away instead of asking questions first.
    ask.mockClear();
    const again = await run(['init', '--dir', dir], true, { ask });
    expect([again.code, ask.mock.calls.length]).toEqual([2, 0]);
    expect(again.out).toContain('CONFIG_EXISTS');
  });

  it('init at a terminal still warns about an icon that did not qualify when the person keeps the default', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'icon.png': makeSolidPng(512, 512) });
    const ask = vi.fn(async (_q: string, fallback: string) => fallback);
    const r = await run(['init', '--dir', dir], true, { ask });
    expect(r.code).toBe(0);
    expect(ask.mock.calls[2]).toEqual(['Icon PNG, 1024x1024 ("none" to skip)', 'none']);
    expect(JSON.parse(readText(dir, 'gameshipper.json')).icon).toBeNull();
    expect(r.out).toContain("! ICON_UNSUITABLE: icon.png is 512x512; Steam needs a square PNG of at least 1024x1024, so it wasn't used.");
  });

  it('init reports a wrong --entry or --icon straight away instead of asking questions first', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    const ask = vi.fn(async (_q: string, fallback: string) => fallback);
    const entry = await run(['init', '--dir', dir, '--entry', 'nope.html'], true, { ask });
    expect([entry.code, ask.mock.calls.length]).toEqual([2, 0]);
    expect(entry.out).toContain("✗ ENTRY_MISSING: Can't find nope.html.");
    const icon = await run(['init', '--dir', dir, '--icon', 'nope.png'], true, { ask });
    expect([icon.code, ask.mock.calls.length]).toEqual([2, 0]);
    expect(icon.out).toContain("✗ ASSET_MISSING: icon: nope.png doesn't exist.");
    expect(fs.existsSync(path.join(dir, 'gameshipper.json'))).toBe(false);
  });

  it('init --icon none writes no icon, even with one in the folder', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'icon.png': makeSolidPng(1024, 1024) });
    const r = await run(['init', '--json', '--dir', dir, '--icon', 'none']);
    expect([r.code, r.json().data.config.icon]).toEqual([0, null]);
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

  it('build, play and check without a valid config explain how to start, without writing into the folder', async () => {
    for (const command of ['build', 'play', 'check']) {
      const dir = makeTmpDir();
      writeFiles(dir, { 'index.html': '' });
      const r = await run([command, '--json', '--dir', dir]);
      expect([command, r.code, r.json().errors[0].code]).toEqual([command, 2, 'CONFIG_MISSING']);
      expect(r.json()).not.toHaveProperty('logPath');
      writeFiles(dir, { 'gameshipper.json': '{ "name": ' });
      const invalid = await run([command, '--json', '--dir', dir]);
      expect([invalid.code, invalid.json().errors[0].code]).toEqual([2, 'CONFIG_INVALID']);
      expect(invalid.json()).not.toHaveProperty('logPath');
      expect(fs.readdirSync(dir).sort()).toEqual(['gameshipper.json', 'index.html']);
    }
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
    for (const command of ['build', 'play', 'check']) {
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

  it('play --screenshot takes at most 20 times of at most 600 seconds (USAGE, exit 2)', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'gameshipper.json': CONFIG });
    for (const times of ['601', '5,700', '0', 'soon']) {
      const r = await run(['play', '--json', '--dir', dir, '--screenshot', times]);
      expect([times, r.code, r.json().errors[0].code], times).toEqual([times, 2, 'USAGE']);
      expect(r.json().errors[0].fix).toContain('each at most 600');
    }
    // Refused before anything runs: no run log, no .gameshipper folder.
    expect(fs.readdirSync(dir).sort()).toEqual(['gameshipper.json', 'index.html']);
  });

  it('says how long a smoke run lasts, in words', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<script src="http://127.0.0.1:9/lib.js"></script>', 'gameshipper.json': CONFIG });
    const r = await run(['play', '--smoke', '--seconds', '1', '--frozen-lock', '--dir', dir]);
    expect(r.out.split('\n')[0]).toBe('Running the game for 1 second to check it…');
    expect(r.out).toContain('✗ CDN_NOT_LOCKED');
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
    for (const command of ['init', 'play', 'build', 'check', 'status']) {
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
  it('prints one line for a person when there is no log yet', async () => {
    const dir = makeTmpDir();
    // The run log can't be created: .gameshipper is a file.
    writeFiles(dir, { '.gameshipper': '', 'gameshipper.json': CONFIG, 'index.html': '' });
    const r = await run(['build', '--dir', dir]);
    expect(r.code).toBe(1);
    expect(r.out.trimEnd().split('\n')).toEqual([expect.stringMatching(/^✗ INTERNAL_ERROR: Unexpected error: .+/)]);
  });
});

describe('recording the last run', () => {
  it('is best-effort: a run that finished keeps its result, with a LAST_RUN_NOT_SAVED warning', async () => {
    const dir = makeTmpDir();
    // .gameshipper/last is a file, so the record can't be written.
    writeFiles(dir, { 'index.html': '', '.gameshipper/last': '' });
    const init = await run(['init', '--yes', '--json', '--dir', dir]);
    expect([init.code, init.json().ok]).toEqual([0, true]);
    expect(init.json().warnings.map((w: { code: string }) => w.code)).toEqual(['STEAM_TEST_APP', 'LAST_RUN_NOT_SAVED']);
    fs.rmSync(path.join(dir, 'index.html'));
    const build = await run(['build', '--json', '--dir', dir]);
    expect([build.code, build.json().errors[0].code]).toEqual([2, 'ENTRY_MISSING']);
    expect(build.json().warnings.map((w: { code: string }) => w.code)).toEqual(['LAST_RUN_NOT_SAVED']);
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
