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
  let image = sharp(keyArtFile).autoOrient().resize(crop.resize.width, crop.resize.height).extract(crop.extract);
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

/**
 * Builds every Steam store and library image (spec §8) from keyArt + logo into out/store/. Never throws:
 * problems come back as errors and warnings, so the desktop builds still count. Leaves out/store/screenshots/ alone.
 */
export async function makeStoreImages(ctx: Ctx, config: Config): Promise<StoreImagesResult> {
  const dir = storeDirFor(ctx.projectDir);
  const result: StoreImagesResult = { status: 'skipped', dir, images: [], errors: [], warnings: [] };
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
    result.status = 'built';
  } catch (e) {
    result.status = 'failed';
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
