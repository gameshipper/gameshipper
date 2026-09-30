import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { steamDashboard } from '../../../src/core/publish/steam/dashboard.js';

describe('steamDashboard', () => {
  const config = parseConfig({ name: 'Moon: Game', version: '1.0.0', steam: { appId: 1234560 } }).data!;

  it('links the builds, installation and Steam Cloud pages', () => {
    const d = steamDashboard(config, ['windows']);
    expect([d.buildsUrl, d.settingsUrl, d.cloudUrl]).toEqual([
      'https://partner.steamgames.com/apps/builds/1234560',
      'https://partner.steamgames.com/apps/config/1234560',
      'https://partner.steamgames.com/apps/cloud/1234560',
    ]);
  });

  it('launch options name what players run, relative to the depot, as the builds name it', () => {
    expect(steamDashboard(config, ['windows', 'mac', 'linux']).launchOptions).toEqual([
      { os: 'Windows', executable: 'Moon- Game.exe' },
      { os: 'macOS', executable: 'Moon- Game.app' },
      { os: 'Linux + SteamOS', executable: 'moon-game' },
    ]);
  });

  it("Auto-Cloud syncs the saves folder, which is named after the game's file-safe name", () => {
    const cloud = steamDashboard(config, ['windows', 'mac', 'linux']).autoCloud;
    expect(cloud.paths).toEqual([
      { os: 'Windows', root: 'WinAppDataRoaming', subdirectory: 'Moon- Game/saves', pattern: '*.json', recursive: false },
      { os: 'macOS', root: 'MacAppSupport', subdirectory: 'Moon- Game/saves', pattern: '*.json', recursive: false },
      { os: 'Linux + SteamOS', root: 'LinuxHome', subdirectory: '.config/Moon- Game/saves', pattern: '*.json', recursive: false },
    ]);
    expect([cloud.bytesPerUser, cloud.filesPerUser]).toEqual([10_000_000, 100]);
  });

  it('lists only the OSes that were uploaded', () => {
    expect(steamDashboard(config, ['linux']).launchOptions.map((l) => l.os)).toEqual(['Linux + SteamOS']);
  });
});
