import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';
import type { DesktopTarget } from '../config/schema.js';

export interface CodeScan {
  /** Game files (relative to the game folder) that use the gamepad API. */
  gamepad: string[];
  /** Game files that create text fields. */
  textInputs: string[];
  /** Code files left out as engine or library code (LIBRARY_FILE, ENGINE_FILE, MAX_BYTES), sorted. CDN files aren't listed. */
  skipped: string[];
}

const CODE_FILE = /\.(html?|m?js)$/i;
/** Files Gameshipper bundled from CDNs (core/prepare/remote.ts VENDOR_ROOT): never the game's own code. */
const BUNDLED = /^_gameshipper\//;
/** Engine and library code mentions gamepads whether or not the game uses them: node_modules and minified files. */
const LIBRARY_FILE = /(^|\/)node_modules\/|\.min\.m?js$/i;
/**
 * An engine's own distribution files (phaser.js, three.module.js, three.core.js, babylon.max.js, pixi.mjs), not the
 * game's code named after it (three-scene.js, main.three.js, three_utils.js). Matched against the file name.
 */
const ENGINE_FILE = /^(phaser|three|babylon|pixi)(\.min)?(\.module)?(\.[\w-]+)?\.m?js$/i;
/** Bigger files are usually an engine, or a bundle with one inside. */
const MAX_BYTES = 1024 * 1024;

/** How the scan tells the game's own code from engine and library code; the deck.gamepad check shows it. */
export const SCAN_HEURISTIC =
  "Only the game's own code was searched. Engine and library code mentions gamepads whether or not the game uses them, so bundled CDN files, node_modules, *.min.js files, files over 1 MB and an engine's own files (like phaser.js, three.module.js, babylon.js or pixi.mjs) were skipped.";
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
  const scan: CodeScan = { gamepad: [], textInputs: [], skipped: [] };
  // listPackage gives "/game/js/main.js" (with the OS's separators); extractFile wants "game/js/main.js".
  const entries = listPackage(asarFile, { isPack: false }).map((p) => p.replace(/\\/g, '/').replace(/^\//, ''));
  for (const entry of entries) {
    if (!entry.startsWith('game/') || !CODE_FILE.test(entry)) continue;
    const rel = entry.slice('game/'.length);
    if (BUNDLED.test(rel)) continue;
    const inArchive = entry.split('/').join(path.sep);
    const stat = statFile(asarFile, inArchive) as { size?: number };
    // A folder named like a code file.
    if (typeof stat.size !== 'number') continue;
    if (LIBRARY_FILE.test(rel) || ENGINE_FILE.test(path.posix.basename(rel)) || stat.size > MAX_BYTES) {
      scan.skipped.push(rel);
      continue;
    }
    const text = extractFile(asarFile, inArchive).toString('utf8');
    if (GAMEPAD.test(text)) scan.gamepad.push(rel);
    if (TEXT_INPUT.test(text)) scan.textInputs.push(rel);
  }
  scan.skipped.sort();
  return scan;
}
