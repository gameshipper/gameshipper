import { notarize, type NotaryToolCredentials } from '@electron/notarize';
import type { Ctx } from '../context.js';
import { GsFailure } from '../result.js';
import type { NotaryAuth } from './credentials.js';
import { writeToolLog } from './sign.js';

export function notaryCredentials(auth: NotaryAuth): NotaryToolCredentials {
  if (auth.kind === 'keychain-profile') {
    return { keychainProfile: auth.keychainProfile, ...(auth.keychain ? { keychain: auth.keychain } : {}) };
  }
  return { appleApiKey: auth.appleApiKey, appleApiKeyId: auth.appleApiKeyId, ...(auth.appleApiIssuer ? { appleApiIssuer: auth.appleApiIssuer } : {}) };
}

/**
 * notarytool's login flags for a command in a fix, naming the variables rather than their values: key paths, key
 * IDs and issuers identify an account, and results get shared.
 */
function authFlags(auth: NotaryAuth): string {
  if (auth.kind === 'keychain-profile') {
    return `--keychain-profile "$GAMESHIPPER_NOTARY_PROFILE"${auth.keychain ? ' --keychain "$GAMESHIPPER_NOTARY_KEYCHAIN"' : ''}`;
  }
  return `--key "$GAMESHIPPER_NOTARY_KEY" --key-id "$GAMESHIPPER_NOTARY_KEY_ID"${auth.appleApiIssuer ? ' --issuer "$GAMESHIPPER_NOTARY_ISSUER"' : ''}`;
}

/** Turns an @electron/notarize error into a stable Gameshipper error. */
export function notarizeFailure(message: string, logPath: string, appPath: string, auth: NotaryAuth): GsFailure {
  const first = message.split('\n')[0];
  if (/notarytool is not available/.test(message)) {
    return new GsFailure('NOTARIZE_TOOL_MISSING', "Apple's notarytool isn't installed.", 'Install Xcode (or run `xcode-select --install`), then build again.');
  }
  if (/Failed to staple/.test(message)) {
    return new GsFailure(
      'STAPLE_FAILED',
      'Apple notarized the app, but attaching the ticket to it failed.',
      `Wait a few minutes, then run \`xcrun stapler staple "${appPath}"\`. Details: ${logPath}.`,
    );
  }
  if (/Failed to (codesign|display codesign info)/.test(message)) {
    return new GsFailure('MAC_SIGN_FAILED', "The Mac app's signature is invalid, so it wasn't sent to Apple.", `The codesign output is in ${logPath}.`);
  }
  const id = /"id"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  const status = /"status"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  return new GsFailure(
    'NOTARIZE_FAILED',
    `Apple didn't notarize the Mac app${status ? ` (status: ${status})` : ''}: ${first}`,
    `Apple's report is in ${logPath}${id ? `; fetch it again with \`xcrun notarytool log ${id} ${authFlags(auth)}\`` : ''}. Fix what it lists (often an unsigned file inside the app), then build again.`,
  );
}

/**
 * Uploads a signed .app to Apple, waits for the verdict, and staples the ticket.
 * Throws NOTARIZE_FAILED, NOTARIZE_TOOL_MISSING, STAPLE_FAILED or MAC_SIGN_FAILED with a log path.
 */
export async function notarizeMacApp(ctx: Ctx, appPath: string, auth: NotaryAuth): Promise<void> {
  ctx.log(`notarizing ${appPath} (usually takes a few minutes)`);
  try {
    await notarize({ appPath, ...notaryCredentials(auth) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.log(`notarization failed: ${message}`);
    throw notarizeFailure(message, writeToolLog(ctx, 'notarize', message), appPath, auth);
  }
  ctx.log(`notarized and stapled ${appPath}`);
}
