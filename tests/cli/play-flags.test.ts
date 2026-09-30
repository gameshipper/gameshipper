import { describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import { playSummary } from '../../src/cli/summaries.js';
import { ok } from '../../src/core/result.js';
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

describe('play --packaged and --detach', () => {
  it('are documented flags of play', async () => {
    const help = (await run(['play', '--help'])).out;
    expect(help).toContain('--packaged');
    expect(help).toContain('--detach');
  });

  it('--detach cannot be combined with a timed run', async () => {
    for (const timed of [['--smoke'], ['--seconds', '3'], ['--screenshot', '5']]) {
      const r = await run(['play', ...timed, '--detach', '--json', '--dir', game()]);
      expect([r.code, r.json().errors[0].code, r.json().errors[0].message]).toEqual([2, 'USAGE', "--detach can't be combined with --smoke, --seconds or --screenshot."]);
    }
  });

  it('--packaged needs a build first (exit 2)', async () => {
    const r = await run(['play', '--packaged', '--smoke', '--json', '--dir', game()]);
    expect([r.code, r.json().errors[0].code]).toEqual([2, 'PACKAGED_BUILD_MISSING']);
    expect(r.json().logPath).toMatch(/play-.+\.log$/);
  });

  it('a detached game is reported as started, not closed', () => {
    const lines = playSummary(ok({ appDir: '/p/app', eventsLog: '/p/events.jsonl', pid: 4242 }), { smoke: false });
    expect(lines).toEqual(['Started the game (process 4242); it keeps running after this command exits.', 'Events: /p/events.jsonl']);
  });
});
