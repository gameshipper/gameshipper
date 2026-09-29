import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCREENSHOT_SIZE } from '../../shell/capture.js';
import { imageInfo } from '../assets/inspect.js';
import { MIN_SCREENSHOTS, screenshotDirFor, STORE_IMAGES, storeDirFor } from '../assets/sizes.js';
import { fileSha256, readStoreSource, type StoreSource } from '../assets/store-images.js';
import type { Config } from '../config/schema.js';
import { capDetails, type CheckResult } from './types.js';

const mtimeOf = (file: string): number | null => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

export async function storeImagesCheck(projectDir: string, config: Config): Promise<CheckResult> {
  const base = { id: 'store.images', group: 'store', title: 'All eight store images at exact sizes' } as const;
  const dir = storeDirFor(projectDir);
  const fix =
    config.keyArt && config.logo
      ? 'Run `npx gameshipper build` to make them again.'
      : 'Set "keyArt" (3840x2160 PNG or JPEG) and "logo" (transparent PNG) in gameshipper.json, then run `npx gameshipper build`.';
  const problems: string[] = [];
  for (const spec of STORE_IMAGES) {
    const info = await imageInfo(path.join(dir, spec.file));
    if (!info) problems.push(`${spec.file} (${spec.label}): missing`);
    else if (info.width !== spec.width || info.height !== spec.height) {
      problems.push(`${spec.file} (${spec.label}): ${info.width}x${info.height}, needs ${spec.width}x${spec.height}`);
    }
  }
  if (problems.length) {
    return {
      ...base,
      status: 'fail',
      code: 'CHECK_STORE_IMAGES',
      message: `${problems.length} of ${STORE_IMAGES.length} store images are missing or the wrong size.`,
      fix,
      details: problems,
    };
  }
  // Made from the key art and logo: one changed since means the images show the old art. The record of what they
  // were made from compares content; images from before it existed fall back to comparing times.
  const source = readStoreSource(dir);
  if (source) {
    const changed = changedSince(projectDir, config, source);
    if (!changed.length) return { ...base, status: 'pass', message: `All ${STORE_IMAGES.length} images are in out/store at Steam's sizes.` };
    return {
      ...base,
      status: 'fail',
      code: 'CHECK_STORE_IMAGES',
      message: `The store images don't show the current ${changed.map((c) => c.what).join(' and ')}: rebuild to refresh them.`,
      fix,
      details: changed.map((c) => c.detail),
    };
  }
  const art = [config.keyArt, config.logo].flatMap((rel) => {
    const mtime = rel ? mtimeOf(path.join(projectDir, rel)) : null;
    return rel && mtime !== null ? [{ rel, mtime }] : [];
  });
  const stale: string[] = [];
  const newer = new Set<string>();
  for (const spec of STORE_IMAGES) {
    const made = mtimeOf(path.join(dir, spec.file)) ?? 0;
    const changed = art.filter((a) => a.mtime > made).map((a) => a.rel);
    if (!changed.length) continue;
    for (const rel of changed) newer.add(rel);
    stale.push(`${spec.file} (${spec.label}): older than ${changed.join(' and ')}`);
  }
  if (stale.length) {
    return {
      ...base,
      status: 'fail',
      code: 'CHECK_STORE_IMAGES',
      message: `${stale.length} of ${STORE_IMAGES.length} store images are older than ${[...newer].join(' and ')}: rebuild to refresh the store images.`,
      fix,
      details: stale,
    };
  }
  return { ...base, status: 'pass', message: `All ${STORE_IMAGES.length} images are in out/store at Steam's sizes.` };
}

/** What differs between the key art, logo and focus gameshipper.json names now and what the images were made from. */
function changedSince(projectDir: string, config: Config, source: StoreSource): Array<{ what: string; detail: string }> {
  const changed: Array<{ what: string; detail: string }> = [];
  for (const [key, what] of [
    ['keyArt', 'key art'],
    ['logo', 'logo'],
  ] as const) {
    const rel = config[key];
    const made = source[key];
    // Unset now: the fix already asks for it, and the next build removes the images.
    if (!rel) continue;
    if (rel !== made.path) changed.push({ what, detail: `${key} is ${rel}, but the images were made from ${made.path}` });
    else if (fileSha256(path.join(projectDir, rel)) !== made.sha256) changed.push({ what, detail: `${rel} changed after the images were made` });
  }
  const [x, y] = config.keyArtFocus;
  if (x !== source.keyArtFocus[0] || y !== source.keyArtFocus[1]) {
    changed.push({ what: 'key art focus', detail: `keyArtFocus is ${JSON.stringify(config.keyArtFocus)}, but the images were made with ${JSON.stringify(source.keyArtFocus)}` });
  }
  return changed;
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
