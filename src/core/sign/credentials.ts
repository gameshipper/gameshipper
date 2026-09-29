import * as fs from 'node:fs';
import { gsError, type GsError } from '../result.js';

/** How notarytool logs in. Both come from the environment, never from gameshipper.json. */
export type NotaryAuth =
  | { kind: 'keychain-profile'; keychainProfile: string; keychain?: string }
  | { kind: 'api-key'; appleApiKey: string; appleApiKeyId: string; appleApiIssuer?: string };

export interface AppleCredentials {
  /** "Developer ID Application: Jane Doe (TEAMID1234)" or the certificate's SHA-1 hash. */
  identity: string;
  /** null = sign only, don't notarize. */
  notary: NotaryAuth | null;
}

/** Documented in `help --json` so agents know how to turn on signing. */
export const APPLE_ENV = {
  GAMESHIPPER_MAC_IDENTITY: 'Developer ID Application identity to sign Mac builds with (name or SHA-1 from `security find-identity -v -p codesigning`). Unset: ad-hoc signing.',
  GAMESHIPPER_NOTARY_PROFILE: 'notarytool keychain profile name, created once with `xcrun notarytool store-credentials <name>`.',
  GAMESHIPPER_NOTARY_KEYCHAIN: 'Optional: the keychain that holds the notarytool profile (default: the login keychain).',
  GAMESHIPPER_NOTARY_KEY: 'For CI instead of a profile: the path to an App Store Connect API key file (.p8), not the key itself.',
  GAMESHIPPER_NOTARY_KEY_ID: 'For CI: the API key ID.',
  GAMESHIPPER_NOTARY_ISSUER: 'For CI: the API key issuer ID (omit for individual keys).',
} as const;

const SETUP_FIX =
  'Set GAMESHIPPER_MAC_IDENTITY and GAMESHIPPER_NOTARY_PROFILE (or GAMESHIPPER_NOTARY_KEY + GAMESHIPPER_NOTARY_KEY_ID), or unset them all for an ad-hoc signed build. `npx gameshipper help --json` lists them under "environment".';

const ONE_LOGIN_FIX = 'Use one way to log in to notarytool: a keychain profile (GAMESHIPPER_NOTARY_PROFILE, optionally GAMESHIPPER_NOTARY_KEYCHAIN) or an API key (GAMESHIPPER_NOTARY_KEY, GAMESHIPPER_NOTARY_KEY_ID, optionally GAMESHIPPER_NOTARY_ISSUER). Unset the others.';

const KEY_FILE_FIX = 'Set it to the full path of the AuthKey_XXXX.p8 file you downloaded from App Store Connect.';

function invalid(message: string, fix = SETUP_FIX): { credentials: null; error: GsError } {
  return { credentials: null, error: gsError('APPLE_CREDENTIALS_INVALID', message, fix) };
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Reads Apple signing settings from environment variables.
 * Nothing set → { credentials: null, error: null } (the build is ad-hoc signed).
 */
export function readAppleCredentials(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = fs.existsSync,
): { credentials: AppleCredentials | null; error: GsError | null } {
  const val = (name: keyof typeof APPLE_ENV) => env[name]?.trim() || undefined;
  const identity = val('GAMESHIPPER_MAC_IDENTITY');
  const profile = val('GAMESHIPPER_NOTARY_PROFILE');
  const key = val('GAMESHIPPER_NOTARY_KEY');
  const keyId = val('GAMESHIPPER_NOTARY_KEY_ID');
  const issuer = val('GAMESHIPPER_NOTARY_ISSUER');
  const keychain = val('GAMESHIPPER_NOTARY_KEYCHAIN');

  // Variables of the two notarytool logins mixed, or a keychain without the profile it holds.
  const apiKeyVars = (['GAMESHIPPER_NOTARY_KEY', 'GAMESHIPPER_NOTARY_KEY_ID', 'GAMESHIPPER_NOTARY_ISSUER'] as const).filter((name) => val(name));
  if (profile && apiKeyVars.length) {
    return invalid(`GAMESHIPPER_NOTARY_PROFILE and ${listNames(apiKeyVars)} are both set: they are two different ways to log in to notarytool.`, ONE_LOGIN_FIX);
  }
  if (keychain && !profile) {
    return invalid(
      apiKeyVars.length
        ? `GAMESHIPPER_NOTARY_KEYCHAIN only goes with GAMESHIPPER_NOTARY_PROFILE (it's the keychain that holds the profile), but ${listNames(apiKeyVars)} ${apiKeyVars.length > 1 ? 'are' : 'is'} set instead.`
        : "GAMESHIPPER_NOTARY_KEYCHAIN is set without GAMESHIPPER_NOTARY_PROFILE: it's the keychain that holds the profile.",
      apiKeyVars.length ? ONE_LOGIN_FIX : SETUP_FIX,
    );
  }

  const wantsNotary = Boolean(profile || apiKeyVars.length);
  if (!identity && !wantsNotary) return { credentials: null, error: null };
  if (!identity || identity === '-') {
    return invalid('Notarizing needs a Developer ID signature, but GAMESHIPPER_MAC_IDENTITY is not set to a Developer ID identity.');
  }
  let notary: NotaryAuth | null = null;
  if (profile) {
    notary = { kind: 'keychain-profile', keychainProfile: profile, ...(keychain ? { keychain } : {}) };
  } else if (apiKeyVars.length) {
    if (!key || !keyId) return invalid('An App Store Connect API key needs both GAMESHIPPER_NOTARY_KEY and GAMESHIPPER_NOTARY_KEY_ID.');
    // The key's own text pasted in: never repeat it (results and logs get shared).
    if (/[\r\n]|BEGIN/.test(key)) {
      return invalid('GAMESHIPPER_NOTARY_KEY holds the private key itself; it must be the path to the .p8 file.', KEY_FILE_FIX);
    }
    if (!fileExists(key)) return invalid(`GAMESHIPPER_NOTARY_KEY points at ${key}, which doesn't exist.`, KEY_FILE_FIX);
    notary = { kind: 'api-key', appleApiKey: key, appleApiKeyId: keyId, ...(issuer ? { appleApiIssuer: issuer } : {}) };
  }
  return { credentials: { identity, notary }, error: null };
}
