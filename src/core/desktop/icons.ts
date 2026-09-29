import * as fs from 'node:fs';
import * as path from 'node:path';
import png2icons from 'png2icons';
import { GsFailure } from '../result.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Converts the game's PNG icon into icon.icns (macOS), icon.ico (Windows) and icon.png (Linux)
 * in outDir. Returns the path without extension, which is what @electron/packager's `icon` expects.
 */
export function makeIcons(iconPath: string, outDir: string): string {
  const buf = fs.readFileSync(iconPath);
  const size = pngSize(buf);
  if (!size) throw new GsFailure('ICON_INVALID', `${iconPath} isn't a PNG file.`, 'Export your icon as a PNG, at least 1024x1024.');
  if (size.width !== size.height || size.width < 1024) {
    throw new GsFailure(
      'ICON_TOO_SMALL',
      `The icon is ${size.width}x${size.height}; it must be square and at least 1024x1024.`,
      'Export a square PNG at 1024x1024 or larger and point "icon" in gameshipper.json at it.',
    );
  }
  const icns = png2icons.createICNS(buf, png2icons.BICUBIC, 0);
  const ico = png2icons.createICO(buf, png2icons.BICUBIC, 0, false, true);
  if (!icns || !ico) {
    throw new GsFailure('ICON_CONVERT_FAILED', `Couldn't convert ${iconPath} to .icns/.ico.`, 'Re-export the PNG from an image editor and try again.');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, 'icon');
  fs.writeFileSync(`${base}.icns`, icns);
  fs.writeFileSync(`${base}.ico`, ico);
  fs.copyFileSync(iconPath, `${base}.png`);
  return base;
}
