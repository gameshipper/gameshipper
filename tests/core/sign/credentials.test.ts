import { describe, expect, it } from 'vitest';
import { APPLE_ENV, readAppleCredentials } from '../../../src/core/sign/credentials.js';

const ID = 'Developer ID Application: Jane Doe (TEAM123456)';
const exists = () => true;

describe('readAppleCredentials', () => {
  it('nothing set means ad-hoc signing, not an error', () => {
    expect(readAppleCredentials({}, exists)).toEqual({ credentials: null, error: null });
    expect(readAppleCredentials({ GAMESHIPPER_MAC_IDENTITY: '  ', GAMESHIPPER_NOTARY_PROFILE: '' }, exists)).toEqual({ credentials: null, error: null });
  });

  it('identity only signs without notarizing', () => {
    expect(readAppleCredentials({ GAMESHIPPER_MAC_IDENTITY: ID }, exists).credentials).toEqual({ identity: ID, notary: null });
  });

  it('identity + keychain profile', () => {
    const r = readAppleCredentials({ GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_PROFILE: 'gs', GAMESHIPPER_NOTARY_KEYCHAIN: '/k.keychain-db' }, exists);
    expect(r.credentials!.notary).toEqual({ kind: 'keychain-profile', keychainProfile: 'gs', keychain: '/k.keychain-db' });
  });

  it('identity + API key for CI', () => {
    const r = readAppleCredentials(
      { GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_KEY: '/k/AuthKey_X.p8', GAMESHIPPER_NOTARY_KEY_ID: 'X', GAMESHIPPER_NOTARY_ISSUER: 'uuid' },
      exists,
    );
    expect(r.credentials!.notary).toEqual({ kind: 'api-key', appleApiKey: '/k/AuthKey_X.p8', appleApiKeyId: 'X', appleApiIssuer: 'uuid' });
  });

  it('APPLE_CREDENTIALS_INVALID for incomplete or conflicting settings', () => {
    const cases: NodeJS.ProcessEnv[] = [
      { GAMESHIPPER_NOTARY_PROFILE: 'gs' },
      { GAMESHIPPER_MAC_IDENTITY: '-', GAMESHIPPER_NOTARY_PROFILE: 'gs' },
      { GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_KEY: '/k.p8' },
      { GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_PROFILE: 'gs', GAMESHIPPER_NOTARY_KEY: '/k.p8', GAMESHIPPER_NOTARY_KEY_ID: 'X' },
    ];
    for (const env of cases) {
      const r = readAppleCredentials(env, exists);
      expect(r.credentials, JSON.stringify(env)).toBeNull();
      expect(r.error?.code).toBe('APPLE_CREDENTIALS_INVALID');
      expect(r.error?.fix).toBeTruthy();
    }
  });

  it('names the variables that conflict', () => {
    const cases: Array<[NodeJS.ProcessEnv, string[]]> = [
      [{ GAMESHIPPER_NOTARY_KEYCHAIN: '/k.keychain-db' }, ['GAMESHIPPER_NOTARY_KEYCHAIN', 'GAMESHIPPER_NOTARY_PROFILE']],
      [{ GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_KEYCHAIN: '/k.keychain-db' }, ['GAMESHIPPER_NOTARY_KEYCHAIN', 'GAMESHIPPER_NOTARY_PROFILE']],
      [
        { GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_KEYCHAIN: '/k.keychain-db', GAMESHIPPER_NOTARY_KEY: '/k.p8', GAMESHIPPER_NOTARY_KEY_ID: 'X' },
        ['GAMESHIPPER_NOTARY_KEYCHAIN', 'GAMESHIPPER_NOTARY_KEY'],
      ],
      [{ GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_PROFILE: 'gs', GAMESHIPPER_NOTARY_ISSUER: 'uuid' }, ['GAMESHIPPER_NOTARY_ISSUER', 'GAMESHIPPER_NOTARY_PROFILE']],
      [{ GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_PROFILE: 'gs', GAMESHIPPER_NOTARY_KEY_ID: 'X' }, ['GAMESHIPPER_NOTARY_PROFILE', 'GAMESHIPPER_NOTARY_KEY_ID']],
    ];
    for (const [env, names] of cases) {
      const r = readAppleCredentials(env, exists);
      expect(r.error?.code, JSON.stringify(env)).toBe('APPLE_CREDENTIALS_INVALID');
      for (const name of names) expect(r.error?.message, JSON.stringify(env)).toContain(name);
    }
  });

  it('never repeats a private key pasted into GAMESHIPPER_NOTARY_KEY', () => {
    const body = 'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgFAKEKEYFAKEKEY';
    for (const key of [`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`, `-----BEGIN PRIVATE KEY----- ${body} -----END PRIVATE KEY-----`, `${body}\n${body}`]) {
      const r = readAppleCredentials({ GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_KEY: key, GAMESHIPPER_NOTARY_KEY_ID: 'X' }, () => false);
      expect(r.error?.code).toBe('APPLE_CREDENTIALS_INVALID');
      const text = JSON.stringify(r.error);
      expect(text).not.toContain(body);
      expect(text).not.toContain('BEGIN');
      expect(r.error?.message).toContain('path');
      expect(r.error?.fix).toContain('.p8');
    }
  });

  it('checks the API key file exists', () => {
    const r = readAppleCredentials({ GAMESHIPPER_MAC_IDENTITY: ID, GAMESHIPPER_NOTARY_KEY: '/nope.p8', GAMESHIPPER_NOTARY_KEY_ID: 'X' }, () => false);
    expect(r.error?.message).toContain('/nope.p8');
  });

  it('documents every variable it reads', () => {
    expect(Object.keys(APPLE_ENV)).toEqual([
      'GAMESHIPPER_MAC_IDENTITY',
      'GAMESHIPPER_NOTARY_PROFILE',
      'GAMESHIPPER_NOTARY_KEYCHAIN',
      'GAMESHIPPER_NOTARY_KEY',
      'GAMESHIPPER_NOTARY_KEY_ID',
      'GAMESHIPPER_NOTARY_ISSUER',
    ]);
  });

  it('the test runs never see the Apple variables of the shell they were started from', () => {
    for (const name of Object.keys(APPLE_ENV)) expect(process.env[name] ?? '', name).toBe('');
  });
});
