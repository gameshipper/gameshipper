import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';
import type { DesktopTarget } from '../config/schema.js';

export interface CodeScan {
  /** Game files (relative to the game folder) that use the gamepad API. */
  gamepad: string[];
  /** Game files that create text fields. */
  textInputs: string[];
}

const CODE_FILE = /\.(html?|m?js)$/i;
/** Bundled CDN files and minified libraries mention gamepads whether or not the game uses them. */
const SKIPPED = /^_gameshipper\/|\.min\.m?js$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const GAMEPAD = /getGamepads|gamepadconnected/;
const TEXT_INPUT =
  /<input\b(?![^>]*\btype\s*=\s*["']?(?:hidden|button|submit|reset|checkbox|radio|range|color|file|image)\b)|<textarea\b|contenteditable|createElement\(\s*["'`](?:input|textarea)["'`]\s*\)/i;

/** Where @electron/packager put the app (shell and game) inside a build. */
export function appAsarPath(target: DesktopTarget, executable: string, dir: string): string {
  return target === 'mac' ? path.join(path.dirname(path.dirname(executable)), 'Resources', 'app.asar') : path.join(dir, 'resources', 'app.asar');
}

/** Looks through the game's own code inside a build for gamepad use and text fields. null without an app.asar. */
export function scanBuildCode(asarFile: string): CodeScan | null {
  if (!fs.existsSync(asarFile)) return null;
  const scan: CodeScan = { gamepad: [], textInputs: [] };
  // listPackage gives "/game/js/main.js" (with the OS's separators); extractFile wants "game/js/main.js".
  const entries = listPackage(asarFile, { isPack: false }).map((p) => p.replace(/\\/g, '/').replace(/^\//, ''));
  for (const entry of entries) {
    if (!entry.startsWith('game/') || !CODE_FILE.test(entry)) continue;
    const rel = entry.slice('game/'.length);
    if (SKIPPED.test(rel)) continue;
    const inArchive = entry.split('/').join(path.sep);
    const stat = statFile(asarFile, inArchive) as { size?: number };
    if (typeof stat.size !== 'number' || stat.size > MAX_BYTES) continue;
    const text = extractFile(asarFile, inArchive).toString('utf8');
    if (GAMEPAD.test(text)) scan.gamepad.push(rel);
    if (TEXT_INPUT.test(text)) scan.textInputs.push(rel);
  }
  return scan;
}
