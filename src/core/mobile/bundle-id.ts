import { BUNDLE_ID_PATTERN, type Config } from '../config/schema.js';
import { gsError, type GsError } from '../result.js';

// Android turns the bundle ID into a Java package name, so no part may be a Java keyword.
const JAVA_KEYWORDS = new Set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while'.split(
    ' ',
  ),
);

/** Why iOS or Android can't use this bundle ID, or null when both can. */
export function bundleIdProblem(id: string): string | null {
  if (!BUNDLE_ID_PATTERN.test(id)) return `"${id}" must look like com.yourname.yourgame: dot-separated parts of letters and digits, each starting with a letter.`;
  if (/^com\.apple\./i.test(id)) return `"${id}" starts with com.apple., which Apple keeps for its own apps.`;
  const keyword = id.split('.').find((part) => JAVA_KEYWORDS.has(part));
  return keyword ? `"${id}" contains "${keyword}", a Java keyword, which Android can't use in a package name.` : null;
}

/** BUNDLE_ID_REQUIRED / BUNDLE_ID_INVALID, or null when mobile.bundleId works on iOS and Android. */
export function checkBundleId(config: Config): GsError | null {
  const id = config.mobile.bundleId;
  if (!id) {
    return gsError(
      'BUNDLE_ID_REQUIRED',
      'iOS and Android builds need a bundle ID: mobile.bundleId in gameshipper.json is not set.',
      'Add "mobile": { "bundleId": "com.yourname.yourgame" } to gameshipper.json (it can never change once the game is published; `init --bundle-id` sets it in new projects), or remove "ios" and "android" from "targets".',
    );
  }
  const problem = bundleIdProblem(id);
  return problem ? gsError('BUNDLE_ID_INVALID', `mobile.bundleId ${problem}`, 'Change mobile.bundleId in gameshipper.json (for a keyword, add to it: "newgame" instead of "new").') : null;
}

/** Store build number from the version: 1.2.3 → 1002003 (iOS CFBundleVersion and Android versionCode). */
export function buildNumber(version: string): number {
  const [major, minor, patch] = version.split('.').map(Number);
  return major * 1_000_000 + minor * 1_000 + patch;
}

/** The highest versionCode Google Play accepts. */
export const MAX_VERSION_CODE = 2_100_000_000;

/**
 * VERSION_UNSUPPORTED when buildNumber can't represent the version: a minor or patch of 1000 or more would give two
 * versions the same build number (1.1000.0 and 2.0.0), and a major of 2100 or more (past 2100.0.0) goes past
 * Google Play's limit. null when it fits.
 */
export function checkMobileVersion(config: Config): GsError | null {
  const [major, minor, patch] = config.version.split('.').map(Number);
  const why =
    minor >= 1000 || patch >= 1000
      ? 'its second and third numbers must be below 1000'
      : buildNumber(config.version) > MAX_VERSION_CODE
        ? `its build number ${buildNumber(config.version)} is past Google Play's limit of ${MAX_VERSION_CODE}`
        : null;
  if (!why) return null;
  return gsError(
    'VERSION_UNSUPPORTED',
    `version ${config.version} can't be an iOS and Android build number: ${why}.`,
    `Set "version" in gameshipper.json to one like 1.2.3 (major below 2100, minor and patch below 1000): the build number is major × 1,000,000 + minor × 1,000 + patch, so 1.2.3 becomes 1002003. It must only ever go up once the game is in a store.`,
  );
}

/** Why iOS and Android can't be built with this config (BUNDLE_ID_REQUIRED, BUNDLE_ID_INVALID, VERSION_UNSUPPORTED), or null. */
export function mobileConfigError(config: Config): GsError | null {
  return checkBundleId(config) ?? checkMobileVersion(config);
}
