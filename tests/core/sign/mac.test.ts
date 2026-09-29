import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/core/config/load.js';
import { GsFailure } from '../../../src/core/result.js';
import { finishMacApp, planMacSigning, type FinishMacDeps, type MacSigningPlan } from '../../../src/core/sign/mac.js';
import type { SigningIdentity } from '../../../src/core/sign/sign.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeTmpDir } from '../../helpers/tmp.js';

const ID = 'Developer ID Application: Jane Doe (TEAM123456)';
const JANE: SigningIdentity = { hash: '0123456789ABCDEF0123456789ABCDEF01234567', name: ID };
const config = (bundleId: string | null = 'com.jane.moon') => parseConfig({ name: 'Moon', version: '1.0.0', mobile: { bundleId } }).data!;

describe('planMacSigning', () => {
  const find = async (wanted: string) => {
    if (wanted === ID) return JANE;
    throw new GsFailure('MAC_IDENTITY_NOT_FOUND', `no ${wanted}`, 'install it');
  };

  it('ad-hoc without Apple variables, unsigned off a Mac', async () => {
    expect(await planMacSigning('darwin', {}, find)).toEqual({ kind: 'adhoc' });
    expect(await planMacSigning('linux', { GAMESHIPPER_MAC_IDENTITY: ID }, find)).toEqual({ kind: 'other-host' });
    expect(await planMacSigning('win32', { GAMESHIPPER_NOTARY_PROFILE: 'gs' }, find)).toEqual({ kind: 'other-host' });
  });

  it('a Developer ID from the keychain, with the notary login', async () => {
    expect(await planMacSigning('darwin', { GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_PROFILE: 'gs' }, find)).toEqual({
      kind: 'developer-id',
      identity: JANE,
      notary: { kind: 'keychain-profile', keychainProfile: 'gs' },
    });
  });

  it('APPLE_CREDENTIALS_INVALID and MAC_IDENTITY_NOT_FOUND before anything is built', async () => {
    await expect(planMacSigning('darwin', { GAMESHIPPER_NOTARY_PROFILE: 'gs' }, find)).rejects.toMatchObject({ error: { code: 'APPLE_CREDENTIALS_INVALID' } });
    await expect(planMacSigning('darwin', { GAMESHIPPER_MAC_IDENTITY: 'Developer ID Application: Nobody' }, find)).rejects.toMatchObject({
      error: { code: 'MAC_IDENTITY_NOT_FOUND' },
    });
  });
});

function recorder() {
  const calls: string[] = [];
  const deps: FinishMacDeps = {
    sign: async (_ctx, app, identity, opts) => void calls.push(`sign ${identity?.name ?? 'ad-hoc'} ${app}${opts?.steam ? ' +steam' : ''}`),
    notarize: async (_ctx, app, auth) => void calls.push(`notarize ${auth.kind} ${app}`),
  };
  return { calls, deps };
}

const developerId = (notary: boolean): MacSigningPlan => ({
  kind: 'developer-id',
  identity: JANE,
  notary: notary ? { kind: 'keychain-profile', keychainProfile: 'gs' } : null,
});

describe('finishMacApp', () => {
  it('ad-hoc signs and warns MAC_UNSIGNED without Apple credentials', async () => {
    const { calls, deps } = recorder();
    const r = await finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', { kind: 'adhoc' }, deps);
    expect(calls).toEqual(['sign ad-hoc /o/Moon.app']);
    expect(r).toMatchObject({ signing: 'adhoc', notarized: false });
    expect(r.warnings.map((w) => w.code)).toEqual(['MAC_UNSIGNED']);
    expect(r.warnings[0].fix).toContain('GAMESHIPPER_MAC_IDENTITY');
  });

  it("passes on whether the app bundles Steam, which decides the entitlements", async () => {
    const { calls, deps } = recorder();
    await finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', { kind: 'adhoc' }, { ...deps, steam: true });
    await finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', developerId(false), { ...deps, steam: true });
    expect(calls).toEqual(['sign ad-hoc /o/Moon.app +steam', `sign ${ID} /o/Moon.app +steam`]);
  });

  it('signs with the Developer ID, then notarizes', async () => {
    const { calls, deps } = recorder();
    const r = await finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', developerId(true), deps);
    expect(calls).toEqual([`sign ${ID} /o/Moon.app`, 'notarize keychain-profile /o/Moon.app']);
    expect(r).toEqual({ signing: 'developer-id', notarized: true, warnings: [] });
  });

  it('warns when signed but not notarized, and about the placeholder bundle ID', async () => {
    const { calls, deps } = recorder();
    const r = await finishMacApp(testCtx(makeTmpDir()), config(null), '/o/Moon.app', developerId(false), deps);
    expect(calls).toEqual([`sign ${ID} /o/Moon.app`]);
    expect(r).toMatchObject({ signing: 'developer-id', notarized: false });
    expect(r.warnings.map((w) => w.code)).toEqual(['MAC_BUNDLE_ID_DEFAULT', 'MAC_NOT_NOTARIZED']);
    expect(r.warnings[0].message).toContain('local.gameshipper.moon');
  });

  it('a signing or notarization failure fails the Mac target', async () => {
    const { deps } = recorder();
    const failing = (code: string) => async () => {
      throw new GsFailure(code, 'nope', 'see log');
    };
    await expect(finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', developerId(true), { ...deps, notarize: failing('NOTARIZE_FAILED') })).rejects.toMatchObject({
      error: { code: 'NOTARIZE_FAILED' },
    });
    await expect(finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', developerId(true), { ...deps, sign: failing('MAC_SIGN_FAILED') })).rejects.toMatchObject({
      error: { code: 'MAC_SIGN_FAILED' },
    });
  });

  it('ad-hoc signing trouble is only a warning', async () => {
    const deps: FinishMacDeps = {
      sign: async () => {
        throw new GsFailure('MAC_SIGN_FAILED', 'codesign exploded', 'x');
      },
    };
    const r = await finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', { kind: 'adhoc' }, deps);
    expect(r.signing).toBe('unsigned');
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'MAC_ADHOC_SIGN_FAILED', message: expect.stringContaining('codesign exploded') })]);
  });

  it('leaves Mac builds from other hosts unsigned with MAC_SIGN_HOST', async () => {
    const { calls, deps } = recorder();
    const r = await finishMacApp(testCtx(makeTmpDir()), config(), '/o/Moon.app', { kind: 'other-host' }, deps);
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ signing: 'unsigned', notarized: false, warnings: [{ code: 'MAC_SIGN_HOST' }] });
  });
});
