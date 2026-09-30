import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { appBuildVdf, depotBuildVdf, vdfString, writeSteamScripts } from '../../../src/core/publish/steam/vdf.js';
import { makeTmpDir } from '../../helpers/tmp.js';

const slashes = (p: string) => p.split(path.sep).join('/');

describe('SteamPipe build scripts', () => {
  it('quotes and escapes strings', () => {
    expect(vdfString('Moon "Game"')).toBe('"Moon \\"Game\\""');
    expect(vdfString('a\\b')).toBe('"a\\\\b"');
  });

  it('an app build uploads only: no SetLive', () => {
    expect(
      appBuildVdf({
        appId: 1234560,
        description: '1.2.3',
        preview: false,
        setLive: null,
        contentRoot: '/p/out',
        buildOutput: '/p/.gameshipper/steam/output',
        depots: [
          { depotId: 1234561, script: '/p/.gameshipper/steam/depot_build_1234561.vdf' },
          { depotId: 1234563, script: '/p/.gameshipper/steam/depot_build_1234563.vdf' },
        ],
      }),
    ).toBe(
      [
        '"AppBuild"',
        '{',
        '\t"AppID" "1234560"',
        '\t"Desc" "1.2.3"',
        '\t"Preview" "0"',
        '\t"ContentRoot" "/p/out"',
        '\t"BuildOutput" "/p/.gameshipper/steam/output"',
        '\t"Depots"',
        '\t{',
        '\t\t"1234561" "/p/.gameshipper/steam/depot_build_1234561.vdf"',
        '\t\t"1234563" "/p/.gameshipper/steam/depot_build_1234563.vdf"',
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('adds Preview and SetLive when asked', () => {
    const vdf = appBuildVdf({ appId: 1, description: '1.0.0', preview: true, setLive: 'beta', contentRoot: '/o', buildOutput: '/b', depots: [] });
    expect(vdf).toContain('\t"Preview" "1"\n\t"SetLive" "beta"\n');
  });

  it('a depot is a whole folder, and never ships steam_appid.txt', () => {
    expect(depotBuildVdf(1234562, '/p/out/mac')).toBe(
      [
        '"DepotBuild"',
        '{',
        '\t"DepotID" "1234562"',
        '\t"ContentRoot" "/p/out/mac"',
        '\t"FileMapping"',
        '\t{',
        '\t\t"LocalPath" "*"',
        '\t\t"DepotPath" "."',
        '\t\t"Recursive" "1"',
        '\t}',
        '\t"FileExclusion" "steam_appid.txt"',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('writes one depot per build to .gameshipper/steam, numbered like build and check number them', () => {
    const dir = makeTmpDir();
    const config = parseConfig({ name: 'Moon Game', version: '2.0.0', steam: { appId: 1000, depots: { linux: 5000 } } }).data!;
    const builds = [
      { target: 'windows' as const, dir: path.join(dir, 'out', 'windows'), executable: path.join(dir, 'out', 'windows', 'Moon Game.exe') },
      { target: 'linux' as const, dir: path.join(dir, 'out', 'linux'), executable: path.join(dir, 'out', 'linux', 'moon-game') },
    ];
    const s = writeSteamScripts(dir, config, builds, { preview: false, setLive: null });
    expect(s.appBuild).toBe(path.join(dir, '.gameshipper', 'steam', 'app_build_1000.vdf'));
    expect(s.depots.map((d) => [d.target, d.depotId])).toEqual([
      ['windows', 1001],
      ['linux', 5000],
    ]);
    expect(fs.existsSync(s.outputDir)).toBe(true);
    const app = fs.readFileSync(s.appBuild, 'utf8');
    expect(app).toContain('"Desc" "2.0.0"');
    expect(app).toContain(`"1001" "${slashes(path.join(dir, '.gameshipper', 'steam', 'depot_build_1001.vdf'))}"`);
    expect(fs.readFileSync(s.depots[1].script, 'utf8')).toContain(`"ContentRoot" "${slashes(builds[1].dir)}"`);
  });
});
