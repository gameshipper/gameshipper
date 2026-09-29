import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkStartLine, main, type CliIO } from '../../src/cli/main.js';
import { checkSummary } from '../../src/cli/summaries.js';
import { findBuilds } from '../../src/core/check/review.js';
import { hostTarget } from '../../src/core/check/run.js';
import type { CheckReport } from '../../src/core/check/types.js';
import { parseConfig } from '../../src/core/config/load.js';
import { fail, gsError } from '../../src/core/result.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

async function run(argv: string[]): Promise<{ code: number; out: string; json: () => any }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY: false };
  const code = await main(argv, io);
  return { code, out, json: () => JSON.parse(out) };
}

describe('gameshipper check', () => {
  it('is in the help catalog with its one flag', async () => {
    const r = await run(['help', '--json']);
    const check = r.json().data.commands.find((c: { name: string }) => c.name === 'check');
    expect(check.flags.map((f: { name: string }) => f.name)).toEqual(['seconds']);
    expect((await run(['check', '--target', 'linux', '--json'])).json().errors[0]).toMatchObject({ code: 'USAGE', message: "check doesn't take --target." });
  });

  it('rejects a bad --seconds, and more than 600', async () => {
    const r = await run(['check', '--seconds', '0', '--json', '--dir', makeTmpDir()]);
    expect([r.code, r.json().errors[0].code]).toEqual([2, 'USAGE']);
    const long = await run(['check', '--seconds', '601', '--json', '--dir', makeTmpDir()]);
    expect([long.code, long.json().errors[0].code, long.json().errors[0].message]).toEqual([2, 'USAGE', '--seconds must be a positive number of at most 600.']);
    const play = await run(['play', '--seconds', '601', '--json', '--dir', makeTmpDir()]);
    expect([play.code, play.json().errors[0].code]).toEqual([2, 'USAGE']);
  });

  it('exits 1 with one error per failed check when nothing is built, with a run log and a last-run record', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0', targets: ['windows', 'linux'] }) });
    const r = await run(['check', '--json', '--dir', dir]);
    expect(r.code).toBe(1);
    const json = r.json();
    expect(json.errors.map((e: { code: string }) => e.code)).toContain('CHECK_BUILD_MISSING');
    expect(json.data.checks.find((c: { id: string }) => c.id === 'review.builds').details).toEqual(['out/windows', 'out/linux']);
    expect(json.logPath).toMatch(/check-.+\.log$/);
    expect(fs.readFileSync(json.logPath, 'utf8')).toMatch(/check failed: /);
    expect(JSON.parse(readText(dir, '.gameshipper/last/check.json'))).toMatchObject({ command: 'check', ok: false });
    expect(fs.existsSync(path.join(dir, '.gameshipper', 'check', 'report.json'))).toBe(true);
  });

  it('tells a person what it is doing, then one line per check', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0', targets: ['linux'] }) });
    const r = await run(['check', '--seconds', '3', '--dir', dir]);
    const lines = r.out.split('\n');
    // Nothing is built, so nothing runs.
    expect(lines[0]).toBe('Checking the game…');
    expect(lines).toContain('✗ review.builds       No build for linux. Steam\'s review launches every OS the store page lists.');
  });

  it('says how long the build runs when there is one for this computer', () => {
    const dir = makeTmpDir();
    const config = parseConfig({ name: 'x', version: '1.0.0', targets: ['windows', 'mac', 'linux'] }).data!;
    const built = findBuilds(dir, config).find((b) => b.target === hostTarget(process.platform))!;
    expect(checkStartLine(dir, config, 3)).toBe('Checking the game…');
    writeFiles(dir, { [path.relative(dir, built.executable).split(path.sep).join('/')]: '' });
    expect(checkStartLine(dir, config, 3)).toBe('Checking the game; the build for this computer runs for 3 seconds with the network blocked…');
  });
});

describe('checkSummary', () => {
  it('prints one line per check, the totals and where to look', () => {
    const report: CheckReport = {
      host: 'mac',
      launched: null,
      checks: [
        { id: 'offline.requests', group: 'offline', title: 'Runs without internet', status: 'pass', message: 'No internet requests.' },
        { id: 'review.mac-signing', group: 'review', title: 'Mac', status: 'fail', code: 'CHECK_MAC_NOT_NOTARIZED', message: 'Not notarized.', fix: 'Sign it.' },
        { id: 'store.trailer', group: 'store', title: 'Trailer', status: 'info', message: 'Make a trailer.' },
      ],
      counts: { pass: 1, warn: 0, fail: 1, info: 1, skip: 0 },
      deckScreenshot: '/p/.gameshipper/check/frame.png',
      reportFile: '/p/.gameshipper/check/report.json',
    };
    expect(checkSummary(fail(gsError('CHECK_MAC_NOT_NOTARIZED', 'x'), [], report))).toEqual([
      '✓ offline.requests    No internet requests.',
      '✗ review.mac-signing  Not notarized.',
      'i store.trailer       Make a trailer.',
      '',
      '1 passed, 0 warnings, 1 failed, 1 note, 0 skipped.',
      'Steam Deck screenshot: /p/.gameshipper/check/frame.png',
      'Report: /p/.gameshipper/check/report.json',
    ]);
    expect(checkSummary(fail(gsError('CONFIG_MISSING', 'x')))).toEqual([]);
  });
});
