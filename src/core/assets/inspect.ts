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
  /** Mostly one colour and not clearly varied (isPlain): perhaps a loading screen. */
  plain: boolean;
  /** The frame's most common colour and its share (0-1) of the frame (see colourMix). */
  main: { share: number; color: string };
}

/** Largest per-channel spread (0-255) that still counts as a blank, single-colour frame. */
export const BLANK_SPREAD = 8;

/** A frame whose most common colour covers more than this share of it is mostly one colour. */
export const MOSTLY_ONE_COLOUR = 0.95;
/** Colours are grouped in steps of this many levels per channel, so antialiasing and faint shading join their colour. */
const COLOUR_STEP = 32;
/** A colour group counts as one of the frame's colours when it covers more than this share of it. */
const COLOUR_MIN_SHARE = 0.001;
/**
 * A mostly one-colour frame with this many other colours is still clearly varied: a small, detailed scene (a
 * spinning cube's faces on black), not a loading screen's background with its text or bar.
 */
const VARIED_COLOURS = 2;

export interface ColourMix {
  /** Share (0-1) of the frame in its most common colour group. */
  share: number;
  /** That group's average colour as #rrggbb. */
  color: string;
  /** How many other colour groups cover more than COLOUR_MIN_SHARE of the frame. */
  others: number;
}

const hex = (values: number[]): string => `#${values.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** How a frame's pixels (raw, `channels` bytes each; the first three are RGB) spread over colour groups. */
export function colourMix(pixels: Uint8Array, channels: number): ColourMix {
  const levels = 256 / COLOUR_STEP;
  const counts = new Uint32Array(levels ** 3);
  const sums = new Float64Array(levels ** 3 * 3);
  const total = Math.floor(pixels.length / channels);
  for (let i = 0; i < total * channels; i += channels) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const group = (Math.floor(r / COLOUR_STEP) * levels + Math.floor(g / COLOUR_STEP)) * levels + Math.floor(b / COLOUR_STEP);
    counts[group]++;
    sums[group * 3] += r;
    sums[group * 3 + 1] += g;
    sums[group * 3 + 2] += b;
  }
  let main = 0;
  for (let group = 1; group < counts.length; group++) if (counts[group] > counts[main]) main = group;
  let others = 0;
  for (let group = 0; group < counts.length; group++) if (group !== main && counts[group] > total * COLOUR_MIN_SHARE) others++;
  const n = counts[main] || 1;
  return {
    share: total ? counts[main] / total : 0,
    color: hex([sums[main * 3] / n, sums[main * 3 + 1] / n, sums[main * 3 + 2] / n]),
    others,
  };
}

/** Mostly one colour (over MOSTLY_ONE_COLOUR) and not clearly varied. */
export const isPlain = (mix: ColourMix): boolean => mix.share > MOSTLY_ONE_COLOUR && mix.others < VARIED_COLOURS;

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

const KEY_ART_FORMATS = new Set(['png', 'jpeg']);
const KEY_ART_FIX = 'Export the key art as a PNG or JPEG (3840x2160 recommended) and point "keyArt" in gameshipper.json at it.';

export async function inspectKeyArt(file: string): Promise<ImageInfo> {
  const info = await imageInfo(file);
  const name = path.basename(file);
  if (!info) throw new GsFailure('KEYART_INVALID', `keyArt ${name} isn't an image Gameshipper can read.`, KEY_ART_FIX);
  if (!KEY_ART_FORMATS.has(info.format)) {
    throw new GsFailure('KEYART_INVALID', `keyArt ${name} is a ${info.format.toUpperCase()} image; it must be PNG or JPEG.`, KEY_ART_FIX);
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
  const stats = await sharp(file).stats();
  if (stats.isOpaque) {
    throw new GsFailure(
      'LOGO_NOT_TRANSPARENT',
      `logo ${name} has no transparent pixels, so it would sit on the art as a solid box.`,
      'Re-export the logo as a PNG with a transparent background (nothing behind the lettering).',
    );
  }
  // Not opaque, so it has an alpha channel (the 4th, or the 2nd for grey + alpha).
  if (stats.channels[stats.channels.length - 1].max === 0) {
    throw new GsFailure(
      'LOGO_INVALID',
      `logo ${name} is empty (fully transparent).`,
      'Export the logo with its lettering visible on a transparent background and point "logo" in gameshipper.json at it.',
    );
  }
  const { info: trimmed } = await sharp(file).trim().toBuffer({ resolveWithObject: true });
  return { ...info, trimmed: { width: trimmed.width, height: trimmed.height } };
}

/** Is a captured frame blank, or mostly one colour? `check` asks this of the game's last frame. */
export async function frameInfo(file: string): Promise<FrameInfo> {
  const sharp = await loadSharp();
  const [meta, stats, raw] = await Promise.all([
    sharp(file).metadata(),
    sharp(file).stats(),
    sharp(file).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }),
  ]);
  const rgb = stats.channels.slice(0, 3);
  const mix = colourMix(raw.data, raw.info.channels);
  return {
    width: meta.width,
    height: meta.height,
    blank: rgb.every((c) => c.max - c.min <= BLANK_SPREAD),
    color: hex(rgb.map((c) => c.mean)),
    plain: isPlain(mix),
    main: { share: mix.share, color: mix.color },
  };
}
