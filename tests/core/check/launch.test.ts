import { describe, expect, it } from 'vitest';
import { launchChecks, type LaunchEvidence } from '../../../src/core/check/launch.js';
import type { CheckResult } from '../../../src/core/check/types.js';
import { fail, gsError, ok } from '../../../src/core/result.js';
import type { SmokeData } from '../../../src/core/smoke.js';
import type { LayoutProbe, ProbeReport } from '../../../src/shell/probe.js';

const goodLayout: LayoutProbe = {
  viewport: { width: 1280, height: 800 },
  scroll: { width: 1280, height: 800 },
  overflowHidden: { x: true, y: true },
  offscreen: [],
  textInputs: 0,
};

function smokeData(probe: Partial<ProbeReport> = {}, exitCode: number | null = 0): SmokeData {
  return {
    summary: {
      droppedInfo: 0,
      truncatedEvents: 0,
      events: [],
      probe: { viewport: { width: 1280, height: 800 }, frame: '/p/.gameshipper/check/frame.png', layout: goodLayout, counters: { getGamepads: 0, gamepadListeners: 0 }, errors: [], ...probe },
    },
    eventsLog: '/p/.gameshipper/logs/events.jsonl',
    exitCode,
  };
}

function evidence(extra: Partial<LaunchEvidence> = {}): LaunchEvidence {
  return {
    host: 'mac',
    hostTargeted: true,
    launched: 'out/mac/G.app/Contents/MacOS/G',
    seconds: 15,
    smoke: ok(smokeData()),
    launchError: null,
    blocked: [],
    frame: { width: 1280, height: 800, blank: false, color: '#202020', plain: false, main: { share: 0.4, color: '#000000' } },
    scan: { gamepad: [], textInputs: [], skipped: [] },
    closed: null,
    otherBuilt: ['windows', 'linux'],
    ...extra,
  };
}

const byId = (checks: CheckResult[]) => Object.fromEntries(checks.map((c) => [c.id, c]));
const statuses = (checks: CheckResult[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe('launchChecks', () => {
  it('a clean run passes, with gamepad support flagged and other OSes noted', () => {
    const checks = launchChecks(evidence());
    expect(checks.map((c) => c.id)).toEqual([
      'offline.requests',
      'launch.run',
      'launch.errors',
      'launch.frame',
      'launch.exit',
      'launch.other-os',
      'deck.layout',
      'deck.gamepad',
      'deck.text-input',
    ]);
    expect(statuses(checks)).toEqual({
      'offline.requests': 'pass',
      'launch.run': 'pass',
      'launch.errors': 'pass',
      'launch.frame': 'pass',
      'launch.exit': 'pass',
      'launch.other-os': 'info',
      'deck.layout': 'pass',
      'deck.gamepad': 'warn',
      'deck.text-input': 'pass',
    });
    expect(byId(checks)['launch.other-os'].message).toContain('windows, linux: built, not launched on this computer');
    expect(byId(checks)['deck.gamepad'].code).toBe('CHECK_NO_GAMEPAD');
  });

  it('cuts each blocked address short, so a huge URL keeps the report small', () => {
    const huge = `https://example.com/track?data=${'x'.repeat(1_500_000)}`;
    const c = byId(launchChecks(evidence({ blocked: [huge, `${huge}y`, 'https://example.com/a'] })))['offline.requests'];
    expect(c.details).toEqual([`${huge.slice(0, 300)}…`, 'https://example.com/a']);
    expect(c.message).toBe(`With the network blocked, the game tried to load 2 internet addresses, starting with ${huge.slice(0, 300)}….`);
  });

  it('lists every blocked internet address once, at most 10 of them', () => {
    const c = byId(launchChecks(evidence({ blocked: ['https://example.com/scores.json', 'https://example.com/scores.json', 'wss://example.com/live'] })))['offline.requests'];
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_OFFLINE', details: ['https://example.com/scores.json', 'wss://example.com/live'] });
    const many = byId(launchChecks(evidence({ blocked: Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`) })))['offline.requests'];
    expect(many.message).toContain('25 internet addresses');
    expect(many.details).toHaveLength(11);
    expect(many.details![10]).toBe('…and 15 more');
  });

  it('reports crashes, runtime errors, blank frames and a game that would not quit', () => {
    const smoke = fail(
      [gsError('GAME_CONSOLE_ERROR', 'boom (main.js:1)'), gsError('GAME_CRASHED', 'The game process crashed (oom).', 'Run play.'), gsError('PLUGIN_LOAD_FAILED', 'Plugin p failed')],
      [gsError('GAME_USES_INTERNET', 'x')],
      smokeData({}, 3),
    );
    const checks = byId(launchChecks(evidence({ smoke, frame: { width: 1280, height: 800, blank: true, color: '#000000' } })));
    expect(checks['launch.run']).toMatchObject({ status: 'fail', code: 'CHECK_LAUNCH_FAILED', message: 'The game process crashed (oom).', fix: 'Run play.' });
    expect(checks['launch.errors']).toMatchObject({
      status: 'warn',
      code: 'CHECK_GAME_ERRORS',
      details: ['GAME_CONSOLE_ERROR: boom (main.js:1)', 'PLUGIN_LOAD_FAILED: Plugin p failed'],
    });
    expect(checks['launch.frame']).toMatchObject({ status: 'fail', code: 'CHECK_BLANK_FRAME' });
    expect(checks['launch.frame'].message).toContain('#000000');
    // Each code lists 10 issues, then one counting the rest: the total counts those too.
    const noisy = fail(
      [...Array.from({ length: 10 }, (_, i) => gsError('GAME_CONSOLE_ERROR', `boom ${i}`)), gsError('GAME_CONSOLE_ERROR', '…and 25 more like this (see the events log)', 'Every one is listed in the events log.')],
      [],
      smokeData(),
    );
    expect(byId(launchChecks(evidence({ smoke: noisy })))['launch.errors'].message).toBe('35 problems while the game ran, starting with: boom 0');
    expect(checks['launch.exit']).toMatchObject({ status: 'fail', code: 'CHECK_EXIT_CODE', message: 'The game was still running 10 s after its window was closed.' });
    const killed = byId(launchChecks(evidence({ smoke: ok(smokeData({}, null)) })))['launch.exit'];
    expect(killed.message).toBe('The game had to be killed instead of exiting when its window closed.');
  });

  it('does not judge the exit when the run ended before the window was closed', () => {
    const data = smokeData();
    delete data.summary.probe;
    const checks = byId(launchChecks(evidence({ smoke: ok(data), frame: null })));
    expect(checks['launch.exit']).toMatchObject({ status: 'skip', message: 'Not checked: the run ended before Gameshipper closed the window (see launch.run).' });
    expect(checks['launch.frame']).toMatchObject({ status: 'fail', code: 'CHECK_BLANK_FRAME' });
    expect(checks['deck.layout'].status).toBe('skip');
  });

  it('says the frame shows something, and warns when it is mostly one colour', () => {
    expect(byId(launchChecks(evidence()))['launch.frame']).toMatchObject({ status: 'pass', message: 'The game drew a non-uniform frame (1280x800 frame saved).' });
    const plain = byId(launchChecks(evidence({ frame: { width: 1280, height: 800, blank: false, color: '#050505', plain: true, main: { share: 0.998, color: '#000000' } } })));
    expect(plain['launch.frame']).toMatchObject({
      status: 'warn',
      code: 'CHECK_MOSTLY_BLANK_FRAME',
      message: "The frame is mostly one colour (99% #000000); check the game isn't stuck on a loading screen.",
    });
    expect(plain['launch.frame'].fix).toContain('/p/.gameshipper/check/frame.png');
  });

  it('fails launch.frame when the frame could not be captured, saying why', () => {
    const c = byId(launchChecks(evidence({ frame: null, smoke: ok(smokeData({ frame: null, errors: ['capturing the frame: timed out after 5 s'] })) })))['launch.frame'];
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_BLANK_FRAME', message: "Couldn't capture the game's window (capturing the frame: timed out after 5 s)." });
  });

  it('reports the real run time of a game that closed its own window', () => {
    const data = smokeData();
    delete data.summary.probe;
    const checks = byId(launchChecks(evidence({ smoke: ok(data), frame: null, closed: { seconds: 2.4 } })));
    expect(checks['offline.requests'].message).toBe('No internet requests in 2.4 s with the network blocked.');
    expect(checks['launch.run']).toMatchObject({ status: 'pass', message: 'Launched out/mac/G.app/Contents/MacOS/G; it closed its own window after 2.4 s.' });
    expect(checks['launch.frame']).toMatchObject({ status: 'fail', message: "Couldn't capture the game's window: the game closed its window after 2.4 s." });
    expect(checks['launch.exit']).toMatchObject({
      status: 'skip',
      message: 'Not checked: the game closed its own window after 2.4 s (exit code 0), before Gameshipper could close it like a player.',
    });
    expect(checks['deck.layout']).toMatchObject({ status: 'skip', message: "Couldn't measure the page: the game closed its window after 2.4 s." });
    const early = byId(launchChecks(evidence({ smoke: ok(data), frame: null, closed: { seconds: null } })));
    expect(early['launch.frame'].message).toBe("Couldn't capture the game's window: the game closed its window before its page loaded.");
  });

  it("skips deck.layout when the page couldn't be laid out at 1280x800", () => {
    const layout = { ...goodLayout, viewport: { width: 1600, height: 900 } };
    const c = byId(launchChecks(evidence({ smoke: ok(smokeData({ layout, viewport: null, errors: ["Couldn't lay the page out at 1280x800: timed out"] })) })))['deck.layout'];
    expect(c).toMatchObject({
      status: 'skip',
      message: "Not checked: the page size couldn't be fixed (it was 1600x900; Couldn't lay the page out at 1280x800: timed out).",
    });
  });

  it('warns about scrollbars and cut-off elements at 1280x800', () => {
    const layout: LayoutProbe = {
      ...goodLayout,
      scroll: { width: 1487, height: 820 },
      overflowHidden: { x: false, y: false },
      offscreen: [{ element: 'div#hud', text: 'Score: 0', rect: [900, 20, 1487, 57], cut: 'box' }],
    };
    const c = byId(launchChecks(evidence({ smoke: ok(smokeData({ layout })) })))['deck.layout'];
    expect(c).toMatchObject({ status: 'warn', code: 'CHECK_DECK_LAYOUT' });
    expect(c.message).toBe('At 1280x800, the page is 1487x820, so it scrolls and shows scrollbars and 1 element is cut off at the screen edge.');
    expect(c.details).toEqual(['page 1487x820 in a 1280x800 screen', 'div#hud "Score: 0" spans x 900..1487, y 20..57']);
    expect(c.fix).toMatch(/^Size the game to the window/);
    expect(c.fix).toContain('/p/.gameshipper/check/frame.png');
  });

  it('warns about text running off the screen, leading its fix with that', () => {
    const layout: LayoutProbe = {
      ...goodLayout,
      offscreen: [
        { element: 'div#hud', text: 'Score: 000000 · Lives: 3', rect: [940, 20, 1712, 57], cut: 'text' },
        { element: 'canvas', text: '', rect: [8, 8, 1288, 808], cut: 'box' },
      ],
    };
    const c = byId(launchChecks(evidence({ smoke: ok(smokeData({ layout })) })))['deck.layout'];
    expect(c.message).toBe('At 1280x800, text in 1 element runs past the screen edge and 1 element is cut off at the screen edge.');
    expect(c.details).toEqual(['div#hud "Score: 000000 · Lives: 3": its text spans x 940..1712, y 20..57', 'canvas spans x 8..1288, y 8..808']);
    expect(c.fix).toMatch(/^Keep text inside the screen/);
  });

  it('ignores a few pixels of overflow when the page hides it', () => {
    const layout = { ...goodLayout, scroll: { width: 1280, height: 804 } };
    expect(byId(launchChecks(evidence({ smoke: ok(smokeData({ layout })) })))['deck.layout'].status).toBe('pass');
  });

  it('counts gamepad use at runtime or in code, and lists text fields', () => {
    const runtime = byId(launchChecks(evidence({ smoke: ok(smokeData({ counters: { getGamepads: 42, gamepadListeners: 1 } })) })));
    expect(runtime['deck.gamepad']).toMatchObject({ status: 'pass', message: 'The game used the gamepad API 43 times while running.' });
    const inCode = byId(launchChecks(evidence({ scan: { gamepad: ['js/input.js'], textInputs: ['js/menu.js'], skipped: [] } })));
    expect(inCode['deck.gamepad'].status).toBe('pass');
    expect(inCode['deck.text-input'].message).toContain('in js/menu.js');
  });

  it("explains that engine and library code isn't searched for gamepad use", () => {
    const c = byId(launchChecks(evidence({ scan: { gamepad: [], textInputs: [], skipped: ['lib/phaser.js', 'assets/three-Bq3x.js'] } })))['deck.gamepad'];
    expect(c.status).toBe('warn');
    expect(c.details).toEqual([
      "Only the game's own code was searched. Engine and library code mentions gamepads whether or not the game uses them, so bundled CDN files, node_modules, *.min.js files, files over 1 MB and files named after an engine (phaser, three, babylon, pixi) were skipped.",
      'Skipped: lib/phaser.js, assets/three-Bq3x.js',
    ]);
  });

  it('when nothing could be launched, says why once and skips the rest', () => {
    const notBuilt = launchChecks(evidence({ smoke: null, launched: null }));
    expect(statuses(notBuilt)).toMatchObject({ 'launch.run': 'fail', 'offline.requests': 'skip', 'deck.layout': 'skip' });
    expect(byId(notBuilt)['launch.run']).toMatchObject({ code: 'CHECK_NOT_LAUNCHED', fix: 'Run `npx gameshipper build --target mac`, then check again.' });
    const notTargeted = byId(launchChecks(evidence({ smoke: null, launched: null, hostTargeted: false })));
    expect(notTargeted['launch.run']).toMatchObject({ status: 'warn', code: 'CHECK_NOT_LAUNCHED' });
    const noResult = byId(launchChecks(evidence({ smoke: null, launchError: gsError('SMOKE_NO_RESULT', "The game didn't report back (exit code 1).", 'Run play.') })));
    expect(noResult['launch.run']).toMatchObject({ status: 'fail', code: 'CHECK_LAUNCH_FAILED', fix: 'Run play.' });
    expect(byId(launchChecks(evidence({ host: null, smoke: null })))['launch.run'].status).toBe('skip');
  });
});
