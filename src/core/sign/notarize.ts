import { notarize, type NotaryToolCredentials } from '@electron/notarize';
import type { Ctx } from '../context.js';
import { runTool, type ToolRunner } from '../proc.js';
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

/** How many times the ticket is stapled before STAPLE_FAILED, and how long Gameshipper waits between tries. */
export const STAPLE_ATTEMPTS = 3;
export const STAPLE_RETRY_DELAY_MS = 5000;

/** A tool's last non-empty output lines, without stapler's "Processing: <path>" line, for an error message. */
function lastLines(output: string, count: number): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Processing:/.test(l));
  return lines.slice(-count).join(' ');
}

/** Everything after @electron/notarize's own first line ("Failed to …"): the tool's output. */
const toolOutput = (message: string) => message.replace(/^[^\n]*\n?/, '');

/** Turns an @electron/notarize error (or Gameshipper's own staple failure) into a stable Gameshipper error. */
export function notarizeFailure(message: string, logPath: string, appPath: string, auth: NotaryAuth): GsFailure {
  if (/notarytool is not available/.test(message)) {
    return new GsFailure('NOTARIZE_TOOL_MISSING', "Apple's notarytool isn't installed.", 'Install Xcode (or run `xcode-select --install`), then build again.');
  }
  if (/^Failed to staple/.test(message)) {
    const why = lastLines(toolOutput(message), 2);
    return new GsFailure(
      'STAPLE_FAILED',
      `Apple notarized the app, but attaching the ticket to it failed ${STAPLE_ATTEMPTS} tries in a row${why ? `: ${why}` : '.'}`,
      `Wait a few minutes, then run \`xcrun stapler staple "${appPath}"\`. Details: ${logPath}.`,
    );
  }
  if (/Failed to (codesign|display codesign info)/.test(message)) {
    return new GsFailure('MAC_SIGN_FAILED', "The Mac app's signature is invalid, so it wasn't sent to Apple.", `The codesign output is in ${logPath}.`);
  }
  if (/^Failed to zip application/.test(message)) {
    const why = lastLines(toolOutput(message), 1);
    return new GsFailure(
      'NOTARIZE_FAILED',
      `Couldn't zip the Mac app to send it to Apple${why ? `: ${why}` : '.'}`,
      `Check that the disk has room for a copy of the app, then build again. ditto's output is in ${logPath}.`,
    );
  }
  const id = /"id"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  const status = /"status"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  if (!status) {
    // No verdict: notarytool answered in plain text because it couldn't log in, reach Apple, or run at all.
    return new GsFailure(
      'NOTARIZE_FAILED',
      `notarytool stopped before Apple judged the Mac app: ${lastLines(toolOutput(message), 1) || 'it gave no reason'}`,
      `This is usually the notarytool login (a wrong or expired app-specific password, a revoked API key, a profile that isn't in this keychain) or the network, not the app. Check the login with \`xcrun notarytool history ${authFlags(auth)}\`, then build again. The full output is in ${logPath}.`,
    );
  }
  return new GsFailure(
    'NOTARIZE_FAILED',
    `Apple didn't notarize the Mac app (status: ${status}).`,
    `Apple's report is in ${logPath}${id ? `; fetch it again with \`xcrun notarytool log ${id} ${authFlags(auth)}\`` : ''}. Fix what it lists (often an unsigned file inside the app), then build again.`,
  );
}

export interface NotarizeOptions {
  /** Injectable for tests: the pause between staple attempts. */
  wait?: (ms: number) => Promise<void>;
  /** Injectable for tests: runs `xcrun stapler`. */
  run?: ToolRunner;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Staples again after @electron/notarize's single try failed (its retry never fires): a new ticket can take a
 * moment to reach Apple's servers. Returns every attempt's failure, or null once one works.
 */
async function retryStaple(ctx: Ctx, appPath: string, firstFailure: string, opts: NotarizeOptions): Promise<string[] | null> {
  const failures = [firstFailure];
  for (let attempt = 2; attempt <= STAPLE_ATTEMPTS; attempt++) {
    ctx.log(`stapling failed (try ${attempt - 1} of ${STAPLE_ATTEMPTS}); trying again in ${STAPLE_RETRY_DELAY_MS / 1000} s`);
    await (opts.wait ?? sleep)(STAPLE_RETRY_DELAY_MS);
    const r = await (opts.run ?? runTool)('xcrun', ['stapler', 'staple', '-v', appPath]);
    if (r.code === 0) return null;
    failures.push(`Failed to staple your application with code: ${r.code}\n\n${r.output}`);
  }
  return failures;
}

/**
 * Uploads a signed .app to Apple, waits for the verdict, and staples the ticket (up to STAPLE_ATTEMPTS tries,
 * STAPLE_RETRY_DELAY_MS apart). Throws NOTARIZE_FAILED, NOTARIZE_TOOL_MISSING, STAPLE_FAILED or MAC_SIGN_FAILED
 * with a log path.
 */
export async function notarizeMacApp(ctx: Ctx, appPath: string, auth: NotaryAuth, opts: NotarizeOptions = {}): Promise<void> {
  ctx.log(`notarizing ${appPath} (usually takes a few minutes)`);
  let failures: string[];
  try {
    await notarize({ appPath, ...notaryCredentials(auth) });
    failures = [];
  } catch (e) {
    failures = [e instanceof Error ? e.message : String(e)];
  }
  if (failures.length && /^Failed to staple/.test(failures[0])) failures = (await retryStaple(ctx, appPath, failures[0], opts)) ?? [];
  if (!failures.length) {
    ctx.log(`notarized and stapled ${appPath}`);
    return;
  }
  const all = failures.join('\n\n');
  ctx.log(`notarization failed: ${all}`);
  throw notarizeFailure(failures[failures.length - 1], writeToolLog(ctx, 'notarize', all), appPath, auth);
}
