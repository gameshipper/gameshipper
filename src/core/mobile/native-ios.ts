import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/schema.js';
import { buildNumber } from './bundle-id.js';
import { keepGeneratedFiles, replaceOrFail } from './template.js';

/** Import maps (used by most CDN-based web games, and still there after CDN bundling) need WKWebView 16.4. */
export const IOS_DEPLOYMENT_TARGET = '16.4';

const ORIENTATIONS = {
  landscape: {
    iphone: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
    ipad: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  },
  portrait: {
    iphone: ['UIInterfaceOrientationPortrait'],
    ipad: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'],
  },
} as const;

const GENERATED = ['App/App/public', 'capacitor-cordova-ios-plugins', 'App/App/capacitor.config.json', 'App/App/config.xml'];

const pbxprojPath = (iosDir: string) => path.join(iosDir, 'App', 'App.xcodeproj', 'project.pbxproj');

/** The signing team the user picked in Xcode last time, so rebuilding doesn't lose it. */
export function readDevelopmentTeam(iosDir: string): string | null {
  const file = pbxprojPath(iosDir);
  if (!fs.existsSync(file)) return null;
  return /DEVELOPMENT_TEAM = ([A-Z0-9]+);/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null;
}

function plistArray(plist: string, key: string, values: readonly string[]): string {
  const re = new RegExp(`(<key>${key}</key>\\s*<array>)[\\s\\S]*?(</array>)`);
  const items = values.map((v) => `\n\t\t<string>${v}</string>`).join('');
  return replaceOrFail(plist, re, `$1${items}\n\t$2`, `Info.plist has no ${key} array`);
}

/** Version, build number, deployment target, orientation, full screen and the saved signing team. */
export function configureIos(iosDir: string, config: Config, developmentTeam: string | null): void {
  const plistFile = path.join(iosDir, 'App', 'App', 'Info.plist');
  const o = ORIENTATIONS[config.mobile.orientation];
  let plist = fs.readFileSync(plistFile, 'utf8');
  plist = plistArray(plist, 'UISupportedInterfaceOrientations', o.iphone);
  plist = plistArray(plist, 'UISupportedInterfaceOrientations~ipad', o.ipad);
  if (!plist.includes('<key>UIRequiresFullScreen</key>')) {
    plist = replaceOrFail(plist, /<\/dict>\s*<\/plist>\s*$/, '\t<key>UIRequiresFullScreen</key>\n\t<true/>\n</dict>\n</plist>\n', 'Info.plist has no closing </dict>');
  }
  fs.writeFileSync(plistFile, plist);

  const pbxFile = pbxprojPath(iosDir);
  let pbx = fs.readFileSync(pbxFile, 'utf8');
  pbx = replaceOrFail(pbx, /MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${config.version};`, 'no MARKETING_VERSION');
  pbx = replaceOrFail(pbx, /CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber(config.version)};`, 'no CURRENT_PROJECT_VERSION');
  pbx = replaceOrFail(pbx, /IPHONEOS_DEPLOYMENT_TARGET = [^;]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`, 'no IPHONEOS_DEPLOYMENT_TARGET');
  if (developmentTeam) {
    pbx = replaceOrFail(pbx, /(\t+)CODE_SIGN_STYLE = Automatic;/g, `$1CODE_SIGN_STYLE = Automatic;\n$1DEVELOPMENT_TEAM = ${developmentTeam};`, 'no CODE_SIGN_STYLE');
  }
  fs.writeFileSync(pbxFile, pbx);

  const gitignore = path.join(iosDir, '.gitignore');
  if (fs.existsSync(gitignore)) fs.writeFileSync(gitignore, keepGeneratedFiles(fs.readFileSync(gitignore, 'utf8'), GENERATED));
}
