import { describe, expect, it } from 'vitest';
import { COMMANDS, type CommandHelp } from '../../src/cli/help.js';
import { camelCase, mcpTools } from '../../src/mcp/tools.js';

const byName = (name: string) => {
  const tool = mcpTools().find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

/** Plan 4's catalog entry for publish, which isn't implemented yet. */
const PUBLISH: CommandHelp = {
  name: 'publish',
  summary: 'Upload the builds in out/ to Steam, itch.io and GitHub Releases.',
  usage: 'npx gameshipper publish [--to steam,itch,github] [--dry-run] [--branch <name>] [--live]',
  flags: [
    { name: 'to', value: '<list>', description: 'Where to upload: steam, itch, github (default: every one configured).' },
    { name: 'dry-run', description: 'Check everything and preview the uploads; nothing is uploaded.' },
    { name: 'steam-user', value: '<account>', description: 'Steam account that uploads builds (default: steam.user).' },
    { name: 'live', description: 'GitHub: publish the release now instead of leaving a draft.' },
  ],
};

describe('mcpTools', () => {
  it('has one tool per CLI command and action, except mcp itself', () => {
    const names = mcpTools().map((t) => t.name);
    const expected = COMMANDS.filter((c) => c.name !== 'mcp').flatMap((c) => (c.actions ?? ['']).map((a) => `gameshipper_${c.name}${a ? `_${a}` : ''}`));
    expect(names).toEqual(expected);
    expect(names).toEqual(expect.arrayContaining(['gameshipper_init', 'gameshipper_play', 'gameshipper_build', 'gameshipper_check', 'gameshipper_status', 'gameshipper_ci_init']));
    expect(names).not.toContain('gameshipper_mcp');
  });

  it('turns a command added to the catalog later (publish) into a tool with no other change', () => {
    const [tool] = mcpTools([PUBLISH]);
    expect(tool.name).toBe('gameshipper_publish');
    expect(tool.description).toContain('STEAM_LOGIN_REQUIRED');
    expect(tool.inputSchema.parse({ to: ['steam'], dryRun: true })).toEqual({ to: ['steam'], dryRun: true });
    expect(tool.toArgs({ to: ['steam', 'itch'], dryRun: true, live: false })).toEqual(['publish', '--to=steam,itch', '--dry-run']);
  });

  it('types the inputs: numbers, target lists, screenshot times, booleans and text', () => {
    const init = byName('gameshipper_init');
    expect(init.inputSchema.safeParse({ appId: 1234567, name: 'Moon', bundleId: 'com.moon.game' }).success).toBe(true);
    expect(init.inputSchema.safeParse({ appId: '1234567' }).success).toBe(false);
    expect(init.inputSchema.safeParse({ app_id: 1 }).success).toBe(false);
    const build = byName('gameshipper_build');
    expect(build.inputSchema.safeParse({ target: ['mac', 'ios'] }).success).toBe(true);
    expect(build.inputSchema.safeParse({ target: ['xbox'] }).success).toBe(false);
    expect(byName('gameshipper_play').inputSchema.safeParse({ screenshot: [5, 10] }).success).toBe(true);
  });

  it('maps inputs back to CLI flags', () => {
    expect(byName('gameshipper_init').toArgs({ name: 'Moon Game', appId: 1234567, force: true, icon: undefined })).toEqual([
      'init',
      '--name=Moon Game',
      '--app-id=1234567',
      '--force',
    ]);
    expect(byName('gameshipper_build').toArgs({ target: ['windows', 'linux'], frozenLock: true })).toEqual(['build', '--target=windows,linux', '--frozen-lock']);
    expect(byName('gameshipper_ci_init').toArgs({ force: false })).toEqual(['ci', 'init']);
    expect(byName('gameshipper_check').toArgs({ seconds: 20 })).toEqual(['check', '--seconds=20']);
  });

  it('play opens a window for the human and returns at once, unless it is a timed run', () => {
    const play = byName('gameshipper_play');
    expect(Object.keys(play.inputSchema.shape)).not.toContain('detach');
    expect(play.toArgs({})).toEqual(['play', '--detach']);
    expect(play.toArgs({ packaged: true })).toEqual(['play', '--packaged', '--detach']);
    expect(play.toArgs({ smoke: true, seconds: 3 })).toEqual(['play', '--smoke', '--seconds=3']);
    expect(play.toArgs({ seconds: 3 })).not.toContain('--detach');
    expect(play.toArgs({ screenshot: [5, 10] })).toEqual(['play', '--screenshot=5,10']);
  });

  it('never has an input for a password, token or code', () => {
    for (const tool of [...mcpTools(), ...mcpTools([PUBLISH])]) {
      for (const key of Object.keys(tool.inputSchema.shape)) {
        expect(key, `${tool.name}.${key}`).not.toMatch(/pass|token|secret|otp|2fa|guard|credential/i);
      }
    }
  });

  it('describes the result shape and marks status read-only', () => {
    const status = byName('gameshipper_status');
    expect(status.readOnly).toBe(true);
    expect(status.description).toContain('{ ok, data, errors[], warnings[], logPath }');
    expect(mcpTools().filter((t) => t.readOnly).map((t) => t.name)).toEqual(['gameshipper_status']);
    expect(byName('gameshipper_build').inputSchema.shape.dir.description).toContain('relative');
  });

  it('camelCase', () => {
    expect(camelCase('app-id')).toBe('appId');
    expect(camelCase('build-command')).toBe('buildCommand');
    expect(camelCase('smoke')).toBe('smoke');
  });
});
