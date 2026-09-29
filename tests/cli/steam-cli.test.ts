import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

async function run(argv: string[]): Promise<{ code: number; json: () => any }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY: false };
  const code = await main(argv, io);
  return { code, json: () => JSON.parse(out) };
}

describe('--steam-sdk', () => {
  it('is listed for build and play only', async () => {
    const help = (await run(['help', '--json'])).json().data.commands as Array<{ name: string; flags: Array<{ name: string }> }>;
    expect(help.filter((c) => c.flags.some((f) => f.name === 'steam-sdk')).map((c) => c.name)).toEqual(['play', 'build']);
    const status = await run(['status', '--steam-sdk', 'x.zip', '--json']);
    expect([status.code, status.json().errors[0].message]).toEqual([2, "status doesn't take --steam-sdk."]);
  });

  it('a path that is not an SDK is an input error (exit 2), resolved from the current folder', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
    for (const command of ['build', 'play']) {
      const r = await run([command, '--json', '--dir', dir, '--steam-sdk', 'nope.zip']);
      expect([r.code, r.json().errors[0].code]).toEqual([2, 'STEAM_SDK_INVALID']);
      expect(r.json().errors[0].message).toContain(path.resolve('nope.zip'));
    }
  });
});
