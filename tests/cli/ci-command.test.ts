import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import { exitCodeFor } from '../../src/cli/output.js';
import { fail, gsError } from '../../src/core/result.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

async function run(argv: string[]): Promise<{ code: number; out: string; json: () => any }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY: false };
  const code = await main(argv, io);
  return { code, out, json: () => JSON.parse(out) };
}

function game(): string {
  const dir = makeTmpDir();
  writeFiles(dir, { 'index.html': '', 'gameshipper.json': JSON.stringify({ name: 'Moon Game', version: '1.0.0' }) });
  return dir;
}

describe('gameshipper ci init', () => {
  it('writes the workflow and records the run, then refuses to overwrite it without --force', async () => {
    const dir = game();
    const first = await run(['ci', 'init', '--json', '--dir', dir]);
    expect([first.code, first.json().data.targets]).toEqual([0, ['windows', 'mac', 'linux']]);
    expect(fs.existsSync(path.join(dir, '.github', 'workflows', 'gameshipper.yml'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.gameshipper', 'last', 'ci.json'), 'utf8'))).toMatchObject({ command: 'ci', ok: true });
    const again = await run(['ci', 'init', '--json', '--dir', dir]);
    expect([again.code, again.json().errors[0].code]).toEqual([2, 'CI_WORKFLOW_EXISTS']);
    expect((await run(['ci', 'init', '--force', '--json', '--dir', dir])).code).toBe(0);
  });

  it('needs the init action', async () => {
    const bare = await run(['ci', '--json']);
    expect([bare.code, bare.json().errors[0].message, bare.json().errors[0].fix]).toEqual([2, 'ci needs an action: init.', 'Run `npx gameshipper ci init`.']);
    const typo = await run(['ci', 'setup', '--json']);
    expect([typo.code, typo.json().errors[0].message]).toEqual([2, 'Unknown ci action "setup".']);
    const extra = await run(['ci', 'init', 'now', '--json']);
    expect([extra.code, extra.json().errors[0].code]).toEqual([2, 'USAGE']);
    expect((await run(['ci', '--help'])).out).toContain('Usage: npx gameshipper ci init [--force]');
  });

  it('needs a config, like build', async () => {
    const dir = makeTmpDir();
    const r = await run(['ci', 'init', '--json', '--dir', dir]);
    expect([r.code, r.json().errors[0].code]).toEqual([2, 'CONFIG_MISSING']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('its errors are input problems (exit 2)', () => {
    for (const code of ['CI_WORKFLOW_EXISTS', 'CI_NO_DESKTOP_TARGETS']) expect(exitCodeFor(fail(gsError(code, 'x'))), code).toBe(2);
  });

  it('prints a summary for a person', async () => {
    const r = await run(['ci', 'init', '--dir', game()]);
    expect(r.out.split('\n')[0]).toBe('✓ Wrote .github/workflows/gameshipper.yml (builds windows, mac, linux)');
  });
});
