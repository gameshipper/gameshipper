import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSmoke, summaryToIssues } from '../../src/core/smoke.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir } from '../helpers/tmp.js';

describe('summaryToIssues for Steam and plugins', () => {
  it('Steam not running is a warning; Steam failing to start is an error', () => {
    const notRunning = summaryToIssues({ droppedInfo: 0, events: [{ kind: 'steam', state: 'not-running', appId: 480, overlay: 'none', message: null }] });
    expect(notRunning.errors).toEqual([]);
    expect(notRunning.warnings.map((w) => w.code)).toEqual(['STEAM_NOT_RUNNING']);

    const failed = summaryToIssues({ droppedInfo: 0, events: [{ kind: 'steam', state: 'init-failed', appId: 1234560, overlay: 'none', message: 'SteamAPI_Init() failed' }] });
    expect(failed.errors).toEqual([expect.objectContaining({ code: 'STEAM_INIT_FAILED', message: expect.stringContaining('App ID 1234560: SteamAPI_Init() failed') })]);
    expect(failed.errors[0].fix).toContain('owns App ID 1234560');
    expect(failed.errors[0].fix).toContain("Steam bridge couldn't load");
  });

  it('a ready Steam, a build without the SDK and the overlay state are not problems', () => {
    const r = summaryToIssues({
      droppedInfo: 0,
      events: [
        { kind: 'steam', state: 'ready', appId: 480, overlay: 'native', message: null },
        { kind: 'steam', state: 'no-sdk', appId: 480, overlay: 'none', message: null },
        { kind: 'steam-overlay', enabled: false },
      ],
    });
    expect([r.errors, r.warnings]).toEqual([[], []]);
  });

  it('a plugin that fails to load in the game is an error', () => {
    const r = summaryToIssues({ droppedInfo: 0, events: [{ kind: 'plugin-error', plugin: 'echo', message: 'Unexpected token' }] });
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([['PLUGIN_LOAD_FAILED', 'Plugin echo failed to load in the game: Unexpected token']]);
  });
});

describe('runSmoke', () => {
  it("passes extra environment variables to the game, but never Gameshipper's own or ELECTRON_RUN_AS_NODE", async () => {
    const dir = makeTmpDir();
    const game = path.join(dir, 'fake-game.cjs');
    const names = ['EXTRA', 'GAMESHIPPER_LOG', 'GAMESHIPPER_USER_DATA', 'GAMESHIPPER_WINDOWED', 'GAMESHIPPER_SMOKE_SECONDS', 'ELECTRON_RUN_AS_NODE'];
    const events = `${JSON.stringify(names)}.map((n) => ({ kind: 'console', level: 'info', message: n + '=' + process.env[n], source: '', line: 0 }))`;
    fs.writeFileSync(game, `require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: ${events} }));`);
    const env = { EXTRA: 'from-test', GAMESHIPPER_LOG: '/elsewhere.jsonl', GAMESHIPPER_USER_DATA: '/elsewhere', GAMESHIPPER_WINDOWED: '', GAMESHIPPER_SMOKE_SECONDS: '99', ELECTRON_RUN_AS_NODE: '1' };
    const userDataDir = path.join(dir, 'data');
    const r = await runSmoke(testCtx(dir), { command: process.execPath, args: [game], seconds: 1, userDataDir, windowed: true, env });
    const seen = Object.fromEntries(r.data!.summary.events.map((e) => (e.kind === 'console' ? e.message.split('=') : [])));
    expect(seen).toEqual({
      EXTRA: 'from-test',
      GAMESHIPPER_LOG: r.data!.eventsLog,
      GAMESHIPPER_USER_DATA: userDataDir,
      GAMESHIPPER_WINDOWED: '1',
      GAMESHIPPER_SMOKE_SECONDS: '1',
      ELECTRON_RUN_AS_NODE: 'undefined',
    });
  });
});
