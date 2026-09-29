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
  it('passes extra environment variables to the game', async () => {
    const dir = makeTmpDir();
    const game = path.join(dir, 'fake-game.cjs');
    const events = "[{ kind: 'console', level: 'info', message: process.env.EXTRA, source: '', line: 0 }]";
    fs.writeFileSync(game, `require('fs').writeFileSync(process.env.GAMESHIPPER_SMOKE_OUT, JSON.stringify({ droppedInfo: 0, events: ${events} }));`);
    const r = await runSmoke(testCtx(dir), { command: process.execPath, args: [game], seconds: 1, userDataDir: path.join(dir, 'data'), windowed: true, env: { EXTRA: 'from-test' } });
    expect(r.data!.summary.events[0]).toMatchObject({ message: 'from-test' });
  });
});
