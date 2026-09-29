import type { Config } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { defaultBundleId } from '../names.js';
import { GsFailure, gsError, type GsError } from '../result.js';
import { readAppleCredentials, type NotaryAuth } from './credentials.js';
import { notarizeMacApp } from './notarize.js';
import { findSigningIdentity, signMacApp, type SigningIdentity } from './sign.js';

/** How a build's Mac app will be signed; decided before anything is built. */
export type MacSigningPlan =
  | { kind: 'other-host' }
  | { kind: 'adhoc' }
  | { kind: 'developer-id'; identity: SigningIdentity; notary: NotaryAuth | null };

/** In the build result: data.targets[i].output.mac */
export interface MacSigningInfo {
  signing: 'developer-id' | 'adhoc' | 'unsigned';
  notarized: boolean;
}

export interface MacSignResult extends MacSigningInfo {
  warnings: GsError[];
}

/**
 * Reads the Apple variables and finds the Developer ID in the keychain. `build` calls it before the game build,
 * so half-set variables (APPLE_CREDENTIALS_INVALID) or a certificate that isn't installed
 * (MAC_IDENTITY_NOT_FOUND) stop it at once instead of after packaging.
 */
export async function planMacSigning(
  host: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  find: (wanted: string) => Promise<SigningIdentity> = findSigningIdentity,
): Promise<MacSigningPlan> {
  if (host !== 'darwin') return { kind: 'other-host' };
  const { credentials, error } = readAppleCredentials(env);
  if (error) throw new GsFailure(error.code, error.message, error.fix);
  if (!credentials) return { kind: 'adhoc' };
  return { kind: 'developer-id', identity: await find(credentials.identity), notary: credentials.notary };
}

export interface FinishMacDeps {
  /** The app bundles Steam (see signMacApp). */
  steam?: boolean;
  /** Injectable for tests. */
  sign?: typeof signMacApp;
  notarize?: typeof notarizeMacApp;
}

const HOW_TO_SIGN =
  'With a paid Apple Developer account, set GAMESHIPPER_MAC_IDENTITY and GAMESHIPPER_NOTARY_PROFILE, then build again on this Mac. `npx gameshipper help --json` lists the variables under "environment".';

/**
 * The last step of a Mac target (spec §7.3 step 6), after its afterPackage hooks: sign with the hardened runtime
 * (with Steam's entitlements when `deps.steam`), then notarize and staple when a notary login is set. Nothing may
 * change the .app afterwards. Throws GsFailure when Developer ID signing or notarization fails; ad-hoc trouble is a
 * warning.
 */
export async function finishMacApp(ctx: Ctx, config: Config, appPath: string, plan: MacSigningPlan, deps: FinishMacDeps = {}): Promise<MacSignResult> {
  const sign = deps.sign ?? signMacApp;
  const notarize = deps.notarize ?? notarizeMacApp;

  if (plan.kind === 'other-host') {
    return {
      signing: 'unsigned',
      notarized: false,
      warnings: [
        gsError(
          'MAC_SIGN_HOST',
          "Mac builds can only be signed on a Mac, so this one is unsigned and won't open on Apple Silicon Macs.",
          'Build the Mac version on a Mac (or with the GitHub Actions template) to sign and notarize it.',
        ),
      ],
    };
  }

  if (plan.kind === 'adhoc') {
    try {
      await sign(ctx, appPath, null, { steam: deps.steam });
    } catch (e) {
      const reason = e instanceof GsFailure ? e.error.message : e instanceof Error ? e.message : String(e);
      return {
        signing: 'unsigned',
        notarized: false,
        warnings: [
          gsError('MAC_ADHOC_SIGN_FAILED', `Couldn't ad-hoc sign the Mac app: ${reason}`, 'The app may show as damaged when opened from Finder; it still launches from Steam.'),
        ],
      };
    }
    return {
      signing: 'adhoc',
      notarized: false,
      warnings: [
        gsError('MAC_UNSIGNED', 'The Mac build is only ad-hoc signed: it runs on this Mac, but Steam requires Mac builds signed with a Developer ID and notarized.', HOW_TO_SIGN),
      ],
    };
  }

  await sign(ctx, appPath, plan.identity, { steam: deps.steam });
  const warnings: GsError[] = [];
  if (!config.mobile.bundleId) {
    warnings.push(
      gsError(
        'MAC_BUNDLE_ID_DEFAULT',
        `The Mac app uses the placeholder bundle ID ${defaultBundleId(config.name)}.`,
        'Set "mobile": { "bundleId": "com.yourname.yourgame" } in gameshipper.json before you ship: macOS identifies your game by it, and it can\'t change later.',
      ),
    );
  }
  if (!plan.notary) {
    warnings.push(
      gsError(
        'MAC_NOT_NOTARIZED',
        'The Mac build is signed but not notarized, so Steam will reject it.',
        'Create a notarytool profile once with `xcrun notarytool store-credentials <name>`, set GAMESHIPPER_NOTARY_PROFILE=<name>, and build again.',
      ),
    );
    return { signing: 'developer-id', notarized: false, warnings };
  }
  await notarize(ctx, appPath, plan.notary);
  return { signing: 'developer-id', notarized: true, warnings };
}
