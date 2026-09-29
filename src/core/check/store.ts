import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCREENSHOT_SIZE } from '../../shell/capture.js';
import { imageInfo } from '../assets/inspect.js';
import { MIN_SCREENSHOTS, screenshotDirFor, STORE_IMAGES, storeDirFor } from '../assets/sizes.js';
import type { Config } from '../config/schema.js';
import { capDetails, type CheckResult } from './types.js';

export async function storeImagesCheck(projectDir: string, config: Config): Promise<CheckResult> {
  const base = { id: 'store.images', group: 'store', title: 'All eight store images at exact sizes' } as const;
  const dir = storeDirFor(projectDir);
  const problems: string[] = [];
  for (const spec of STORE_IMAGES) {
    const info = await imageInfo(path.join(dir, spec.file));
    if (!info) problems.push(`${spec.file} (${spec.label}): missing`);
    else if (info.width !== spec.width || info.height !== spec.height) {
      problems.push(`${spec.file} (${spec.label}): ${info.width}x${info.height}, needs ${spec.width}x${spec.height}`);
    }
  }
  if (!problems.length) return { ...base, status: 'pass', message: `All ${STORE_IMAGES.length} images are in out/store at Steam's sizes.` };
  return {
    ...base,
    status: 'fail',
    code: 'CHECK_STORE_IMAGES',
    message: `${problems.length} of ${STORE_IMAGES.length} store images are missing or the wrong size.`,
    fix:
      config.keyArt && config.logo
        ? 'Run `npx gameshipper build` to make them again.'
        : 'Set "keyArt" (3840x2160 PNG or JPEG) and "logo" (transparent PNG) in gameshipper.json, then run `npx gameshipper build`.',
    details: problems,
  };
}

/** Steam takes 16:9 screenshots of 1920x1080 or larger; everything Gameshipper saves is exactly 1920x1080. */
export async function screenshotsCheck(projectDir: string): Promise<CheckResult> {
  const base = { id: 'store.screenshots', group: 'store', title: `At least ${MIN_SCREENSHOTS} screenshots at 1920x1080` } as const;
  const dir = screenshotDirFor(projectDir);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : [];
  let good = 0;
  const wrong: string[] = [];
  for (const f of files) {
    const info = await imageInfo(path.join(dir, f));
    if (info && info.width >= SCREENSHOT_SIZE.width && info.width * 9 === info.height * 16) good++;
    else wrong.push(`${f}: ${info ? `${info.width}x${info.height}` : 'not an image'}`);
  }
  if (good >= MIN_SCREENSHOTS) return { ...base, status: 'pass', message: `${good} screenshots at 1920x1080 or larger.` };
  return {
    ...base,
    status: 'fail',
    code: 'CHECK_SCREENSHOTS',
    message: `${good} usable screenshot${good === 1 ? '' : 's'} in out/store/screenshots; Steam needs at least ${MIN_SCREENSHOTS} at 1920x1080.`,
    fix: 'Run `npx gameshipper play` and press F12 at five or more gameplay moments. Without a person, `npx gameshipper play --screenshot 5,10,15,20,25` saves them automatically, but Steam wants real gameplay, so look at what they show.',
    details: wrong.length ? capDetails(wrong) : undefined,
  };
}

export function trailerCheck(): CheckResult {
  return {
    id: 'store.trailer',
    group: 'store',
    title: 'Trailer',
    status: 'info',
    message: "Steam needs a trailer on the store page. Gameshipper doesn't make one yet.",
    fix: 'Record 30-90 seconds of gameplay at 1920x1080 (H.264 MP4) and upload it in the Steamworks dashboard.',
  };
}

export function aiDisclosureCheck(): CheckResult {
  return {
    id: 'ai.disclosure',
    group: 'ai',
    title: 'AI content disclosure',
    status: 'info',
    message: "If the game ships AI-generated art, audio or text, disclose it in Steam's content survey. AI-written code needs no disclosure.",
  };
}
