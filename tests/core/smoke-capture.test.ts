import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLoggedEvents, runSmoke, summaryToIssues, truncateSummary } from '../../src/core/smoke.js';
import type { CaptureSettings } from '../../src/shell/capture.js';
import type { DiagEvent } from '../../src/shell/diagnostics.js';
import type { ProbeReport } from '../../src/shell/probe.js';
import { testCtx } from '../helpers/ctx.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const PROBE: ProbeReport = {
  viewport: { width: 1280, height: 800 },
  frame: '/p/.gameshipper/check/frame.png',
  layout: { viewport: { width: 1280, height: 800 }, scroll: { width: 1280, height: 800 }, overflowHidden: { x: true, y: true }, offscreen: [], textInputs: 0 },
  counters: { getGamepads: 3, gamepadListeners: 0 },
  errors: [],
};

describe('summaryToIssues for capture events', () => {
  it('a failed screenshot is a warning; saved screenshots, blocked requests and a closed window are not issues', () => {
    const events: DiagEvent[] = [
      { kind: 'screenshot', file: '/p/out/store/screenshots/a.png', width: 1920, height: 1080 },
      { kind: 'screenshot-failed', error: 'taking the screenshot timed out after 5 s' },
      { kind: 'blocked-request', url: 'wss://example.com/live' },
      { kind: 'window-closed', seconds: 2.5 },
    ];
    const { errors, warnings } = summaryToIssues({ droppedInfo: 0, events });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      {
        code: 'SCREENSHOT_FAILED',
        message: "A screenshot couldn't be saved: taking the screenshot timed out after 5 s",
        fix: 'Try again. If it keeps failing, run with --verbose and report the run log.',
      },
    ]);
  });
});

/** A fake game that reports the capture variables it got, and a probe when asked for one. */
const REPORTS_CAPTURE = `
  const env = process.env;
  const names = ['GAMESHIPPER_SCREENSHOT_DIR', 'GAMESHIPPER_SCREENSHOT_AT', 'GAMESHIPPER_VIEWPORT', 'GAMESHIPPER_OFFLINE', 'GAMESHIPPER_PROBE_DIR'];
  const message = names.map((n) => n + '=' + (env[n] ?? '-')).join(' ');
  const summary = { droppedInfo: 0, events: [{ kind: 'console', level: 'info', message, source: '', line: 0 }] };
  if (env.GAMESHIPPER_PROBE_DIR) summary.probe = ${JSON.stringify(PROBE)};
  require('fs').writeFileSync(env.GAMESHIPPER_SMOKE_OUT, JSON.stringify(summary));
`;

describe('runSmoke capture settings', () => {
  afterEach(() => {
    delete process.env.GAMESHIPPER_OFFLINE;
  });

  async function run(capture?: CaptureSettings) {
    const dir = makeTmpDir();
    writeFiles(dir, { 'game.js': REPORTS_CAPTURE });
    // Neither the extra environment nor the one Gameshipper runs in may set capture variables.
    process.env.GAMESHIPPER_OFFLINE = '1';
    const r = await runSmoke(testCtx(dir), {
      command: process.execPath,
      args: [path.join(dir, 'game.js')],
      seconds: 1,
      userDataDir: makeTmpDir(),
      windowed: true,
      env: { GAMESHIPPER_VIEWPORT: '10x10' },
      capture,
    });
    const first = r.data!.summary.events[0];
    return { r, reported: first.kind === 'console' ? first.message : '' };
  }

  it('passes them to the game as its GAMESHIPPER_* variables, and nothing else can', async () => {
    const none = await run();
    expect(none.reported).toBe('GAMESHIPPER_SCREENSHOT_DIR=- GAMESHIPPER_SCREENSHOT_AT=- GAMESHIPPER_VIEWPORT=- GAMESHIPPER_OFFLINE=- GAMESHIPPER_PROBE_DIR=-');
    const check = await run({ offline: true, viewport: { width: 1280, height: 800 }, probeDir: '/p/check' });
    expect(check.reported).toBe(
      'GAMESHIPPER_SCREENSHOT_DIR=- GAMESHIPPER_SCREENSHOT_AT=- GAMESHIPPER_VIEWPORT=1280x800 GAMESHIPPER_OFFLINE=1 GAMESHIPPER_PROBE_DIR=/p/check',
    );
  });

  it("keeps the shell's probe in the result", async () => {
    const { r } = await run({ probeDir: '/p/check' });
    expect(r.data!.summary.probe).toEqual(PROBE);
    expect(truncateSummary({ droppedInfo: 0, events: [], probe: PROBE }).probe).toEqual(PROBE);
    expect(truncateSummary({ droppedInfo: 0, events: [] })).toEqual({ events: [], droppedInfo: 0, truncatedEvents: 0 });
  });
});

describe('readLoggedEvents', () => {
  it('reads every event of the wanted kinds, well past the 100 a summary keeps', () => {
    const log = path.join(makeTmpDir(), 'events.jsonl');
    const line = (event: object) => `${JSON.stringify({ at: '2026-09-29T00:00:00.000Z', ...event })}\n`;
    let text = '';
    for (let i = 0; i < 150; i++) text += line({ kind: 'console', level: 'error', message: `"kind":"screenshot" ${i}`, source: '', line: 0 });
    text += line({ kind: 'screenshot', file: '/s/1.png', width: 1920, height: 1080 });
    text += line({ kind: 'screenshot-failed', error: 'x' });
    text += '{"at":"2026-09-29T00:00:01.000Z","kind":"screenshot","fi\n';
    text += line({ kind: 'blocked-request', url: 'https://example.com/a' });
    text += line({ kind: 'screenshot', file: '/s/2.png', width: 1920, height: 1080 });
    fs.writeFileSync(log, text);
    expect(readLoggedEvents(log, ['screenshot']).map((e) => e.file)).toEqual(['/s/1.png', '/s/2.png']);
    expect(readLoggedEvents(log, ['blocked-request', 'screenshot-failed']).map((e) => e.kind)).toEqual(['screenshot-failed', 'blocked-request']);
    expect(readLoggedEvents(path.join(makeTmpDir(), 'missing.jsonl'), ['screenshot'])).toEqual([]);
  });
});
