import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSigningIdentity, matchIdentity, parseIdentities, signMacApp } from '../../../src/core/sign/sign.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeMiniApp, MINI_CRASHPAD, MINI_NATIVE } from '../../helpers/mac-bundle.js';
import { makeTmpDir } from '../../helpers/tmp.js';

const H1 = '0123456789ABCDEF0123456789ABCDEF01234567';
const H2 = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98';
/** codesign prints most details on stderr. */
function codesignText(...args: string[]): string {
  const r = spawnSync('codesign', args, { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

const OUTPUT = `  1) ${H1} "Developer ID Application: Jane Doe (TEAM123456)"
  2) ${H2} "Apple Development: jane@example.com (ABCDE12345)"
     2 valid identities found
`;

describe('signing identities', () => {
  it('parses security find-identity output', () => {
    expect(parseIdentities(OUTPUT)).toEqual([
      { hash: H1, name: 'Developer ID Application: Jane Doe (TEAM123456)' },
      { hash: H2, name: 'Apple Development: jane@example.com (ABCDE12345)' },
    ]);
    expect(parseIdentities('     0 valid identities found\n')).toEqual([]);
  });

  it('matches by exact name, hash (any case) or a unique prefix', () => {
    const ids = parseIdentities(OUTPUT);
    expect(matchIdentity('Developer ID Application: Jane Doe (TEAM123456)', ids)?.hash).toBe(H1);
    expect(matchIdentity(H2.toLowerCase(), ids)?.hash).toBe(H2);
    expect(matchIdentity('Developer ID Application', ids)?.hash).toBe(H1);
    expect(matchIdentity('Developer ID Installer', ids)).toBeNull();
  });

  it('MAC_IDENTITY_NOT_FOUND counts the identities that are there by type, without their names', async () => {
    const list = async () => parseIdentities(OUTPUT);
    expect(await findSigningIdentity('Developer ID Application: Jane', list)).toEqual({ hash: H1, name: 'Developer ID Application: Jane Doe (TEAM123456)' });
    const selfSigned = `${OUTPUT}  3) ${H1.replace('0', '9')} "Jane's test cert"\n`;
    const err = await findSigningIdentity('Developer ID Application: Nobody (NOPE000000)', async () => parseIdentities(selfSigned)).then(
      () => null,
      (e: { error: { code: string; message: string; fix: string } }) => e.error,
    );
    expect(err?.code).toBe('MAC_IDENTITY_NOT_FOUND');
    expect(err?.message).toContain('found 3 signing identities (Developer ID Application, Apple Development, other); none match');
    for (const text of ['Jane', 'jane@example.com', 'TEAM123456', 'ABCDE12345', 'Nobody', H1, H2]) expect(JSON.stringify(err), text).not.toContain(text);
    await expect(findSigningIdentity('Developer ID Application: Nobody', async () => [])).rejects.toMatchObject({
      error: { message: expect.stringContaining('found no signing identities') },
    });
  });
});

describe.runIf(process.platform === 'darwin')('signMacApp (macOS)', () => {
  const entitlementsOf = (file: string) => codesignText('-d', '--entitlements', '-', '--xml', file);

  it('ad-hoc signs everything, native modules included, with the hardened runtime and Steam entitlements', async () => {
    const dir = makeTmpDir();
    const app = makeMiniApp(dir);
    await signMacApp(testCtx(dir), app, null, { steam: true });
    expect(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status).toBe(0);
    expect(codesignText('-dv', app)).toContain('flags=0x10002(adhoc,runtime)');
    // Notarization rejects any Mach-O file without the hardened runtime, such as koffi.node or libsteam_api.dylib.
    expect(codesignText('-dv', path.join(app, ...MINI_NATIVE.split('/')))).toContain('flags=0x10002(adhoc,runtime)');
    const main = entitlementsOf(app);
    expect(main).toContain('com.apple.security.cs.allow-dyld-environment-variables');
    expect(main).toContain('com.apple.security.cs.disable-library-validation');
    const helper = entitlementsOf(`${app}/Contents/Frameworks/Mini Helper.app`);
    expect(helper).toContain('com.apple.security.cs.disable-library-validation');
    expect(helper).not.toContain('allow-dyld-environment-variables');
    // Electron's crash reporter: the hardened runtime, and no entitlements at all.
    expect(codesignText('-dv', path.join(app, ...MINI_CRASHPAD.split('/')))).toContain('flags=0x10002(adhoc,runtime)');
    expect(entitlementsOf(path.join(app, ...MINI_CRASHPAD.split('/')))).not.toContain('<key>');
  });

  it('without Steam, the main process gets no DYLD entitlement', async () => {
    const dir = makeTmpDir();
    const app = makeMiniApp(dir);
    await signMacApp(testCtx(dir), app, null);
    expect(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status).toBe(0);
    const main = entitlementsOf(app);
    expect(main).toContain('com.apple.security.cs.allow-jit');
    expect(main).not.toContain('allow-dyld-environment-variables');
    // Ad-hoc: without it the app couldn't load Electron's framework.
    expect(main).toContain('com.apple.security.cs.disable-library-validation');
    expect(main).not.toMatch(/device\.usb|device\.bluetooth/);
  });

  it("the run log names a Developer ID by its SHA-1, never by its name", async () => {
    const dir = makeTmpDir();
    const ctx = testCtx(dir);
    // Not in the keychain, so codesign fails; what matters is what was logged first.
    await expect(signMacApp(ctx, makeMiniApp(dir), { hash: H2, name: 'Developer ID Application: Jane Doe (TEAM123456)' })).rejects.toMatchObject({
      error: { code: 'MAC_SIGN_FAILED' },
    });
    const log = fs.readFileSync(ctx.logPath, 'utf8');
    expect(log).toContain(H2);
    expect(log).not.toContain('Jane Doe');
  });

  it('MAC_SIGN_FAILED with codesign output in a log file', async () => {
    const dir = makeTmpDir();
    const app = makeMiniApp(dir);
    // codesign signs it, but its strict check (which osx-sign runs) refuses a link out of the bundle.
    fs.symlinkSync('/etc/hosts', path.join(app, 'Contents', 'Resources', 'outside'));
    const err = await signMacApp(testCtx(dir), app, null).then(
      () => null,
      (e: { error: { code: string; message: string; fix: string } }) => e.error,
    );
    expect(err?.code).toBe('MAC_SIGN_FAILED');
    expect(err?.message).toContain('invalid destination for symbolic link in bundle');
    const logPath = /(\/\S+codesign-\S+\.log)/.exec(err!.fix)![1];
    expect(fs.readFileSync(logPath, 'utf8')).toContain('codesign');
  });

  it("looks identities up in this Mac's keychain", async () => {
    await expect(findSigningIdentity('Developer ID Application: Nobody (NOPE000000)')).rejects.toMatchObject({ error: { code: 'MAC_IDENTITY_NOT_FOUND' } });
  });
});
