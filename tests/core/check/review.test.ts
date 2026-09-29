import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectMacSigning, parseCodesignDisplay, type MacSigning, type ToolRunner } from '../../../src/core/check/mac-signing.js';
import { appIdCheck, buildsCheck, findBuilds, iconCheck, macAppPath, macSigningCheck, steamAppIdCheck } from '../../../src/core/check/review.js';
import { capDetails, checkIssues, countStatuses, type CheckResult } from '../../../src/core/check/types.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

const config = (extra: object = {}) => parseConfig({ name: 'Moon Game', version: '1.0.0', ...extra }).data!;

/** Empty files where each OS's executable goes. */
function fakeBuilds(dir: string, targets: string[]): void {
  const files: Record<string, string> = {};
  if (targets.includes('windows')) files['out/windows/Moon Game.exe'] = '';
  if (targets.includes('linux')) files['out/linux/moon-game'] = '';
  if (targets.includes('mac')) files['out/mac/Moon Game.app/Contents/MacOS/Moon Game'] = '';
  writeFiles(dir, files);
}

describe('check results', () => {
  it('count by status, become one error or warning each, and keep their details short', () => {
    const checks: CheckResult[] = [
      { id: 'a', group: 'review', title: 'A', status: 'pass', message: 'fine' },
      { id: 'b', group: 'review', title: 'B', status: 'fail', code: 'CHECK_B', message: 'broken', fix: 'mend it' },
      { id: 'c', group: 'store', title: 'C', status: 'warn', code: 'CHECK_C', message: 'odd', fix: 'look' },
      { id: 'd', group: 'ai', title: 'D', status: 'info', message: 'note' },
    ];
    expect(countStatuses(checks)).toEqual({ pass: 1, warn: 1, fail: 1, info: 1, skip: 0 });
    expect(checkIssues(checks, 'fail')).toEqual([{ code: 'CHECK_B', message: 'broken', fix: 'mend it' }]);
    expect(checkIssues(checks, 'warn')).toEqual([{ code: 'CHECK_C', message: 'odd', fix: 'look' }]);
    const many = capDetails([...Array.from({ length: 12 }, (_, i) => `line ${i}`), 'x'.repeat(900)]);
    expect(many).toHaveLength(11);
    expect(many[10]).toBe('…and 3 more');
    expect(capDetails(['y'.repeat(900)])[0]).toBe(`${'y'.repeat(500)}…`);
  });
});

describe('findBuilds / buildsCheck', () => {
  it('passes when every desktop target has a build', () => {
    const dir = makeTmpDir();
    fakeBuilds(dir, ['windows', 'mac', 'linux']);
    const builds = findBuilds(dir, config());
    expect(builds.map((b) => [b.target, b.built])).toEqual([
      ['windows', true],
      ['mac', true],
      ['linux', true],
    ]);
    expect(macAppPath(builds[1].executable)).toBe(path.join(dir, 'out', 'mac', 'Moon Game.app'));
    expect(buildsCheck(builds)).toMatchObject({ id: 'review.builds', status: 'pass', message: 'Built: windows, mac, linux.' });
  });

  it('fails naming the missing targets', () => {
    const dir = makeTmpDir();
    fakeBuilds(dir, ['mac']);
    const c = buildsCheck(findBuilds(dir, config({ targets: ['windows', 'mac', 'ios'] })));
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_BUILD_MISSING', details: ['out/windows'] });
  });
});

describe('steamAppIdCheck', () => {
  it('fails for steam_appid.txt anywhere in out/, in any letter case', () => {
    const dir = makeTmpDir();
    fakeBuilds(dir, ['windows', 'linux']);
    writeFiles(dir, { 'out/linux/Steam_AppID.txt': '480', 'out/windows/resources/steam_appid.txt': '480', 'out/old/steam_appid.txt': '480' });
    const c = steamAppIdCheck(dir);
    expect(c).toMatchObject({ status: 'fail', code: 'CHECK_STEAM_APPID_FILE' });
    expect(c.details).toEqual(['out/linux/Steam_AppID.txt', 'out/old/steam_appid.txt', 'out/windows/resources/steam_appid.txt']);
  });

  it('passes for clean builds and when nothing is built yet', () => {
    const dir = makeTmpDir();
    fakeBuilds(dir, ['linux']);
    expect(steamAppIdCheck(dir).status).toBe('pass');
    expect(steamAppIdCheck(makeTmpDir()).status).toBe('pass');
  });
});

// Real `codesign -dv --verbose=2` output on macOS (Steam.app, an ad-hoc signed Electron app, an unsigned file).
const STEAM = [
  'Executable=/Applications/Steam.app/Contents/MacOS/steam_osx',
  'CodeDirectory v=20500 size=32003 flags=0x10000(runtime) hashes=989+7 location=embedded',
  'Signature size=9075',
  'Authority=Developer ID Application: Valve Corporation (MXGJJ98X76)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=MXGJJ98X76',
].join('\n');
const ADHOC =
  'Executable=/x/My Game.app/Contents/MacOS/My Game\nCodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded\nSignature=adhoc\nTeamIdentifier=not set';
const UNSIGNED = '/x/unsigned-bin: code object is not signed at all';

describe('parseCodesignDisplay / inspectMacSigning', () => {
  it('tells Developer ID, ad-hoc and unsigned apart', () => {
    expect(parseCodesignDisplay(STEAM)).toEqual({ kind: 'developer-id', authority: 'Developer ID Application: Valve Corporation (MXGJJ98X76)' });
    expect(parseCodesignDisplay(ADHOC)).toEqual({ kind: 'adhoc', authority: null });
    expect(parseCodesignDisplay(UNSIGNED)).toEqual({ kind: 'unsigned', authority: null });
    expect(parseCodesignDisplay('Authority=Apple Development: me (X)')).toEqual({ kind: 'other', authority: 'Apple Development: me (X)' });
  });

  it('runs codesign, then stapler only when Apple’s command-line tools are there', async () => {
    const calls: string[] = [];
    const runner =
      (tools: boolean): ToolRunner =>
      async (command, args) => {
        calls.push([command, ...args].join(' '));
        if (args[0] === '-dv') return { code: 0, output: ADHOC };
        if (command === 'xcode-select') return tools ? { code: 0, output: '/Library/Developer/CommandLineTools' } : { code: 2, output: 'no developer tools' };
        if (command === 'xcrun') return { code: 65, output: 'My Game.app does not have a ticket stapled to it.' };
        return { code: 0, output: '' };
      };
    expect(await inspectMacSigning('/o/My Game.app', runner(true))).toEqual({
      kind: 'adhoc',
      authority: null,
      valid: true,
      stapled: false,
      detail: 'My Game.app does not have a ticket stapled to it.',
    });
    expect(calls).toEqual([
      'codesign -dv --verbose=2 /o/My Game.app',
      'codesign --verify --deep --strict /o/My Game.app',
      'xcode-select -p',
      'xcrun stapler validate /o/My Game.app',
    ]);
    calls.length = 0;
    expect((await inspectMacSigning('/o/My Game.app', runner(false))).stapled).toBeNull();
    expect(calls).not.toContain('xcrun stapler validate /o/My Game.app');
  });
});

describe('macSigningCheck', () => {
  const dir = makeTmpDir();
  fakeBuilds(dir, ['mac']);
  const mac = config({ targets: ['mac'] });
  const builds = findBuilds(dir, mac);
  const signing = (s: Partial<MacSigning>): MacSigning => ({ kind: 'developer-id', authority: 'Developer ID Application: Me (T)', valid: true, stapled: true, detail: '', ...s });

  it('passes a Developer ID signed, notarized app', () => {
    expect(macSigningCheck(mac, builds, 'darwin', signing({}))).toMatchObject({ status: 'pass', message: 'Signed by Developer ID Application: Me (T) and notarized.' });
  });

  it('fails ad-hoc or unnotarized apps with a fix', () => {
    const adhoc = macSigningCheck(mac, builds, 'darwin', signing({ kind: 'adhoc', authority: null, stapled: false }));
    expect(adhoc).toMatchObject({ status: 'fail', code: 'CHECK_MAC_NOT_NOTARIZED' });
    expect(adhoc.message).toContain('ad-hoc');
    expect(macSigningCheck(mac, builds, 'darwin', signing({ stapled: false })).message).toContain('not notarized');
  });

  it('warns when notarization or signing cannot be checked, and skips when there is no Mac build', () => {
    expect(macSigningCheck(mac, builds, 'darwin', signing({ stapled: null }))).toMatchObject({ status: 'warn', code: 'CHECK_MAC_SIGNING_UNKNOWN', fix: 'Run `xcode-select --install`, then check again.' });
    expect(macSigningCheck(mac, builds, 'linux', null)).toMatchObject({ status: 'warn', code: 'CHECK_MAC_SIGNING_UNKNOWN' });
    expect(macSigningCheck(config({ targets: ['linux'] }), [], 'darwin', null).status).toBe('skip');
    expect(macSigningCheck(mac, findBuilds(makeTmpDir(), mac), 'darwin', null).status).toBe('skip');
  });
});

describe('iconCheck / appIdCheck', () => {
  it('warns about the default icon and the test App ID', () => {
    expect(iconCheck(config())).toMatchObject({ status: 'warn', code: 'CHECK_DEFAULT_ICON' });
    expect(iconCheck(config({ icon: 'icon.png' })).status).toBe('pass');
    expect(appIdCheck(config())).toMatchObject({ status: 'warn', code: 'CHECK_TEST_APP_ID' });
    expect(appIdCheck(config({ steam: { appId: 1234567 } })).status).toBe('pass');
  });
});
