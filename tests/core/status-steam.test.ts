import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { statusSummary } from '../../src/cli/summaries.js';
import { getStatus } from '../../src/core/status.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';
import { makeZip } from '../helpers/zip.js';

/** An empty cache, so an SDK some earlier build extracted can't be found. */
const env = () => ({ GAMESHIPPER_CACHE: makeTmpDir('gs-cache-') });
const CONFIG = JSON.stringify({ name: 'x', version: '1.0.0' });

describe('status reports the Steamworks SDK', () => {
  it('shows the SDK builds will use', () => {
    const dir = makeTmpDir();
    writeFiles(dir, {
      'index.html': '',
      'gameshipper.json': CONFIG,
      '.sdk/steamworks_sdk_165.zip': makeZip({ 'sdk/Readme.txt': 'v1.65\n', 'sdk/redistributable_bin/osx/libsteam_api.dylib': 'd' }),
    });
    const r = getStatus(dir, 'darwin', env());
    const zip = path.join(dir, '.sdk', 'steamworks_sdk_165.zip');
    expect(r.data!.steamSdk).toEqual({ source: 'project', path: zip, version: '1.65', targets: ['mac'] });
    expect(r.warnings).toEqual([]);
    expect(statusSummary(r)).toContain(`Steam SDK: 1.65 from project (${zip}) for mac`);
  });

  it('warns when a project has no SDK, and when the configured one is broken, without failing', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'gameshipper.json': CONFIG });
    const none = getStatus(dir, 'darwin', env());
    expect([none.ok, none.data!.steamSdk, none.warnings.map((w) => w.code)]).toEqual([true, null, ['STEAM_SDK_MISSING']]);
    expect(statusSummary(none)).toContain('Steam SDK: none, so builds have no Steam features (see the STEAM_SDK_MISSING fix)');
    const broken = getStatus(dir, 'darwin', { ...env(), GAMESHIPPER_STEAM_SDK: path.join(dir, 'missing.zip') });
    expect([broken.ok, broken.warnings.map((w) => w.code)]).toEqual([true, ['STEAM_SDK_INVALID']]);
    const line = statusSummary(broken).find((l) => l.startsWith('Steam SDK:'));
    expect(line).toBe('Steam SDK: not usable (see the STEAM_SDK_INVALID warning)');
  });

  it('says nothing about the SDK in a folder that is not a project', () => {
    const r = getStatus(makeTmpDir(), 'darwin', env());
    expect(r.warnings.map((w) => w.code)).toEqual(['CONFIG_MISSING']);
    expect(statusSummary(r).find((l) => l.startsWith('Steam SDK:'))).toBe('Steam SDK: none found');
  });
});
