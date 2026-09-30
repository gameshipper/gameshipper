import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli, readEvents, ROOT } from '../helpers/built-cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

describe('release-check fixture', () => {
  it('runs without errors, so it is ready for the manual Steam checks', () => {
    const dir = makeTmpDir('gs-release-check-');
    fs.cpSync(path.join(ROOT, 'fixtures', 'release-check'), dir, { recursive: true });
    expect(cli(['init', '--yes', '--name', 'Release Check'], dir).code).toBe(0);
    const play = cli(['play', '--smoke', '--seconds', '2'], dir);
    expect(play.result.errors).toEqual([]);
    expect(play.code).toBe(0);
    // Without a Steamworks SDK the page says Steam is off, and every button still has something to call.
    const messages = readEvents(play.result.data.smoke.eventsLog).map((e) => e.message);
    expect(messages).toContain('release-check:ready');
  });
});
