import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import { playSummary } from '../../src/cli/summaries.js';
import { parseConfig } from '../../src/core/config/load.js';
import { parseScreenshotTimes, runPlay, screenshotRunSeconds } from '../../src/core/play.js';
import { fail, gsError, ok } from '../../src/core/result.js';
import { noticeLine } from '../../src/shell/capture.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const config = parseConfig({ name: 'x', version: '1.0.0' }).data!;

function project(fakeMain: string): { dir: string; shellDir: string } {
  const dir = makeTmpDir();
  const shellDir = makeTmpDir();
  writeFiles(dir, { 'index.html': '<html></html>' });
  writeFiles(shellDir, { 'main.js': fakeMain });
  return { dir, shellDir };
}

/** A fake shell (Node stands in for Electron) that records `saves` screenshots the way the real one does: in the events log. */
const fakeShell = (saves: number, smoke: boolean) => `
  const fs = require('fs');
  const env = process.env;
  const log = (event) => fs.appendFileSync(env.GAMESHIPPER_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\\n');
  for (let i = 1; i <= ${saves}; i++) log({ kind: 'screenshot', file: env.GAMESHIPPER_SCREENSHOT_DIR + '/shot-' + i + '.png', width: 1920, height: 1080 });
  if (${smoke}) fs.writeFileSync(env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [] }));
`;

describe('screenshot times', () => {
  it('parseScreenshotTimes accepts 1-20 positive seconds up to 600', () => {
    expect(parseScreenshotTimes('5,10, 15')).toEqual([5, 10, 15]);
    expect(parseScreenshotTimes('2.5')).toEqual([2.5]);
    expect(parseScreenshotTimes('600')).toEqual([600]);
    for (const bad of ['', 'abc', '5,,10', '0', '-1', '601', '600.5', '5,1e9', 'Infinity', Array.from({ length: 21 }, () => '1').join(',')]) {
      expect(parseScreenshotTimes(bad), bad).toBeNull();
    }
  });

  it('a screenshot run lasts until 2 s after the last one, or longer with --seconds', () => {
    expect(screenshotRunSeconds([1, 2.5])).toBe(4.5);
    expect(screenshotRunSeconds([1, 2.5], 10)).toBe(10);
  });
});

describe('runPlay screenshots', () => {
  it('--screenshot runs at 1920x1080, asks the shell for each capture and returns the files', async () => {
    const { dir, shellDir } = project(fakeShell(2, true));
    const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath, screenshotAt: [1, 2.5] });
    expect(r.errors).toEqual([]);
    const shots = path.join(dir, 'out', 'store', 'screenshots');
    expect(r.data!.screenshots).toEqual([`${shots}/shot-1.png`, `${shots}/shot-2.png`]);
    expect(playSummary(r, { smoke: true })).toEqual(['✓ The game ran with no errors.', `Events: ${r.data!.smoke!.eventsLog}`, `Saved 2 screenshots (1920x1080) in ${shots}`]);
  });

  it('passes the capture settings to the shell', async () => {
    const { dir, shellDir } = project(`
      const env = process.env;
      const message = [env.GAMESHIPPER_SCREENSHOT_DIR, env.GAMESHIPPER_SCREENSHOT_AT, env.GAMESHIPPER_VIEWPORT, env.GAMESHIPPER_SMOKE_SECONDS].join('|');
      require('fs').writeFileSync(env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: [{ kind: 'console', level: 'info', message, source: '', line: 0 }] }));
    `);
    const shots = path.join(dir, 'out', 'store', 'screenshots');
    const run = async (opts: { screenshotAt?: number[]; smokeSeconds?: number }) => {
      const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath, ...opts });
      const first = r.data!.smoke!.summary.events[0];
      return first.kind === 'console' ? first.message : '';
    };
    expect(await run({ screenshotAt: [1, 2.5] })).toBe(`${shots}|1,2.5|1920x1080|4.5`);
    // A plain smoke run keeps F12 but has no fixed size or set times.
    expect(await run({ smokeSeconds: 3 })).toBe(`${shots}|||3`);
  });

  it('SCREENSHOT_FAILED when fewer screenshots were saved than asked for', async () => {
    const { dir, shellDir } = project(fakeShell(1, true));
    const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath, screenshotAt: [1, 2] });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([['SCREENSHOT_FAILED', 'Saved 1 of the 2 screenshots asked for.']]);
    expect(r.data!.screenshots).toHaveLength(1);
    const none = project(fakeShell(0, true));
    const one = await runPlay(testCtx(none.dir), config, { shellDir: none.shellDir, electronPath: process.execPath, screenshotAt: [1] });
    expect(one.errors.map((e) => e.message)).toEqual(['Saved 0 of the 1 screenshot asked for.']);
  });

  it('interactive play enables F12 and lists what it saved once the game closes', async () => {
    const { dir, shellDir } = project(fakeShell(1, false));
    const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath });
    expect(r.ok).toBe(true);
    const shots = path.join(dir, 'out', 'store', 'screenshots');
    expect(r.data!.screenshots).toEqual([`${shots}/shot-1.png`]);
    expect(playSummary(r, { smoke: false })).toEqual(['Game closed.', `Events: ${r.data!.eventsLog}`, `Saved 1 screenshot (1920x1080) in ${shots}`]);
    expect(playSummary(ok({ appDir: '/a', eventsLog: '/e.jsonl', screenshots: [] }), { smoke: false })).toEqual(['Game closed.', 'Events: /e.jsonl']);
  });

  it('lists the screenshots even when the game then quit with an error', () => {
    const r = fail(gsError('GAME_EXITED', 'The game quit unexpectedly (exit code 1).'), [], { appDir: '/a', eventsLog: '/e.jsonl', screenshots: ['/p/shots/1.png'] });
    expect(playSummary(r, { smoke: false })).toEqual(['Saved 1 screenshot (1920x1080) in /p/shots']);
  });

  it('passes on what the shell tells the person playing, like a failed F12 screenshot', async () => {
    const { dir, shellDir } = project(`process.stderr.write(${JSON.stringify(`some GPU chatter\n${noticeLine("Couldn't save the screenshot: no frame")}`)});`);
    const notices: string[] = [];
    const r = await runPlay(testCtx(dir), config, { shellDir, electronPath: process.execPath, onNotice: (m) => notices.push(m) });
    expect(r.ok).toBe(true);
    expect(notices).toEqual(["Couldn't save the screenshot: no frame"]);
  });
});

describe('play --screenshot in the CLI', () => {
  async function run(argv: string[]): Promise<{ code: number; out: string }> {
    let out = '';
    const io: CliIO = { write: (t) => void (out += t), stdinIsTTY: false };
    return { code: await main(argv, io), out };
  }

  it('rejects bad times with USAGE (exit 2)', async () => {
    const r = await run(['play', '--screenshot', 'soon', '--json', '--dir', makeTmpDir()]);
    expect([r.code, JSON.parse(r.out).errors[0].code]).toEqual([2, 'USAGE']);
  });

  it('says how long the run lasts and how many screenshots it saves', async () => {
    const dir = makeTmpDir();
    // --frozen-lock with an unrecorded CDN file stops the run before any game starts.
    writeFiles(dir, { 'index.html': '<script src="http://127.0.0.1:9/lib.js"></script>', 'gameshipper.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
    const r = await run(['play', '--screenshot', '3,6', '--frozen-lock', '--dir', dir]);
    expect(r.out.split('\n')[0]).toBe('Running the game for 8 seconds to save 2 screenshots…');
  });
});
