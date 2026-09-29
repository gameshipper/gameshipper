import * as fs from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cli, HOST_TARGET, ROOT } from '../helpers/built-cli.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeKeyArt, makeLogo } from '../helpers/store-art.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

/** A copy of a fixture with an icon, key art and a logo where `init` finds them. */
async function game(fixture: string): Promise<string> {
  const dir = makeTmpDir('gs-check-');
  fs.cpSync(path.join(ROOT, 'fixtures', fixture), dir, { recursive: true });
  writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024), 'art/key-art.png': await makeKeyArt(), 'art/logo.png': await makeLogo() });
  return dir;
}

type Check = { id: string; status: string; code?: string; details?: string[] };
const statuses = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));
/** Without Apple credentials the Mac build is only ad-hoc signed, which macOS blocks for players (Plan 5 signs it). */
const onMac = HOST_TARGET === 'mac';

describe('check on this computer', () => {
  it.skipIf(process.platform === 'win32')(
    'a finished game: init finds the art, build makes the store images, play saves screenshots, check passes',
    async () => {
      const dir = await game('threejs-cdn');

      const init = cli(['init', '--yes', '--name', 'Spinning Cube'], dir);
      expect(init.result.data.config).toMatchObject({ icon: 'icon.png', keyArt: 'art/key-art.png', logo: 'art/logo.png' });

      const build = cli(['build'], dir);
      expect(build.result.errors).toEqual([]);
      expect(build.result.data.store).toMatchObject({ status: 'built' });
      for (const image of build.result.data.store.images) {
        const meta = await sharp(image.file).metadata();
        expect([path.basename(image.file), meta.width, meta.height]).toEqual([path.basename(image.file), image.width, image.height]);
      }

      const play = cli(['play', '--screenshot', '2,3,4,5,6'], dir);
      expect(play.result.errors).toEqual([]);
      expect(play.result.data.screenshots).toHaveLength(5);
      for (const shot of play.result.data.screenshots) {
        const meta = await sharp(shot).metadata();
        expect([meta.width, meta.height]).toEqual([1920, 1080]);
      }

      const check = cli(['check', '--seconds', '5'], dir);
      expect(statuses(check.result.data.checks)).toEqual({
        'offline.requests': 'pass',
        'launch.run': 'pass',
        'launch.errors': 'pass',
        'launch.frame': 'pass',
        'launch.exit': 'pass',
        'launch.other-os': 'info',
        'deck.layout': 'pass',
        'deck.gamepad': 'warn',
        'deck.text-input': 'pass',
        'review.builds': 'pass',
        'review.steam-appid': 'pass',
        'review.mac-signing': onMac ? 'fail' : 'warn',
        'review.icon': 'pass',
        'review.app-id': 'warn',
        'store.images': 'pass',
        'store.screenshots': 'pass',
        'store.trailer': 'info',
        'ai.disclosure': 'info',
      });
      expect(check.code).toBe(onMac ? 1 : 0);
      expect(check.result.errors.map((e: { code: string }) => e.code)).toEqual(onMac ? ['CHECK_MAC_NOT_NOTARIZED'] : []);
      expect(check.result.data.launched).toMatchObject({ target: HOST_TARGET, exitCode: 0 });
      const deck = await sharp(check.result.data.deckScreenshot).metadata();
      expect([deck.width, deck.height]).toEqual([1280, 800]);

      const status = cli(['status'], dir);
      expect(status.result.data.lastRuns.check).toMatchObject({ ok: !onMac, logPath: check.result.logPath });

      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
    // Up to three first-time Electron downloads.
    30 * 60_000,
  );

  it('a broken game: internet at runtime, a HUD off the Deck screen, no screenshots', async () => {
    const dir = await game('check-broken');
    expect(cli(['init', '--yes', '--name', 'Broken Cube'], dir).code).toBe(0);
    const configFile = path.join(dir, 'gameshipper.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), targets: [HOST_TARGET] }, null, 2));

    const build = cli(['build'], dir);
    expect(build.result.errors).toEqual([]);

    const check = cli(['check', '--seconds', '5'], dir);
    expect(check.code).toBe(1);
    const byId = Object.fromEntries((check.result.data.checks as Check[]).map((c) => [c.id, c]));
    expect(byId['offline.requests']).toMatchObject({ status: 'fail', code: 'CHECK_OFFLINE', details: ['https://example.com/scores.json'] });
    expect(byId['deck.layout']).toMatchObject({ status: 'warn', code: 'CHECK_DECK_LAYOUT' });
    expect(byId['deck.layout'].details!.join('\n')).toContain('div#hud');
    expect(byId['store.screenshots']).toMatchObject({ status: 'fail', code: 'CHECK_SCREENSHOTS' });
    expect(byId['launch.run'].status).toBe('pass');
    expect(byId['launch.frame'].status).toBe('pass');
    expect(byId['launch.exit'].status).toBe('pass');
    expect(check.result.errors.map((e: { code: string }) => e.code)).toEqual(
      onMac ? ['CHECK_OFFLINE', 'CHECK_MAC_NOT_NOTARIZED', 'CHECK_SCREENSHOTS'] : ['CHECK_OFFLINE', 'CHECK_SCREENSHOTS'],
    );

    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
