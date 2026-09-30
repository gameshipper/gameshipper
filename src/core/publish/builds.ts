import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBuilds } from '../check/review.js';
import type { Config, DesktopTarget } from '../config/schema.js';
import { gsError, type GsError } from '../result.js';

export interface DesktopBuild {
  target: DesktopTarget;
  /** out/<target> */
  dir: string;
  /** What a player runs: the .exe, the binary inside the .app, or the Linux binary. */
  executable: string;
}

const relPosix = (from: string, to: string) => path.relative(from, to).split(path.sep).join('/');

/**
 * The desktop builds publish uploads. Every desktop target in gameshipper.json must be built: a Steam build without
 * one OS's depot would break that OS's players. Errors are BUILD_MISSING.
 */
export function findDesktopBuilds(projectDir: string, config: Config): { builds: DesktopBuild[]; errors: GsError[] } {
  const found = findBuilds(projectDir, config);
  if (!found.length) {
    return { builds: [], errors: [gsError('BUILD_MISSING', 'There are no desktop targets to publish.', 'Add "windows", "mac" or "linux" to targets in gameshipper.json, then build.')] };
  }
  const errors = found
    .filter((b) => !b.built)
    .map((b) =>
      gsError(
        'BUILD_MISSING',
        `No ${b.target} build to publish: ${relPosix(projectDir, b.executable)} doesn't exist.`,
        `Run \`npx gameshipper build\` first, or remove "${b.target}" from targets in gameshipper.json.`,
      ),
    );
  return { builds: found.filter((b) => b.built).map(({ target, dir, executable }) => ({ target, dir, executable })), errors };
}

export interface MobileNextSteps {
  target: 'ios' | 'android';
  steps: string[];
}

/** iOS and Android aren't uploaded: publish says what to do in Xcode and Android Studio instead. */
export function mobileNextSteps(projectDir: string, config: Config): MobileNextSteps[] {
  const built = (target: string) => fs.existsSync(path.join(projectDir, 'out', target));
  const out: MobileNextSteps[] = [];
  if (config.targets.includes('ios')) {
    out.push({
      target: 'ios',
      steps: [
        ...(built('ios') ? [] : ['Make the Xcode project first: `npx gameshipper build --target ios`.']),
        'On a Mac, open out/ios/App/App.xcodeproj in Xcode and pick your signing team.',
        'Choose Product → Archive, then Distribute App → App Store Connect.',
        'Finish the listing in App Store Connect and submit the build for review.',
      ],
    });
  }
  if (config.targets.includes('android')) {
    out.push({
      target: 'android',
      steps: [
        ...(built('android') ? [] : ['Make the Android Studio project first: `npx gameshipper build --target android`.']),
        'Open out/android in Android Studio.',
        'Choose Build → Generate Signed App Bundle, with a new or existing upload key.',
        'Upload the .aab in the Google Play Console, to a testing track first.',
      ],
    });
  }
  return out;
}
