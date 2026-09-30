import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, GLOBAL_FLAGS } from '../../src/cli/help.js';
import { mcpTools } from '../../src/mcp/tools.js';
import { ROOT } from '../helpers/built-cli.js';

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const json = (rel: string): any => JSON.parse(read(rel));
const skill = read('plugin/skills/ship-web-game/SKILL.md');
const matches = (re: RegExp): string[] => [...new Set([...skill.matchAll(re)].map((m) => m[1]))];

/** Every TypeScript file under src/, so the skill can only name error codes the code really uses. */
function sourceText(): string {
  return fs
    .readdirSync(path.join(ROOT, 'src'), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');
}

describe('Claude Code plugin', () => {
  it('has the same version everywhere, and its MCP server runs that npm version', () => {
    const version = json('package.json').version;
    expect(json('plugin/.claude-plugin/plugin.json')).toMatchObject({ name: 'gameshipper', version });
    expect(json('.claude-plugin/marketplace.json').plugins).toEqual([expect.objectContaining({ name: 'gameshipper', version, source: './plugin' })]);
    expect(json('plugin/.mcp.json')).toEqual({ gameshipper: { command: 'npx', args: ['-y', `gameshipper@${version}`, 'mcp'] } });
  });

  it('is not part of the npm package', () => {
    expect(json('package.json').files).toEqual(['bin', 'dist', 'types']);
  });
});

describe('npm package', () => {
  it('is MIT licensed by the Gameshipper contributors, with the LICENSE file npm always packs', () => {
    expect(json('package.json').license).toBe('MIT');
    const license = read('LICENSE');
    expect(license.split('\n')[0]).toBe('MIT License');
    expect(license).toContain('Copyright (c) 2026 Gameshipper contributors');
  });

  it('names its repository, which npm trusted publishing and provenance check', () => {
    expect(json('package.json').repository).toEqual({ type: 'git', url: 'git+https://github.com/gameshipper/gameshipper.git' });
  });
});

describe('ship-web-game skill', () => {
  it('has frontmatter Claude Code can load', () => {
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
    expect(front?.[1]).toBe('ship-web-game');
    expect(front?.[2].startsWith('Use when')).toBe(true);
    expect(front![2].length).toBeLessThanOrEqual(1024);
  });

  it('only names commands the CLI has', () => {
    const known = COMMANDS.map((c) => c.name);
    for (const command of matches(/npx gameshipper ([a-z-]+)/g)) {
      if (command !== 'help') expect(known, `npx gameshipper ${command}`).toContain(command);
    }
  });

  it('only names flags the CLI has', () => {
    const known = new Set([...GLOBAL_FLAGS, ...COMMANDS.flatMap((c) => c.flags)].map((f) => f.name));
    for (const flag of matches(/(?<![\w-])--([a-z][a-z-]*)/g)) expect(known.has(flag), `--${flag}`).toBe(true);
  });

  it('names every MCP tool the server has, and no other', () => {
    const known = mcpTools().map((t) => t.name);
    const named = matches(/(?<!\w)(gameshipper_[a-z_]+)/g);
    for (const tool of named) expect(known, tool).toContain(tool);
    // A command added to the catalog (Plan 4's publish) makes this fail until the skill says how to use it.
    for (const tool of known) expect(named, `the skill doesn't mention ${tool}`).toContain(tool);
  });

  it('only names error codes the code really returns', () => {
    const src = sourceText();
    for (const code of matches(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) expect(src.includes(`'${code}'`), code).toBe(true);
  });
});
