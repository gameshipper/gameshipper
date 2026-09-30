import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initProject } from '../../src/core/config/init.js';
import { parseConfig } from '../../src/core/config/load.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const base = { name: 'Moon Game', version: '1.0.0' };

describe('publish settings in gameshipper.json', () => {
  it('default to null', () => {
    const c = parseConfig(base).data!;
    expect([c.steam.user, c.github.repo]).toEqual([null, null]);
  });

  it('accept a Steam account name and a GitHub owner/repo', () => {
    const c = parseConfig({ ...base, steam: { appId: 1234560, user: 'moon_builder' }, github: { repo: 'moonstudio/moon-game.js' } }).data!;
    expect([c.steam.user, c.github.repo]).toEqual(['moon_builder', 'moonstudio/moon-game.js']);
  });

  it('reject values that are not names', () => {
    const r = parseConfig({ ...base, steam: { user: 'moon builder' }, github: { repo: 'moon-game' } });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => [e.code, e.message.split(':')[0]])).toEqual([
      ['CONFIG_INVALID', 'gameshipper.json → steam.user'],
      ['CONFIG_INVALID', 'gameshipper.json → github.repo'],
    ]);
  });

  it(". and .. aren't a GitHub owner or repository name", () => {
    for (const repo of ['./moon-game', '../moon-game', 'moonstudio/.', 'moonstudio/..']) {
      expect(parseConfig({ ...base, github: { repo } }).ok, repo).toBe(false);
    }
    for (const repo of ['moonstudio/.github', 'moonstudio/moon..game', 'moonstudio/...']) {
      expect(parseConfig({ ...base, github: { repo } }).ok, repo).toBe(true);
    }
  });

  it('init writes them, empty, so they are easy to find', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '<html></html>' });
    expect(initProject(dir, { name: 'Moon Game' }).ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'gameshipper.json'), 'utf8'));
    expect(written.steam.user).toBeNull();
    expect(written.github).toEqual({ repo: null });
  });
});
