import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

// An unexpected error after the run log exists: summing up the result throws.
vi.mock('../../src/cli/summaries.js', async (importOriginal) => {
  const fire = () => {
    throw new Error('disk on fire');
  };
  return { ...(await importOriginal<typeof import('../../src/cli/summaries.js')>()), buildSummary: fire, playSummary: fire };
});

/** A project whose config loads, so the run log exists, but whose game is missing, so nothing is built or launched. */
function project(): string {
  const dir = makeTmpDir();
  writeFiles(dir, { 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
  return dir;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY: false };
  return { code: await main(argv, io), out };
}

describe('safety net with a run log', () => {
  it('prints a JSON INTERNAL_ERROR with the log, which holds the stack, and records the run', async () => {
    const dir = project();
    const r = await run(['build', '--json', '--dir', dir]);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.out);
    expect(json).toMatchObject({
      ok: false,
      errors: [{ code: 'INTERNAL_ERROR', message: 'Unexpected error: disk on fire', fix: expect.stringContaining('report the log') }],
    });
    expect(json.logPath).toMatch(/build-.+\.log$/);
    expect(fs.readFileSync(json.logPath, 'utf8')).toMatch(/Error: disk on fire\n\s+at /);
    expect(JSON.parse(readText(dir, '.gameshipper/last/build.json'))).toMatchObject({ ok: false, errors: [{ code: 'INTERNAL_ERROR' }] });
  });

  it('prints one line plus the log path for a person', async () => {
    const lines = (await run(['play', '--dir', project()])).out.trimEnd().split('\n');
    expect(lines).toEqual([
      '✗ INTERNAL_ERROR: Unexpected error: disk on fire This is a Gameshipper bug. Re-run with --verbose and report the log.',
      expect.stringMatching(/^Log: .+play-.+\.log$/),
    ]);
  });
});
