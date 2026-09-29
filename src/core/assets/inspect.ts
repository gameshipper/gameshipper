import * as path from 'node:path';
import { GsFailure } from '../result.js';
import { loadSharp } from './sharp.js';
import { MIN_KEY_ART, type Size } from './sizes.js';

export interface ImageInfo extends Size {
  /** sharp's format name: 'png', 'jpeg', 'webp', ... */
  format: string;
}

export interface LogoInfo extends ImageInfo {
  /** Size once transparent margins are trimmed away. */
  trimmed: Size;
}

export interface FrameInfo extends Size {
  /** true when every pixel is (nearly) one colour: the game drew nothing. */
  blank: boolean;
  /** Average colour as #rrggbb. */
  color: string;
}

/** Largest per-channel spread (0-255) that still counts as a blank, single-colour frame. */
export const BLANK_SPREAD = 8;

/** Size (after EXIF rotation) and format of an image, or null if sharp can't read it. */
export async function imageInfo(file: string): Promise<ImageInfo | null> {
  const sharp = await loadSharp();
  try {
    const meta = await sharp(file).metadata();
    return { width: meta.autoOrient.width, height: meta.autoOrient.height, format: meta.format };
  } catch {
    return null;
  }
}

export async function inspectKeyArt(file: string): Promise<ImageInfo> {
  const info = await imageInfo(file);
  const name = path.basename(file);
  if (!info) {
    throw new GsFailure(
      'KEYART_INVALID',
      `keyArt ${name} isn't an image Gameshipper can read.`,
      'Export the key art as a PNG or JPEG (3840x2160 recommended) and point "keyArt" in gameshipper.json at it.',
    );
  }
  if (info.width < MIN_KEY_ART.width || info.height < MIN_KEY_ART.height) {
    throw new GsFailure(
      'KEYART_TOO_SMALL',
      `keyArt ${name} is ${info.width}x${info.height}; it must be at least ${MIN_KEY_ART.width}x${MIN_KEY_ART.height}.`,
      'Export the key art at 3840x2160 (the library hero image is 3840 pixels wide).',
    );
  }
  return info;
}

export async function inspectLogo(file: string): Promise<LogoInfo> {
  const sharp = await loadSharp();
  const info = await imageInfo(file);
  const name = path.basename(file);
  if (!info || info.format !== 'png') {
    throw new GsFailure(
      'LOGO_INVALID',
      `logo ${name} isn't a PNG file.`,
      'Export the logo as a PNG with a transparent background and point "logo" in gameshipper.json at it.',
    );
  }
  // sharp says hasAlpha for an RGBA PNG with no transparent pixel; isOpaque looks at the pixels.
  if ((await sharp(file).stats()).isOpaque) {
    throw new GsFailure(
      'LOGO_NOT_TRANSPARENT',
      `logo ${name} has no transparent pixels, so it would sit on the art as a solid box.`,
      'Re-export the logo as a PNG with a transparent background (nothing behind the lettering).',
    );
  }
  const { info: trimmed } = await sharp(file).trim().toBuffer({ resolveWithObject: true });
  return { ...info, trimmed: { width: trimmed.width, height: trimmed.height } };
}

/** Is a captured frame blank? `check` asks this of the game's last frame. */
export async function frameInfo(file: string): Promise<FrameInfo> {
  const sharp = await loadSharp();
  const [meta, stats] = await Promise.all([sharp(file).metadata(), sharp(file).stats()]);
  const rgb = stats.channels.slice(0, 3);
  return {
    width: meta.width,
    height: meta.height,
    blank: rgb.every((c) => c.max - c.min <= BLANK_SPREAD),
    color: `#${rgb.map((c) => Math.round(c.mean).toString(16).padStart(2, '0')).join('')}`,
  };
}
