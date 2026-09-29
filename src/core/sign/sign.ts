import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { sign } from '@electron/osx-sign';
import type { Ctx } from '../context.js';
import { createRunLog } from '../log.js';
import { GsFailure } from '../result.js';
import { isMainCode, writeEntitlementFiles } from './entitlements.js';

const run = promisify(execFile);

export interface SigningIdentity {
  /** The certificate's SHA-1, which codesign accepts even when two certificates share a name. */
  hash: string;
  /** e.g. "Developer ID Application: Jane Doe (TEAM123456)" */
  name: string;
}

/** Parses `security find-identity -v -p codesigning` output. */
export function parseIdentities(output: string): SigningIdentity[] {
  const found: SigningIdentity[] = [];
  for (const m of output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)) found.push({ hash: m[1], name: m[2] });
  return found;
}

/** Finds the configured identity by exact name, SHA-1 hash, or unique name prefix. */
export function matchIdentity(wanted: string, identities: SigningIdentity[]): SigningIdentity | null {
  const upper = wanted.toUpperCase();
  const exact = identities.find((i) => i.name === wanted || i.hash === upper);
  if (exact) return exact;
  const prefix = identities.filter((i) => i.name.startsWith(wanted));
  return prefix.length === 1 ? prefix[0] : null;
}

const IDENTITY_FIX =
  'Install your "Developer ID Application" certificate (Xcode → Settings → Accounts → Manage Certificates), then set GAMESHIPPER_MAC_IDENTITY to the exact name shown by `security find-identity -v -p codesigning`.';

/** The valid code-signing identities in the keychain search list. Throws MAC_IDENTITY_NOT_FOUND when they can't be read. */
export async function listSigningIdentities(): Promise<SigningIdentity[]> {
  try {
    const { stdout } = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
    return parseIdentities(stdout);
  } catch (e) {
    throw new GsFailure('MAC_IDENTITY_NOT_FOUND', `Couldn't read the signing identities in your keychain: ${e instanceof Error ? e.message : String(e)}`, IDENTITY_FIX);
  }
}

/** Apple's certificate types, the part of an identity's name before the colon. */
const CERTIFICATE_TYPES = [
  'Developer ID Application',
  'Developer ID Installer',
  'Apple Development',
  'Apple Distribution',
  'Mac Developer',
  'Mac App Distribution',
  '3rd Party Mac Developer Application',
  '3rd Party Mac Developer Installer',
  'iPhone Developer',
  'iPhone Distribution',
];

/** An identity's certificate type, or "other"; never the rest of its name (a person's name or email). */
function certificateType(identity: SigningIdentity): string {
  return CERTIFICATE_TYPES.find((type) => identity.name.startsWith(`${type}:`)) ?? 'other';
}

/**
 * The keychain identity GAMESHIPPER_MAC_IDENTITY names. Throws MAC_IDENTITY_NOT_FOUND, which only counts the
 * identities that are there by type: their names hold people's names and emails, and results get shared.
 */
export async function findSigningIdentity(wanted: string, list: () => Promise<SigningIdentity[]> = listSigningIdentities): Promise<SigningIdentity> {
  const identities = await list();
  const match = matchIdentity(wanted, identities);
  if (match) return match;
  const types = [...new Set(identities.map(certificateType))];
  const found = identities.length
    ? `found ${identities.length} signing identit${identities.length === 1 ? 'y' : 'ies'} (${types.join(', ')}); none match`
    : 'found no signing identities';
  throw new GsFailure('MAC_IDENTITY_NOT_FOUND', `No signing identity in your keychain matches GAMESHIPPER_MAC_IDENTITY (${found}).`, IDENTITY_FIX);
}

/** Writes a tool's output to .gameshipper/logs/<tool>-<time>.log and returns the path. */
export function writeToolLog(ctx: Ctx, tool: string, text: string): string {
  const log = createRunLog(ctx.projectDir, tool);
  log.write(text);
  return log.path;
}

/**
 * Signs a Mac .app with the hardened runtime and Steam-compatible entitlements: the bundle, its helper apps,
 * frameworks and every native file in it (koffi.node, steam-overlay.node, libsteam_api.dylib). osx-sign then
 * runs `codesign --verify --deep --strict`. `identity` null signs ad-hoc (no Apple account: runs on this Mac,
 * can't be notarized). Throws MAC_SIGN_FAILED.
 */
export async function signMacApp(ctx: Ctx, appPath: string, identity: SigningIdentity | null): Promise<void> {
  const files = writeEntitlementFiles(path.join(ctx.projectDir, '.gameshipper', 'sign'));
  // By SHA-1: the identity's name holds a person's legal name, and run logs get shared.
  ctx.log(`signing ${appPath} ${identity ? `with the identity ${identity.hash}` : 'ad-hoc'} (hardened runtime)`);
  try {
    await sign({
      app: appPath,
      identity: identity?.hash ?? '-',
      platform: 'darwin',
      identityValidation: false,
      // Otherwise osx-sign embeds any .provisionprofile it finds in the current folder.
      preEmbedProvisioningProfile: false,
      preAutoEntitlements: false,
      optionsForFile: (file) => ({
        hardenedRuntime: true,
        entitlements: isMainCode(file, appPath) ? files.main : files.helper,
        // Apple's timestamp server only accepts Developer ID signatures.
        ...(identity ? {} : { timestamp: 'none' }),
      }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const logPath = writeToolLog(ctx, 'codesign', message);
    // "Command failed: codesign …" comes first; codesign's reason is its last line.
    const reason = message.trim().split('\n').pop();
    throw new GsFailure(
      'MAC_SIGN_FAILED',
      `Signing the Mac app failed: ${reason}`,
      `The full codesign output is in ${logPath}. If macOS asked for keychain access, click "Always Allow" and build again.`,
    );
  }
  ctx.log(`signed ${appPath}`);
}
