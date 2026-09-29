import { spawn } from 'node:child_process';
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

/**
 * Listens where the check-broken fixture's WebRTC code sends STUN (UDP 34780) and TURN (TCP 34781) traffic.
 * `stop` says whether both were listening and what reached them.
 */
async function startRtcServers(): Promise<{ stop: () => Promise<{ listening: boolean; reached: string[] }> }> {
  const report = path.join(makeTmpDir('gs-rtc-'), 'servers.txt');
  const script = `
    const fs = require('fs');
    const log = (line) => fs.appendFileSync(${JSON.stringify(report)}, line + '\\n');
    let up = 0;
    const ready = () => ++up === 2 && log('listening');
    const udp = require('dgram').createSocket('udp4');
    udp.on('message', (m) => log('udp ' + m.length + ' bytes'));
    udp.on('error', (e) => log('udp error ' + e.message));
    udp.bind(34780, '127.0.0.1', ready);
    const tcp = require('net').createServer((s) => { log('tcp connection'); s.destroy(); });
    tcp.on('error', (e) => log('tcp error ' + e.message));
    tcp.listen(34781, '127.0.0.1', ready);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const lines = (): string[] => (fs.existsSync(report) ? fs.readFileSync(report, 'utf8').split('\n').filter(Boolean) : []);
  for (let i = 0; i < 100 && !lines().some((l) => l === 'listening' || l.includes('error')); i++) await new Promise((r) => setTimeout(r, 50));
  return {
    async stop() {
      // What arrived while `check` ran has been handled by now.
      await new Promise((r) => setTimeout(r, 500));
      child.kill();
      const seen = lines();
      return { listening: seen.includes('listening'), reached: seen.filter((l) => l !== 'listening') };
    },
  };
}

type Check = { id: string; status: string; code?: string; message?: string; details?: string[] };

/** Builds and checks only this computer's target, which is all check launches. */
function buildOnlyHere(dir: string): void {
  const configFile = path.join(dir, 'gameshipper.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), targets: [HOST_TARGET] }, null, 2));
}
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
    buildOnlyHere(dir);

    const build = cli(['build'], dir);
    expect(build.result.errors).toEqual([]);

    // The STUN and TURN servers the game's WebRTC code uses (fixtures/check-broken/main.js), in their own process:
    // `cli` blocks this one while the check runs.
    const servers = await startRtcServers();
    const check = cli(['check', '--seconds', '5'], dir);
    expect(await servers.stop()).toEqual({ listening: true, reached: [] });
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

  it("a game whose HUD text runs off the Deck screen, though the HUD's box fits", async () => {
    const dir = await game('check-overflow');
    expect(cli(['init', '--yes', '--name', 'Overflow Orbs'], dir).code).toBe(0);
    buildOnlyHere(dir);
    expect(cli(['build'], dir).result.errors).toEqual([]);

    const check = cli(['check', '--seconds', '5'], dir);
    const byId = Object.fromEntries((check.result.data.checks as Check[]).map((c) => [c.id, c]));
    expect(byId['deck.layout']).toMatchObject({ status: 'warn', code: 'CHECK_DECK_LAYOUT', message: 'At 1280x800, text in 1 element runs past the screen edge.' });
    // Where the text ends depends on the fonts: past 1280 is what counts.
    const [detail] = byId['deck.layout'].details!;
    const [, right] = /^div#hud "Score: 000000 · Lives: 3 · Level: 1 · Best: 999999": its text spans x 940\.\.(\d+), y 20\.\.\d+$/.exec(detail) ?? [];
    expect(Number(right)).toBeGreaterThan(1300);
    expect([byId['launch.frame'].status, byId['offline.requests'].status, byId['deck.gamepad'].status]).toEqual(['pass', 'pass', 'pass']);

    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
