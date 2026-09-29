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
    frame: { width: 1280, height: 800, blank: false, color: '#202020' },
    scan: { gamepad: [], textInputs: [] },
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

  it('fails launch.frame when the frame could not be captured, saying why', () => {
    const c = byId(launchChecks(evidence({ frame: null, smoke: ok(smokeData({ frame: null, errors: ['capturing the frame: timed out after 5 s'] })) })))['launch.frame'];
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_BLANK_FRAME', message: "Couldn't capture the game's window (capturing the frame: timed out after 5 s)." });
  });

  it('warns about scrollbars and cut-off elements at 1280x800', () => {
    const layout: LayoutProbe = {
      ...goodLayout,
      scroll: { width: 1487, height: 820 },
      overflowHidden: { x: false, y: false },
      offscreen: [{ element: 'div#hud', text: 'Score: 0', rect: [900, 20, 1487, 57] }],
    };
    const c = byId(launchChecks(evidence({ smoke: ok(smokeData({ layout })) })))['deck.layout'];
    expect(c).toMatchObject({ status: 'warn', code: 'CHECK_DECK_LAYOUT' });
    expect(c.message).toBe('At 1280x800, the page is 1487x820, so it scrolls and shows scrollbars and 1 element is cut off at the screen edge.');
    expect(c.details).toEqual(['page 1487x820 in a 1280x800 screen', 'div#hud "Score: 0" spans x 900..1487, y 20..57']);
    expect(c.fix).toContain('/p/.gameshipper/check/frame.png');
  });

  it('ignores a few pixels of overflow when the page hides it', () => {
    const layout = { ...goodLayout, scroll: { width: 1280, height: 804 } };
    expect(byId(launchChecks(evidence({ smoke: ok(smokeData({ layout })) })))['deck.layout'].status).toBe('pass');
  });

  it('counts gamepad use at runtime or in code, and lists text fields', () => {
    const runtime = byId(launchChecks(evidence({ smoke: ok(smokeData({ counters: { getGamepads: 42, gamepadListeners: 1 } })) })));
    expect(runtime['deck.gamepad']).toMatchObject({ status: 'pass', message: 'The game used the gamepad API 43 times while running.' });
    const inCode = byId(launchChecks(evidence({ scan: { gamepad: ['js/input.js'], textInputs: ['js/menu.js'] } })));
    expect(inCode['deck.gamepad'].status).toBe('pass');
    expect(inCode['deck.text-input'].message).toContain('in js/menu.js');
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
