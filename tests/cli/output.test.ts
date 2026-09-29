import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { COMMANDS, commandHelpText, helpData, helpText } from '../../src/cli/help.js';
import { exitCodeFor, renderHuman, renderJson } from '../../src/cli/output.js';
import { createPrompter } from '../../src/cli/prompt.js';
import { buildSummary, playSummary } from '../../src/cli/summaries.js';
import { fail, gsError, ok } from '../../src/core/result.js';

describe('exitCodeFor', () => {
  it('0 on success, 2 for usage/config/input problems, 1 otherwise', () => {
    expect(exitCodeFor(ok(1))).toBe(0);
    expect(exitCodeFor(fail(gsError('INPUT_REQUIRED', 'x')))).toBe(2);
    expect(exitCodeFor(fail(gsError('CONFIG_INVALID', 'x')))).toBe(2);
    expect(exitCodeFor(fail(gsError('PACKAGE_FAILED', 'x')))).toBe(1);
  });

  it('treats a missing folder, an unlocked or changed CDN file and a missing bundle ID as input problems', () => {
    for (const code of ['CDN_NOT_LOCKED', 'CDN_CHANGED', 'DIR_MISSING', 'BUNDLE_ID_REQUIRED']) {
      expect(exitCodeFor(fail(gsError(code, 'x')))).toBe(2);
    }
  });

  it('treats a bad icon or game folder as a config fix', () => {
    for (const code of ['ICON_TOO_SMALL', 'ICON_NOT_SQUARE', 'ICON_INVALID', 'GAME_DIR_MISSING', 'GAME_DIR_INVALID']) {
      expect(exitCodeFor(fail(gsError(code, 'x')))).toBe(2);
    }
  });

  it('treats unusable store art as a config fix', () => {
    for (const code of ['KEYART_INVALID', 'KEYART_TOO_SMALL', 'LOGO_INVALID', 'LOGO_NOT_TRANSPARENT']) {
      expect(exitCodeFor(fail(gsError(code, 'x')))).toBe(2);
    }
    expect(exitCodeFor(fail(gsError('STORE_IMAGE_FAILED', 'x')))).toBe(1);
  });

  it('treats a game that quit or misbehaved as a failure', () => {
    for (const code of ['GAME_EXITED', 'GAME_CONSOLE_ERROR', 'GAME_CRASHED', 'GAME_LOAD_FAILED', 'SMOKE_NO_RESULT', 'INTERNAL_ERROR']) {
      expect(exitCodeFor(fail(gsError(code, 'x')))).toBe(1);
    }
  });
});

describe('render', () => {
  const result = { ...fail(gsError('CDN_FETCH_FAILED', 'no network', 'check wifi'), [gsError('ICON_MISSING', 'no icon')]), logPath: '/l.log' };
  it('human output lists errors with fixes, then warnings, then the log path', () => {
    expect(renderHuman(result, ['Header'])).toBe(
      ['Header', '✗ CDN_FETCH_FAILED: no network', '    → check wifi', '! ICON_MISSING: no icon', 'Log: /l.log'].join('\n'),
    );
  });
  it('JSON output is the Result itself', () => {
    expect(JSON.parse(renderJson(result))).toMatchObject({ ok: false, errors: [{ code: 'CDN_FETCH_FAILED' }], logPath: '/l.log' });
  });
});

describe('createPrompter', () => {
  it('returns the fallback without reading when not interactive', async () => {
    expect(await createPrompter(false).ask('Name', 'Moon')).toBe('Moon');
  });
  it('reads an answer when interactive, falling back on empty input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = createPrompter(true, input, output);
    const answer = p.ask('Name', 'Moon');
    input.write('Sun\n');
    expect(await answer).toBe('Sun');
    const empty = p.ask('Name', 'Moon');
    input.write('\n');
    expect(await empty).toBe('Moon');
  });
});

describe('help', () => {
  it('lists every command with its flags, for humans and agents', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['init', 'play', 'build', 'status']);
    const data = helpData();
    expect(data.globalFlags.map((f) => f.name)).toEqual(['json', 'verbose', 'yes', 'dir', 'help', 'version']);
    expect(data.exitCodes).toEqual({ '0': 'success', '1': 'a target or check failed', '2': 'invalid config, usage or missing input' });
    expect(helpText()).toContain('npx gameshipper play --smoke');
  });

  it('shows the short forms of flags', () => {
    const text = helpText();
    expect(text).toMatch(/^ {2}-y, --yes +Never prompt/m);
    expect(text).toMatch(/^ {2}-h, --help +Show help/m);
    expect(text).toMatch(/^ {2}-v, --version +Print the Gameshipper version/m);
    expect(text).toMatch(/^ {6}--json +Print the result as JSON/m);
  });

  it('describes every gameshipper.json field as JSON Schema', () => {
    const schema = helpData().configSchema as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['name', 'version', 'game', 'icon', 'targets', 'window', 'steam', 'mobile', 'itch', 'plugins']),
    );
    // Input shape: fields with defaults are optional.
    expect(schema.required).toEqual(['name', 'version']);
  });

  it('offers --frozen-lock on build and play only', () => {
    const withFrozen = COMMANDS.filter((c) => c.flags.some((f) => f.name === 'frozen-lock')).map((c) => c.name);
    expect(withFrozen).toEqual(['play', 'build']);
    const build = COMMANDS.find((c) => c.name === 'build')!;
    expect(commandHelpText(build)).toContain('--frozen-lock');
    expect(commandHelpText(build)).toContain('Fail instead of accepting changed or new CDN files; for CI');
  });
});

describe('buildSummary', () => {
  it('shows one line per target', () => {
    const r = ok({
      outDir: '/p/out',
      targets: [
        { target: 'windows' as const, status: 'built' as const, output: { target: 'windows' as const, dir: '/p/out/windows', executable: '/p/out/windows/G.exe', warnings: [] }, errors: [], warnings: [] },
        { target: 'mac' as const, status: 'failed' as const, errors: [gsError('MAC_BUILD_HOST', 'x')], warnings: [] },
        { target: 'ios' as const, status: 'skipped' as const, errors: [], warnings: [] },
      ],
    });
    expect(buildSummary(r, '/p')).toEqual([
      '✓ windows  out/windows/G.exe',
      '✗ mac      failed (MAC_BUILD_HOST)',
      '- ios      skipped',
      '',
      'Next: `npx gameshipper play --smoke` checks the game runs cleanly.',
    ]);
  });

  it('shows the store images after the desktop targets', () => {
    const targets = [
      { target: 'linux' as const, status: 'built' as const, output: { target: 'linux' as const, dir: '/p/out/linux', executable: '/p/out/linux/g', warnings: [] }, errors: [], warnings: [] },
    ];
    const store = (status: 'built' | 'skipped' | 'failed') => ({
      status,
      dir: '/p/out/store',
      images: status === 'built' ? Array.from({ length: 8 }, () => ({ id: 'library-hero' as const, file: 'f', width: 1, height: 1 })) : [],
      errors: status === 'failed' ? [gsError('KEYART_TOO_SMALL', 'x')] : [],
      warnings: [],
    });
    const lines = (status: 'built' | 'skipped' | 'failed') => buildSummary(ok({ outDir: '/p/out', targets, store: store(status) }), '/p').slice(0, 2);
    expect(lines('built')).toEqual(['✓ linux    out/linux/g', '✓ store    out/store/ (8 images)']);
    expect(lines('skipped')[1]).toBe('- store    skipped (set keyArt and logo)');
    expect(lines('failed')[1]).toBe('✗ store    failed (KEYART_TOO_SMALL)');
  });

  it('is empty when the build never got as far as targets', () => {
    expect(buildSummary(fail(gsError('ENTRY_MISSING', 'x')), '/p')).toEqual([]);
  });
});

describe('playSummary', () => {
  it('a normal close says so, and the log path follows', () => {
    const r = { ...ok({ appDir: '/p/app', eventsLog: '/p/events.jsonl' }), logPath: '/p/play.log' };
    const text = renderHuman(r, playSummary(r, { smoke: false }));
    expect(text.split('\n')[0]).toBe('Game closed.');
    expect(text).toContain('Log: /p/play.log');
  });

  it('a game that quit shows the error and its fix, not "Game closed"', () => {
    const r = {
      ...fail(gsError('GAME_EXITED', 'The game quit unexpectedly (exit code 3).', 'Its full output is in /p/play.log.'), [], {
        appDir: '/p/app',
        eventsLog: '/p/events.jsonl',
      }),
      logPath: '/p/play.log',
    };
    const text = renderHuman(r, playSummary(r, { smoke: false }));
    expect(text).not.toContain('Game closed');
    expect(text).toContain('✗ GAME_EXITED: The game quit unexpectedly (exit code 3).\n    → Its full output is in /p/play.log.');
  });

  it('a game that never started gets no summary line', () => {
    expect(playSummary(fail(gsError('ENTRY_MISSING', 'x')), { smoke: false })).toEqual([]);
  });

  it('smoke runs report problems and where the events are', () => {
    const smoke = { summary: { events: [], droppedInfo: 0 }, eventsLog: '/p/events.jsonl', exitCode: 0 };
    expect(playSummary(ok({ appDir: '/p/app', smoke }), { smoke: true })).toEqual(['✓ The game ran with no errors.', 'Events: /p/events.jsonl']);
    const bad = fail([gsError('GAME_CONSOLE_ERROR', 'x'), gsError('GAME_FILE_MISSING', 'y')], [], { appDir: '/p/app', smoke });
    expect(playSummary(bad, { smoke: true })).toEqual(['✗ Found 2 problems while the game ran.', 'Events: /p/events.jsonl']);
    const one = fail(gsError('GAME_CONSOLE_ERROR', 'x'), [], { appDir: '/p/app', smoke });
    expect(playSummary(one, { smoke: true })[0]).toBe('✗ Found 1 problem while the game ran.');
    // Each code lists 10 problems, then one entry counting the rest: those count as the problems they stand for.
    const many = fail(
      [
        ...Array.from({ length: 10 }, (_, i) => gsError('GAME_CONSOLE_ERROR', `error ${i}`)),
        gsError('GAME_CONSOLE_ERROR', '…and 2990 more like this (see the events log)', 'Every one is listed in /p/events.jsonl.'),
        gsError('GAME_FILE_MISSING', 'y'),
        gsError('SMOKE_TIMEOUT', 'z'),
      ],
      [],
      { appDir: '/p/app', smoke },
    );
    expect(playSummary(many, { smoke: true })[0]).toBe('✗ Found 3002 problems while the game ran.');
    // The game never reported back: the errors say why, and there is nothing to summarize.
    expect(playSummary(fail(gsError('SMOKE_NO_RESULT', 'x'), [], { appDir: '/p/app' }), { smoke: true })).toEqual([]);
  });
});
