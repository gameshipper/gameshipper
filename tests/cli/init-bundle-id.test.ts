import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import type { Prompter } from '../../src/cli/prompt.js';
import { initProject } from '../../src/core/config/init.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

async function run(argv: string[], stdinIsTTY = false, prompter?: Prompter): Promise<{ code: number; out: string; json: () => any }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY, prompter };
  const code = await main(argv, io);
  return { code, out, json: () => JSON.parse(out) };
}

function game(): string {
  const dir = makeTmpDir();
  writeFiles(dir, { 'index.html': '' });
  return dir;
}

describe('init --bundle-id', () => {
  it('sets mobile.bundleId and adds the ios and android targets', () => {
    const dir = game();
    const r = initProject(dir, { bundleId: 'com.jane.moon' });
    expect(r.data!.config.mobile).toEqual({ bundleId: 'com.jane.moon', orientation: 'landscape' });
    const written = JSON.parse(readText(dir, 'gameshipper.json'));
    expect(written.targets).toEqual(['windows', 'mac', 'linux', 'ios', 'android']);
    expect(written.mobile.bundleId).toBe('com.jane.moon');
  });

  it('without it, or with none, the project stays desktop only', () => {
    for (const bundleId of [undefined, null]) {
      const r = initProject(game(), { bundleId });
      expect([r.data!.config.targets, r.data!.config.mobile.bundleId]).toEqual([['windows', 'mac', 'linux'], null]);
    }
  });

  it('the flag works without prompting, and "none" leaves it unset', async () => {
    const dir = game();
    const r = await run(['init', '--json', '--dir', dir, '--bundle-id', 'com.jane.moon']);
    expect(r.code).toBe(0);
    expect(r.json().data.config).toMatchObject({ mobile: { bundleId: 'com.jane.moon' }, targets: ['windows', 'mac', 'linux', 'ios', 'android'] });
    const none = await run(['init', '--json', '--force', '--dir', dir, '--bundle-id', 'none']);
    expect(none.json().data.config).toMatchObject({ mobile: { bundleId: null }, targets: ['windows', 'mac', 'linux'] });
  });

  it('BUNDLE_ID_INVALID (exit 2) for an ID the stores reject, before asking anything', async () => {
    const ask = vi.fn(async (_q: string, fallback: string) => fallback);
    for (const id of ['my-game', 'com.example.new']) {
      const dir = game();
      const r = await run(['init', '--dir', dir, '--bundle-id', id], true, { ask });
      expect([r.code, ask.mock.calls.length]).toEqual([2, 0]);
      expect(r.out).toContain('BUNDLE_ID_INVALID');
      expect(r.out).toContain('--bundle-id');
      expect(fs.existsSync(path.join(dir, 'gameshipper.json'))).toBe(false);
    }
  });

  it('a person at a terminal is asked, and the summary says what it means', async () => {
    const dir = game();
    const ask = vi.fn(async (q: string, fallback: string) => (q.startsWith('Bundle ID') ? 'com.jane.moon' : fallback));
    const r = await run(['init', '--dir', dir], true, { ask });
    expect(r.code).toBe(0);
    expect(ask.mock.calls.at(-1)).toEqual(['Bundle ID for the iOS and Android projects, like com.yourname.yourgame ("none" for desktop only)', 'none']);
    expect(JSON.parse(readText(dir, 'gameshipper.json')).targets).toEqual(['windows', 'mac', 'linux', 'ios', 'android']);
    expect(r.out).toContain('  Mobile: com.jane.moon (the ios and android targets make Xcode and Android Studio projects)');
  });
});
