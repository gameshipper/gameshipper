import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { errorDetails, GsFailure, gsError, type GsError } from '../result.js';
import { coverCrop } from './crop.js';
import { inspectKeyArt, inspectLogo, type ImageInfo, type LogoInfo } from './inspect.js';
import { loadSharp } from './sharp.js';
import { STORE_IMAGES, storeDirFor, type StoreImageId, type StoreImageSpec } from './sizes.js';

export interface StoreImageFile {
  id: StoreImageId;
  /** Absolute path in out/store/. */
  file: string;
  width: number;
  height: number;
}

export interface StoreImagesResult {
  status: 'built' | 'skipped' | 'failed';
  /** out/store */
  dir: string;
  images: StoreImageFile[];
  errors: GsError[];
  warnings: GsError[];
}

interface Rendered {
  png: Buffer;
  /** Scale applied to the key art (null if unused); above 1 = enlarged. */
  artScale: number | null;
  /** Scale applied to the trimmed logo (null if unused). */
  logoScale: number | null;
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
/** Scales up to this count as not enlarged (rounding). */
const ENLARGED = 1.001;

async function renderArt(keyArtFile: string, art: ImageInfo, logoFile: string, logo: LogoInfo, spec: StoreImageSpec, focus: readonly [number, number]): Promise<Rendered> {
  const sharp = await loadSharp();
  const crop = coverCrop(art, spec, focus);
  // Steam shows capsules and the hero on its own backgrounds, so transparent key art is put on black first.
  let image = sharp(keyArtFile).autoOrient().flatten({ background: '#000000' }).resize(crop.resize.width, crop.resize.height).extract(crop.extract);
  let logoScale: number | null = null;
  if (spec.kind === 'art+logo' && spec.logoBox) {
    const box = { width: Math.round(spec.width * spec.logoBox[0]), height: Math.round(spec.height * spec.logoBox[1]) };
    const fitted = await sharp(logoFile).trim().resize({ ...box, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
    logoScale = fitted.info.width / logo.trimmed.width;
    image = image.composite([
      { input: fitted.data, left: Math.round((spec.width - fitted.info.width) / 2), top: Math.round((spec.height - fitted.info.height) / 2) },
    ]);
  }
  return { png: await image.png().toBuffer(), artScale: crop.scale, logoScale };
}

async function renderLogo(logoFile: string, logo: LogoInfo, spec: StoreImageSpec): Promise<Rendered> {
  const sharp = await loadSharp();
  const png = await sharp(logoFile).trim().resize({ width: spec.width, height: spec.height, fit: 'contain', background: TRANSPARENT }).png().toBuffer();
  const logoScale = Math.min(spec.width / logo.trimmed.width, spec.height / logo.trimmed.height);
  return { png, artScale: null, logoScale };
}

/** out/store/.source.json: what the images were made from, so `check` can tell when they're out of date. */
export const STORE_SOURCE_FILE = '.source.json';

export interface StoreSource {
  /** As gameshipper.json names them, with the SHA-256 of their content. */
  keyArt: { path: string; sha256: string };
  logo: { path: string; sha256: string };
  keyArtFocus: [number, number];
}

/** The SHA-256 of a file's content, or null when it can't be read. */
export function fileSha256(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** The record an earlier build left in out/store, or null (none, from an older Gameshipper, or unreadable). */
export function readStoreSource(dir: string): StoreSource | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, STORE_SOURCE_FILE), 'utf8')) as StoreSource;
    const art = (a: unknown) => typeof a === 'object' && a !== null && typeof (a as { path: unknown }).path === 'string' && typeof (a as { sha256: unknown }).sha256 === 'string';
    return art(s.keyArt) && art(s.logo) && Array.isArray(s.keyArtFocus) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the images (*.png) in out/store and the record of what they were made from, leaving out/store/screenshots/
 * and anything else alone, so images from an earlier build never outlive a change to keyArt or logo.
 */
function clearStoreImages(ctx: Ctx, dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => /\.png$/i.test(n) || n === STORE_SOURCE_FILE)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) fs.rmSync(file, { force: true });
    } catch (e) {
      ctx.log(`couldn't remove the old store image ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Builds every Steam store and library image (spec §8) from keyArt + logo into out/store/, replacing the images an
 * earlier build made. Never throws: problems come back as errors and warnings, so the desktop builds still count.
 * When the images are skipped or fail, out/store is left without any. Leaves out/store/screenshots/ alone.
 */
export async function makeStoreImages(ctx: Ctx, config: Config): Promise<StoreImagesResult> {
  const dir = storeDirFor(ctx.projectDir);
  const result: StoreImagesResult = { status: 'skipped', dir, images: [], errors: [], warnings: [] };
  clearStoreImages(ctx, dir);
  const missing = (['keyArt', 'logo'] as const).filter((key) => !config[key]);
  if (missing.length) {
    result.warnings.push(
      gsError(
        'STORE_IMAGES_SKIPPED',
        `Store images weren't made because ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set in gameshipper.json.`,
        'Set "keyArt" (PNG or JPEG, 3840x2160 recommended) and "logo" (PNG with a transparent background) in gameshipper.json, then run `npx gameshipper build` again.',
      ),
    );
    return result;
  }
  const keyArtFile = path.join(ctx.projectDir, config.keyArt!);
  const logoFile = path.join(ctx.projectDir, config.logo!);
  // Hashed before the images are made: art edited during the build then shows as out of date, never as current.
  const source: StoreSource = {
    keyArt: { path: config.keyArt!, sha256: fileSha256(keyArtFile) ?? '' },
    logo: { path: config.logo!, sha256: fileSha256(logoFile) ?? '' },
    keyArtFocus: [...config.keyArtFocus],
  };
  try {
    const art = await inspectKeyArt(keyArtFile);
    const logo = await inspectLogo(logoFile);
    fs.mkdirSync(dir, { recursive: true });
    const enlargedArt: string[] = [];
    const enlargedLogo: string[] = [];
    for (const spec of STORE_IMAGES) {
      const rendered = spec.kind === 'logo' ? await renderLogo(logoFile, logo, spec) : await renderArt(keyArtFile, art, logoFile, logo, spec, config.keyArtFocus);
      const file = path.join(dir, spec.file);
      fs.writeFileSync(file, rendered.png);
      result.images.push({ id: spec.id, file, width: spec.width, height: spec.height });
      if ((rendered.artScale ?? 0) > ENLARGED) enlargedArt.push(spec.file);
      if ((rendered.logoScale ?? 0) > ENLARGED) enlargedLogo.push(spec.file);
      ctx.log(`store image ${spec.file} ${spec.width}x${spec.height}`);
    }
    if (enlargedArt.length) {
      result.warnings.push(
        gsError(
          'KEYART_LOW_RES',
          `keyArt is ${art.width}x${art.height}, so ${enlargedArt.join(', ')} had to be enlarged and may look soft.`,
          'Use key art of at least 3840x2160.',
        ),
      );
    }
    if (enlargedLogo.length) {
      result.warnings.push(
        gsError(
          'LOGO_LOW_RES',
          `The logo is ${logo.trimmed.width}x${logo.trimmed.height} once its transparent edges are trimmed, so it was enlarged for ${enlargedLogo.join(', ')}.`,
          'Export the logo at least 1280 pixels wide (or 720 tall), not counting transparent edges.',
        ),
      );
    }
    fs.writeFileSync(path.join(dir, STORE_SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
    result.status = 'built';
  } catch (e) {
    result.status = 'failed';
    // Half a set would look like a finished one.
    clearStoreImages(ctx, dir);
    result.images = [];
    if (e instanceof GsFailure) {
      result.errors.push(e.error);
    } else {
      ctx.log(errorDetails(e));
      result.errors.push(
        gsError(
          'STORE_IMAGE_FAILED',
          `Couldn't make the store images: ${e instanceof Error ? e.message : String(e)}`,
          `Re-export keyArt and logo from an image editor and run \`npx gameshipper build\` again. Details: ${ctx.logPath}.`,
        ),
      );
    }
  }
  return result;
}
