import * as fs from 'node:fs';
import * as path from 'node:path';
import png2icons from 'png2icons';
import { GsFailure } from '../result.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The PNG signature and the IHDR chunk up to the height: all pngSize reads. */
const HEADER_BYTES = 24;

/** Steam's library and store art need the icon to be square and at least this many pixels wide. */
export const MIN_ICON_SIZE = 1024;
/** What an icon must be, for messages. */
export const ICON_REQUIREMENT = `a square PNG of at least ${MIN_ICON_SIZE}x${MIN_ICON_SIZE}`;

export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < HEADER_BYTES || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export type IconProblemCode = 'ICON_INVALID' | 'ICON_NOT_SQUARE' | 'ICON_TOO_SMALL';

export interface IconProblem {
  code: IconProblemCode;
  /** What the file is, to follow its name: "isn't a PNG file", "is 512x512". */
  found: string;
}

/** Why `buf` can't be the game's icon, or null when it's a square PNG of at least MIN_ICON_SIZE. */
export function iconProblem(buf: Buffer): IconProblem | null {
  const size = pngSize(buf);
  if (!size) return { code: 'ICON_INVALID', found: "isn't a PNG file" };
  const found = `is ${size.width}x${size.height}`;
  if (size.width !== size.height) return { code: 'ICON_NOT_SQUARE', found };
  if (size.width < MIN_ICON_SIZE) return { code: 'ICON_TOO_SMALL', found };
  return null;
}

/** iconProblem for a file, reading only its header. A file that can't be read isn't a PNG. */
export function iconFileProblem(file: string): IconProblem | null {
  const header = Buffer.alloc(HEADER_BYTES);
  let length = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      length = fs.readSync(fd, header, 0, HEADER_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // A folder or an unreadable file: reported as not a PNG.
  }
  return iconProblem(header.subarray(0, length));
}

const ICON_FIX: Record<IconProblemCode, string> = {
  ICON_INVALID: `Export your icon as ${ICON_REQUIREMENT} and point "icon" in gameshipper.json at it.`,
  ICON_NOT_SQUARE: `Export ${ICON_REQUIREMENT} and point "icon" in gameshipper.json at it.`,
  ICON_TOO_SMALL: `Export ${ICON_REQUIREMENT} and point "icon" in gameshipper.json at it.`,
};

/**
 * Converts the game's PNG icon into icon.icns (macOS), icon.ico (Windows) and icon.png (Linux)
 * in outDir. Returns the path without extension, which is what @electron/packager's `icon` expects.
 * `name` is how messages refer to the icon (the path in gameshipper.json).
 */
export function makeIcons(iconPath: string, outDir: string, name: string = path.basename(iconPath)): string {
  const buf = fs.readFileSync(iconPath);
  const problem = iconProblem(buf);
  if (problem) {
    throw new GsFailure(problem.code, `${name} ${problem.found}; Steam needs ${ICON_REQUIREMENT}.`, ICON_FIX[problem.code]);
  }
  const icns = png2icons.createICNS(buf, png2icons.BICUBIC, 0);
  const ico = png2icons.createICO(buf, png2icons.BICUBIC, 0, false, true);
  if (!icns || !ico) {
    throw new GsFailure('ICON_CONVERT_FAILED', `Couldn't convert ${name} to .icns/.ico.`, 'Re-export the PNG from an image editor and try again.');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, 'icon');
  fs.writeFileSync(`${base}.icns`, icns);
  fs.writeFileSync(`${base}.ico`, ico);
  fs.copyFileSync(iconPath, `${base}.png`);
  return base;
}
