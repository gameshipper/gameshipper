import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NotaryAuth } from '../../../src/core/sign/credentials.js';
import { notarizeFailure, notarizeMacApp, notaryCredentials, STAPLE_ATTEMPTS } from '../../../src/core/sign/notarize.js';
import { signMacApp } from '../../../src/core/sign/sign.js';
import { testCtx } from '../../helpers/ctx.js';
import { installFakeXcrun, withEnv } from '../../helpers/fake-xcrun.js';
import { makeMiniApp } from '../../helpers/mac-bundle.js';
import { makeTmpDir } from '../../helpers/tmp.js';

const profile: NotaryAuth = { kind: 'keychain-profile', keychainProfile: 'gs-notary' };

describe('notaryCredentials', () => {
  it('maps our auth kinds onto @electron/notarize options', () => {
    expect(notaryCredentials(profile)).toEqual({ keychainProfile: 'gs-notary' });
    expect(notaryCredentials({ kind: 'keychain-profile', keychainProfile: 'p', keychain: '/k' })).toEqual({ keychainProfile: 'p', keychain: '/k' });
    expect(notaryCredentials({ kind: 'api-key', appleApiKey: '/k.p8', appleApiKeyId: 'K1' })).toEqual({ appleApiKey: '/k.p8', appleApiKeyId: 'K1' });
  });
});

describe('notarizeFailure', () => {
  it('NOTARIZE_FAILED names the submission, the log and how to fetch the report', () => {
    const f = notarizeFailure('Failed to notarize via notarytool\n\n{"id":"abc-123","status":"Invalid"}', '/p/.gameshipper/logs/notarize-1.log', '/o/G.app', profile);
    expect(f.error.code).toBe('NOTARIZE_FAILED');
    expect(f.error.message).toContain('status: Invalid');
    expect(f.error.fix).toContain('/p/.gameshipper/logs/notarize-1.log');
    expect(f.error.fix).toContain('xcrun notarytool log abc-123 --keychain-profile "$GAMESHIPPER_NOTARY_PROFILE"');
  });

  it("names the login by its variables, never the key's path, ID or issuer", () => {
    const apiKey: NotaryAuth = { kind: 'api-key', appleApiKey: '/Users/jane/keys/AuthKey_K1ABCDEF.p8', appleApiKeyId: 'K1ABCDEF', appleApiIssuer: '69a6de7e-1111-2222-3333-444455556666' };
    const keychain: NotaryAuth = { kind: 'keychain-profile', keychainProfile: 'gs', keychain: '/Users/jane/Library/Keychains/ci.keychain-db' };
    const invalid = 'Failed to notarize via notarytool\n\n{"id":"abc-123","status":"Invalid"}';
    const f = notarizeFailure(invalid, '/p/l.log', '/o/G.app', apiKey);
    expect(f.error.fix).toContain('xcrun notarytool log abc-123 --key "$GAMESHIPPER_NOTARY_KEY" --key-id "$GAMESHIPPER_NOTARY_KEY_ID" --issuer "$GAMESHIPPER_NOTARY_ISSUER"');
    const k = notarizeFailure(invalid, '/p/l.log', '/o/G.app', keychain);
    expect(k.error.fix).toContain('--keychain-profile "$GAMESHIPPER_NOTARY_PROFILE" --keychain "$GAMESHIPPER_NOTARY_KEYCHAIN"');
    for (const text of ['AuthKey_K1ABCDEF', 'K1ABCDEF', '69a6de7e', 'jane', 'ci.keychain-db']) {
      expect(JSON.stringify([f.error, k.error]), text).not.toContain(text);
    }
  });

  it("keeps notarytool's own reason when it answers in plain text (a login problem, not Apple's verdict)", () => {
    const out = 'Conducting pre-submission checks for G.zip and initiating connection to the Apple notary service...\nError: HTTP status code: 401. Unable to authenticate. Invalid Session.\n\n';
    const f = notarizeFailure(`Failed to notarize via notarytool.  Failed with unexpected result: \n\n${out}`, '/p/l.log', '/o/G.app', profile);
    expect(f.error.code).toBe('NOTARIZE_FAILED');
    expect(f.error.message).toContain('Error: HTTP status code: 401. Unable to authenticate. Invalid Session.');
    expect(f.error.message).not.toContain('Conducting');
    expect(f.error.fix).toContain('xcrun notarytool history --keychain-profile "$GAMESHIPPER_NOTARY_PROFILE"');
    expect(f.error.fix).toContain('/p/l.log');
    expect(f.error.fix).not.toContain('unsigned');
  });

  it("says when the app couldn't be zipped for upload", () => {
    const f = notarizeFailure('Failed to zip application, exited with code: 1\n\nditto: /o/G.zip: No space left on device\n', '/p/l.log', '/o/G.app', profile);
    expect(f.error.code).toBe('NOTARIZE_FAILED');
    expect(f.error.message).toContain("Couldn't zip the Mac app");
    expect(f.error.message).toContain('No space left on device');
    expect(f.error.fix).not.toContain('unsigned');
    expect(f.error.fix).not.toContain('notarytool');
  });

  it('recognises a missing notarytool, stapling and signature problems', () => {
    expect(notarizeFailure('notarytool is not available, you must be on at least Xcode 13', 'l', 'a', profile).error.code).toBe('NOTARIZE_TOOL_MISSING');
    expect(notarizeFailure('Failed to staple your application with code: 65', 'l', '/o/G.app', profile).error).toMatchObject({
      code: 'STAPLE_FAILED',
      fix: expect.stringContaining('xcrun stapler staple "/o/G.app"'),
    });
    expect(notarizeFailure('Failed to codesign your application with code: 1', 'l', 'a', profile).error.code).toBe('MAC_SIGN_FAILED');
  });
});

describe.runIf(process.platform === 'darwin')('notarizeMacApp against a fake notarytool (macOS)', () => {
  async function signedApp() {
    const dir = makeTmpDir();
    const app = makeMiniApp(dir);
    await signMacApp(testCtx(dir), app, null);
    return { dir, app, fake: installFakeXcrun(dir) };
  }

  it('submits, waits, fetches the log and staples', async () => {
    const { dir, app, fake } = await signedApp();
    await withEnv({ PATH: `${fake.binDir}:${process.env.PATH}`, FAKE_XCRUN_LOG: fake.logFile, FAKE_NOTARY_RESULT: 'Accepted' }, () =>
      notarizeMacApp(testCtx(dir), app, profile),
    );
    const calls = fs.readFileSync(fake.logFile, 'utf8');
    expect(calls).toMatch(/^notarytool submit .*Mini\.zip --keychain-profile gs-notary --wait --output-format json$/m);
    expect(calls).toContain('stapler staple -v Mini.app');
  });

  it("NOTARIZE_FAILED with Apple's report saved to a log file", async () => {
    const { dir, app, fake } = await signedApp();
    const run = withEnv({ PATH: `${fake.binDir}:${process.env.PATH}`, FAKE_XCRUN_LOG: fake.logFile, FAKE_NOTARY_RESULT: 'Invalid' }, () =>
      notarizeMacApp(testCtx(dir), app, profile),
    );
    const err = await run.then(
      () => null,
      (e: { error: { code: string; fix: string } }) => e.error,
    );
    expect(err?.code).toBe('NOTARIZE_FAILED');
    const logPath = /(\/\S+notarize-\S+\.log)/.exec(err!.fix)![1];
    expect(fs.readFileSync(logPath, 'utf8')).toContain('secure timestamp');
  });

  const staples = (logFile: string) => fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('stapler staple'));

  it('STAPLE_FAILED after 3 attempts, 5 seconds apart', async () => {
    const { dir, app, fake } = await signedApp();
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    const run = withEnv({ PATH: `${fake.binDir}:${process.env.PATH}`, FAKE_XCRUN_LOG: fake.logFile, FAKE_NOTARY_RESULT: 'Accepted', FAKE_STAPLE_FAIL: '1' }, () =>
      notarizeMacApp(testCtx(dir), app, profile, { wait }),
    );
    await expect(run).rejects.toMatchObject({ error: { code: 'STAPLE_FAILED', message: expect.stringContaining('3 tries') } });
    expect(staples(fake.logFile)).toHaveLength(STAPLE_ATTEMPTS);
    expect(STAPLE_ATTEMPTS).toBe(3);
    expect(waits).toEqual([5000, 5000]);
  }, 30_000);

  it('a staple that fails at first and then works counts as notarized', async () => {
    const { dir, app, fake } = await signedApp();
    await withEnv({ PATH: `${fake.binDir}:${process.env.PATH}`, FAKE_XCRUN_LOG: fake.logFile, FAKE_NOTARY_RESULT: 'Accepted', FAKE_STAPLE_FAILURES: '2' }, () =>
      notarizeMacApp(testCtx(dir), app, profile, { wait: async () => {} }),
    );
    expect(staples(fake.logFile)).toHaveLength(3);
  }, 30_000);

  it("NOTARIZE_FAILED with notarytool's plain-text reason when the login fails", async () => {
    const { dir, app, fake } = await signedApp();
    const run = withEnv({ PATH: `${fake.binDir}:${process.env.PATH}`, FAKE_XCRUN_LOG: fake.logFile, FAKE_NOTARY_RESULT: 'AuthError' }, () =>
      notarizeMacApp(testCtx(dir), app, profile),
    );
    const err = await run.then(
      () => null,
      (e: { error: { code: string; message: string; fix: string } }) => e.error,
    );
    expect(err).toMatchObject({ code: 'NOTARIZE_FAILED', message: expect.stringContaining('401. Unable to authenticate') });
    expect(err!.fix).toContain('notarytool history');
    expect(staples(fake.logFile)).toEqual([]);
  }, 30_000);
});
