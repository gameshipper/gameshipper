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
  if (fs.existsSync(gitignore)) fs.writeFileSync(gitignore, keepGeneratedFiles(fs.readFileSync(gitignore, 'utf8'), GENERATED));
}
