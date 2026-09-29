import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSteamDeck, sdkLibraryPath, shouldRestartThroughSteam, startSteam, unpackedPath, type SteamworksLoad } from '../../src/shell/steam.js';
import { fakeSteamClient } from '../helpers/steam-fake.js';

const SDK = path.join('/games', 'Moon.app', 'Contents', 'Resources', 'app.asar', 'steamworks_sdk');

function start(client = fakeSteamClient(), extra: Partial<Parameters<typeof startSteam>[0]> = {}, running = true) {
  const logger = { error: (..._args: unknown[]) => {} };
  const load: SteamworksLoad = { instance: () => client, logger, isSteamRunning: () => running };
  const session = startSteam({ appId: 480, sdkDir: SDK, isPackaged: true, platform: 'darwin', env: {}, load: () => load, exists: () => true, callbackMs: 5, ...extra });
  return { session, client, logger };
}

describe('paths', () => {
  it('maps app.asar paths to app.asar.unpacked, and leaves others alone', () => {
    expect(unpackedPath('/g/Moon.app/Contents/Resources/app.asar/steamworks_sdk')).toBe('/g/Moon.app/Contents/Resources/app.asar.unpacked/steamworks_sdk');
    expect(unpackedPath('C:\\Games\\Moon\\resources\\app.asar\\steamworks_sdk')).toBe('C:\\Games\\Moon\\resources\\app.asar.unpacked\\steamworks_sdk');
    expect(unpackedPath('/p/.gameshipper/app/steamworks_sdk')).toBe('/p/.gameshipper/app/steamworks_sdk');
    expect(unpackedPath('/x/app.asarfoo/y')).toBe('/x/app.asarfoo/y');
  });

  it("finds this OS's library", () => {
    expect(sdkLibraryPath('/a/app.asar/steamworks_sdk', 'darwin')).toBe(path.join('/a/app.asar.unpacked/steamworks_sdk', 'redistributable_bin', 'osx', 'libsteam_api.dylib'));
    expect(sdkLibraryPath('/a', 'linux')).toBe(path.join('/a', 'redistributable_bin', 'linux64', 'libsteam_api.so'));
    expect(sdkLibraryPath('/a', 'freebsd')).toBeNull();
  });
});

describe('startSteam', () => {
  it('connects with the App ID and pumps callbacks until stopped', async () => {
    const { session, client } = start();
    expect(session.state).toBe('ready');
    expect(client.calls.slice(0, 2)).toEqual([`setSdkPath ${SDK}`, 'init 480']);
    await new Promise((r) => setTimeout(r, 40));
    expect(client.calls).toContain('runCallbacks');
    session.stop();
    session.stop();
    expect(client.calls.filter((c) => c === 'shutdown')).toHaveLength(1);
    const count = client.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(client.calls.length).toBe(count);
  });

  it('no-sdk when the app has no Steam library', () => {
    expect(start(fakeSteamClient(), { exists: () => false }).session.state).toBe('no-sdk');
  });

  it('not-running when init fails and Steam is not running', () => {
    const { session } = start(fakeSteamClient({ init: () => false }), {}, false);
    expect([session.state, session.client]).toEqual(['not-running', null]);
  });

  it("init-failed with Steam's own reason, and puts the logger back", () => {
    const logger = { error: (..._args: unknown[]) => {} };
    const original = logger.error;
    const client = fakeSteamClient({
      init: () => {
        logger.error('[Steamworks] ERROR: Failed to initialize Steam API:', 'No subscription for app 1234560');
        return false;
      },
    });
    const session = startSteam({
      appId: 1234560,
      sdkDir: SDK,
      isPackaged: false,
      platform: 'darwin',
      env: {},
      load: () => ({ instance: () => client, logger, isSteamRunning: () => true }),
      exists: () => true,
    });
    expect(session).toMatchObject({ state: 'init-failed', message: 'Failed to initialize Steam API: No subscription for app 1234560' });
    expect(logger.error).toBe(original);
  });

  it('init-failed when the bridge itself fails to load', () => {
    const session = startSteam({
      appId: 480,
      sdkDir: SDK,
      isPackaged: true,
      platform: 'darwin',
      env: {},
      load: () => {
        throw new Error('Cannot find the native Koffi module');
      },
      exists: () => true,
    });
    expect(session).toMatchObject({ state: 'init-failed', message: "Couldn't load the Steam bridge: Cannot find the native Koffi module" });
  });

  it('asks Steam to relaunch packaged builds of real apps only', () => {
    expect(shouldRestartThroughSteam(1234560, true, {})).toBe(true);
    expect(shouldRestartThroughSteam(480, true, {})).toBe(false);
    expect(shouldRestartThroughSteam(1234560, false, {})).toBe(false);
    expect(shouldRestartThroughSteam(1234560, true, { GAMESHIPPER_SMOKE_SECONDS: '5' })).toBe(false);
    const relaunch = fakeSteamClient({ restartAppIfNecessary: () => true });
    expect(start(relaunch, { appId: 1234560 }).session.state).toBe('restarting');
    const test = fakeSteamClient();
    start(test);
    expect(test.calls.some((c) => c.startsWith('restartAppIfNecessary'))).toBe(false);
  });

  it('detects the Steam Deck from SteamOS', () => {
    expect([isSteamDeck({ SteamDeck: '1' }), isSteamDeck({})]).toEqual([true, false]);
  });
});
