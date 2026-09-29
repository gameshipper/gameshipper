import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/schema.js';
import { buildNumber } from './bundle-id.js';
import { keepGeneratedFiles, replaceOrFail } from './template.js';

const ORIENTATION = { landscape: 'sensorLandscape', portrait: 'portrait' } as const;

const GENERATED = [
  'capacitor-cordova-android-plugins',
  'app/src/main/assets/public',
  'app/src/main/assets/capacitor.config.json',
  'app/src/main/assets/capacitor.plugins.json',
  'app/src/main/res/xml/config.xml',
];

/** Version, versionCode and screen orientation. */
export function configureAndroid(androidDir: string, config: Config): void {
  const manifestFile = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  const manifest = replaceOrFail(
    fs.readFileSync(manifestFile, 'utf8'),
    /(\s*)android:name="\.MainActivity"/,
    `$1android:name=".MainActivity"$1android:screenOrientation="${ORIENTATION[config.mobile.orientation]}"`,
    'AndroidManifest.xml has no .MainActivity',
  );
  fs.writeFileSync(manifestFile, manifest);

  const gradleFile = path.join(androidDir, 'app', 'build.gradle');
  let gradle = fs.readFileSync(gradleFile, 'utf8');
  gradle = replaceOrFail(gradle, /versionCode \d+/, `versionCode ${buildNumber(config.version)}`, 'app/build.gradle has no versionCode');
  gradle = replaceOrFail(gradle, /versionName "[^"]*"/, `versionName "${config.version}"`, 'app/build.gradle has no versionName');
  fs.writeFileSync(gradleFile, gradle);

  const gitignore = path.join(androidDir, '.gitignore');
  if (fs.existsSync(gitignore)) fs.writeFileSync(gitignore, `${keepGeneratedFiles(fs.readFileSync(gitignore, 'utf8'), GENERATED).trimEnd()}\n${KEEP_GAME_FILES}`);
}

/**
 * Capacitor's .gitignore ignores build/, bin/, gen/, out/ and *.log wherever they are, which would drop game files
 * such as three.js's build/ folder. Last, so it wins: every file and folder of the game is kept.
 */
const KEEP_GAME_FILES = `
# Gameshipper: the game's own files, whatever they're called
!/app/src/main/assets/public/**
`;
