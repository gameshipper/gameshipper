import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GsError } from '../../src/core/result.js';
import { runSmoke } from '../../src/core/smoke.js';
import { cli, HOST_TARGET, readEvents, ROOT } from '../helpers/built-cli.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

/** What each smoke detector finds in a real Electron window, in `play --smoke` and in a packaged app. */

const codes = (issues: GsError[]) => issues.map((i) => i.code).sort();

/** fixtures/broken-game has one of each problem; each run must find exactly those. */
function checkBrokenGame(result: { errors: GsError[]; warnings: GsError[] }, run: string): void {
  expect(codes(result.errors), run).toEqual(['GAME_CONSOLE_ERROR', 'GAME_CONSOLE_ERROR', 'GAME_FILE_MISSING', 'GAME_FILE_MISSING']);
  expect(codes(result.warnings.filter((w) => w.code.startsWith('GAME_'))), run).toEqual([
    'GAME_NAVIGATION_BLOCKED',
    'GAME_PATH_CASE',
    'GAME_USES_INTERNET',
  ]);
  const messages = [...result.errors, ...result.warnings].map((i) => i.message);
  expect(messages, run).toEqual(
    expect.arrayContaining([
      "The game requested missing.png, which isn't in the build.",
      "The game requested Style.css, which isn't in the build.",
      'The game requested Style.css but the file is named style.css.',
      expect.stringMatching(/^The game loaded https:\/\/example\.com\/ from the internet/),
      expect.stringMatching(/^Uncaught Error: broken-game: uncaught error \(main\.js:\d+\)$/),
      expect.stringMatching(/^broken-game: something went wrong \(main\.js:\d+\)$/),
      'The game tried to leave its window for about:blank (blocked).',
    ]),
  );
}

describe('smoke detectors in real Electron', () => {
  it('play --smoke and the packaged app find every problem in fixtures/broken-game', async () => {
    const dir = makeTmpDir('gs-broken-');
    fs.cpSync(path.join(ROOT, 'fixtures', 'broken-game'), dir, { recursive: true });
    expect(cli(['init', '--yes', '--name', 'Broken Game'], dir).code).toBe(0);

    const play = cli(['play', '--smoke', '--seconds', '3'], dir);
    expect(play.code).toBe(1);
    checkBrokenGame(play.result, 'play --smoke');
    expect(codes(play.result.warnings).filter((c) => !c.startsWith('GAME_'))).toEqual(['ICON_MISSING']);

    // A game's own errors don't stop a build.
    const build = cli(['build', '--target', HOST_TARGET], dir);
    expect(build.result.errors).toEqual([]);
    const output = build.result.data.targets.find((t: { target: string }) => t.target === HOST_TARGET).output;
    const packaged = await runSmoke(testCtx(dir), {
      command: output.executable,
      args: [],
      seconds: 3,
      userDataDir: path.join(dir, '.gameshipper', 'int-data'),
      windowed: true,
    });
    checkBrokenGame(packaged, 'packaged app');
    expect(packaged.warnings.every((w) => w.code.startsWith('GAME_'))).toBe(true);

    // Kept when a check fails, for debugging.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("opens only the game's own links outside it: links from other frames are blocked", () => {
    const dir = makeTmpDir('gs-links-');
    writeFiles(dir, {
      'index.html': `<!DOCTYPE html><html><body><script>
        addEventListener('load', () => {
          window.open('https://example.com/new-window-from-game');
          setTimeout(() => { location.href = 'https://example.com/navigation-from-game'; }, 200);
          // A sandboxed frame has an origin of its own, like an embedded site or ad.
          setTimeout(() => {
            const frame = document.createElement('iframe');
            frame.sandbox = 'allow-scripts allow-popups';
            frame.srcdoc = "<script>window.open('https://example.com/new-window-from-frame')<\\/script>";
            document.body.append(frame);
          }, 400);
        });
      </script></body></html>`,
    });
    expect(cli(['init', '--yes', '--name', 'Links'], dir).code).toBe(0);
    const play = cli(['play', '--smoke', '--seconds', '2'], dir);
    expect(play.code).toBe(0);
    // Smoke runs never open anything; they record what normal play would do.
    const actions = readEvents(play.result.data.smoke.eventsLog)
      .filter((e) => e.kind === 'blocked-navigation')
      .map((e) => [e.url, e.action]);
    expect(actions).toEqual([
      ['https://example.com/new-window-from-game', 'opened-externally'],
      ['https://example.com/navigation-from-game', 'opened-externally'],
      ['https://example.com/new-window-from-frame', 'blocked'],
    ]);
    // The game's own links aren't problems; the frame's is.
    expect(play.result.errors).toEqual([]);
    expect(play.result.warnings.filter((w: GsError) => w.code.startsWith('GAME_'))).toEqual([
      expect.objectContaining({ code: 'GAME_NAVIGATION_BLOCKED', message: expect.stringContaining('new-window-from-frame') }),
    ]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
