import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_IMAGES } from '../../../src/core/assets/sizes.js';
import type { MacSigning } from '../../../src/core/check/mac-signing.js';
import { hostTarget, runCheck } from '../../../src/core/check/run.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { ok } from '../../../src/core/result.js';
import type { runSmoke, SmokeOptions } from '../../../src/core/smoke.js';
import type { DiagEvent } from '../../../src/shell/diagnostics.js';
import type { ProbeReport } from '../../../src/shell/probe.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeQuadrantPng } from '../../helpers/images.js';
import { makeSolidPng } from '../../helpers/png.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

const config = parseConfig({ name: 'Moon Game', version: '1.0.0', icon: 'icon.png', keyArt: 'k.png', logo: 'l.png', steam: { appId: 1234567 } }).data!;
const adhoc: MacSigning = { kind: 'adhoc', authority: null, valid: true, stapled: false, detail: '' };

function readyProject(): string {
  const dir = makeTmpDir();
  writeFiles(dir, {
    'out/windows/Moon Game.exe': '',
    'out/linux/moon-game': '',
    'out/mac/Moon Game.app/Contents/MacOS/Moon Game': '',
    ...Object.fromEntries(STORE_IMAGES.map((s) => [`out/store/${s.file}`, makeSolidPng(s.width, s.height)])),
    ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`out/store/screenshots/${n}.png`, makeSolidPng(1920, 1080)])),
  });
  return dir;
}

/**
 * Stands in for the smoke run: what the shell would leave behind (frame.png, an events log) and report (the probe).
 * `logged` are events log lines.
 */
function fakeSmoke(
  seen: SmokeOptions[],
  opts: { frame?: boolean; logged?: object[] | null; events?: DiagEvent[]; probe?: Partial<ProbeReport> | null } = {},
): typeof runSmoke {
  return async (ctx, smokeOpts) => {
    seen.push(smokeOpts);
    const dir = smokeOpts.capture!.probeDir!;
    const frame = path.join(dir, 'frame.png');
    if (opts.frame !== false) fs.writeFileSync(frame, await makeQuadrantPng(1280, 800));
    const eventsLog = path.join(ctx.projectDir, 'events.jsonl');
    // null: an events log that can't be read.
    if (opts.logged !== null) fs.writeFileSync(eventsLog, (opts.logged ?? []).map((e) => `${JSON.stringify(e)}\n`).join(''));
    const probe: ProbeReport = {
      viewport: { width: 1280, height: 800 },
      frame: opts.frame === false ? null : frame,
      layout: { viewport: { width: 1280, height: 800 }, scroll: { width: 1280, height: 800 }, overflowHidden: { x: true, y: true }, offscreen: [], textInputs: 0 },
      counters: { getGamepads: 12, gamepadListeners: 0 },
      errors: [],
      ...opts.probe,
    };
    const summary = { droppedInfo: 0, truncatedEvents: 0, events: opts.events ?? [], ...(opts.probe === null ? {} : { probe }) };
    return ok({ eventsLog, exitCode: 0, summary });
  };
}

describe('hostTarget', () => {
  it('maps the OS to its desktop target', () => {
    expect([hostTarget('darwin'), hostTarget('win32'), hostTarget('linux'), hostTarget('freebsd')]).toEqual(['mac', 'windows', 'linux', null]);
  });
});

describe('runCheck', () => {
  it('launches the host build offline at Deck size and reports every check', async () => {
    const dir = readyProject();
    const seen: SmokeOptions[] = [];
    const r = await runCheck(testCtx(dir), config, { host: 'linux', seconds: 3, smoke: fakeSmoke(seen), macSigning: async () => adhoc });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      command: path.join(dir, 'out', 'linux', 'moon-game'),
      args: [],
      seconds: 3,
      windowed: true,
      userDataDir: path.join(dir, '.gameshipper', 'check', 'data'),
      capture: { offline: true, viewport: { width: 1280, height: 800 }, probeDir: path.join(dir, '.gameshipper', 'check') },
    });
    expect(Object.fromEntries(r.data!.checks.map((c) => [c.id, c.status]))).toEqual({
      'offline.requests': 'pass',
      'launch.run': 'pass',
      'launch.errors': 'pass',
      'launch.frame': 'pass',
      'launch.exit': 'pass',
      'launch.other-os': 'info',
      'deck.layout': 'pass',
      'deck.gamepad': 'pass',
      'deck.text-input': 'pass',
      'review.builds': 'pass',
      'review.steam-appid': 'pass',
      'review.mac-signing': 'warn',
      'review.icon': 'pass',
      'review.app-id': 'pass',
      'store.images': 'pass',
      'store.screenshots': 'pass',
      'store.trailer': 'info',
      'ai.disclosure': 'info',
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['CHECK_MAC_SIGNING_UNKNOWN']);
    expect(r.data!.counts).toEqual({ pass: 14, warn: 1, fail: 0, info: 3, skip: 0 });
    expect(r.data!.launched).toMatchObject({ target: 'linux', exitCode: 0, eventsLog: path.join(dir, 'events.jsonl') });
    expect(r.data!.deckScreenshot).toBe(path.join(dir, '.gameshipper', 'check', 'frame.png'));
    expect(JSON.parse(fs.readFileSync(r.data!.reportFile, 'utf8')).checks).toHaveLength(18);
  });

  it('reads every blocked request from the events log', async () => {
    const dir = readyProject();
    const logged = [
      ...Array.from({ length: 150 }, (_, i) => ({ kind: 'console', level: 'info', message: `tick ${i}`, source: '', line: 0 })),
      { kind: 'blocked-request', url: 'https://example.com/scores.json' },
    ];
    const r = await runCheck(testCtx(dir), config, { host: 'linux', smoke: fakeSmoke([], { logged }) });
    expect(r.data!.checks.find((c) => c.id === 'offline.requests')).toMatchObject({ status: 'fail', code: 'CHECK_OFFLINE', details: ['https://example.com/scores.json'] });
  });

  it('keeps report.json small when the game requested a huge URL', async () => {
    const dir = readyProject();
    const huge = `https://example.com/beacon?payload=${'x'.repeat(1_500_000)}`;
    const r = await runCheck(testCtx(dir), config, { host: 'linux', smoke: fakeSmoke([], { logged: [{ kind: 'blocked-request', url: huge }] }) });
    expect(r.data!.checks.find((c) => c.id === 'offline.requests')!.details).toEqual([`${huge.slice(0, 300)}…`]);
    expect(fs.statSync(r.data!.reportFile).size).toBeLessThan(50_000);
  });

  it("uses the summary's blocked and remote requests when the events log can't be read", async () => {
    const dir = readyProject();
    const events: DiagEvent[] = [
      { kind: 'blocked-request', url: 'wss://example.com/live' },
      { kind: 'remote-request', url: 'https://example.com/scores.json', status: null, error: 'net::ERR_BLOCKED_BY_CLIENT' },
    ];
    const r = await runCheck(testCtx(dir), config, { host: 'linux', smoke: fakeSmoke([], { logged: null, events }) });
    expect(r.data!.checks.find((c) => c.id === 'offline.requests')).toMatchObject({
      status: 'fail',
      details: ['wss://example.com/live', 'https://example.com/scores.json'],
    });
  });

  it('knows from the events log when the game closed its own window', async () => {
    const dir = readyProject();
    const logged = [{ kind: 'window-closed', seconds: 1.5 }];
    const r = await runCheck(testCtx(dir), config, { host: 'linux', smoke: fakeSmoke([], { logged, frame: false, probe: null }) });
    const byId = Object.fromEntries(r.data!.checks.map((c) => [c.id, c]));
    expect(byId['launch.frame'].message).toBe("Couldn't capture the game's window: the game closed its window after 1.5 s.");
    expect(byId['launch.exit'].status).toBe('skip');
  });

  it('checks Mac signing on a Mac, and fails a run with no frame', async () => {
    const dir = readyProject();
    const r = await runCheck(testCtx(dir), config, { host: 'darwin', smoke: fakeSmoke([], { frame: false }), macSigning: async () => adhoc });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['CHECK_BLANK_FRAME', 'CHECK_MAC_NOT_NOTARIZED']);
    expect(r.data!.deckScreenshot).toBeNull();
  });

  it('without builds, reports what is missing without launching anything', async () => {
    const dir = makeTmpDir();
    let launched = false;
    const smoke: typeof runSmoke = async () => {
      launched = true;
      throw new Error('should not launch');
    };
    const r = await runCheck(testCtx(dir), parseConfig({ name: 'x', version: '1.0.0', targets: ['linux'] }).data!, { host: 'linux', smoke });
    expect(launched).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['CHECK_NOT_LAUNCHED', 'CHECK_BUILD_MISSING', 'CHECK_STORE_IMAGES', 'CHECK_SCREENSHOTS']);
    expect(r.warnings.map((w) => w.code)).toEqual(['CHECK_DEFAULT_ICON', 'CHECK_TEST_APP_ID']);
  });
});
