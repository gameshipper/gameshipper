import * as path from 'node:path';

export interface Size {
  width: number;
  height: number;
}

export type StoreImageId =
  | 'header-capsule'
  | 'small-capsule'
  | 'main-capsule'
  | 'vertical-capsule'
  | 'library-capsule'
  | 'library-header'
  | 'library-hero'
  | 'library-logo';

export interface StoreImageSpec extends Size {
  id: StoreImageId;
  /** File name inside out/store/. */
  file: string;
  /** Steam's name for the image in the Steamworks dashboard. */
  label: string;
  /** 'art' = key art only, 'art+logo' = key art with the logo centred on top, 'logo' = the logo alone on transparency. */
  kind: 'art' | 'art+logo' | 'logo';
  /** For 'art+logo': the largest share of the width and height the logo may cover. */
  logoBox: readonly [number, number] | null;
}

/**
 * Steam's store and library images (spec §8), all made from keyArt + logo. The logo boxes are a design choice,
 * not a Steam rule: small capsules get a large box so the title stays readable at 462x174, and portrait capsules
 * keep the logo to about a third of the height so the art shows.
 */
export const STORE_IMAGES: readonly StoreImageSpec[] = [
  { id: 'header-capsule', file: 'header_capsule.png', label: 'Header capsule', width: 920, height: 430, kind: 'art+logo', logoBox: [0.7, 0.6] },
  { id: 'small-capsule', file: 'small_capsule.png', label: 'Small capsule', width: 462, height: 174, kind: 'art+logo', logoBox: [0.85, 0.75] },
  { id: 'main-capsule', file: 'main_capsule.png', label: 'Main capsule', width: 1232, height: 706, kind: 'art+logo', logoBox: [0.6, 0.5] },
  { id: 'vertical-capsule', file: 'vertical_capsule.png', label: 'Vertical capsule', width: 748, height: 896, kind: 'art+logo', logoBox: [0.8, 0.35] },
  { id: 'library-capsule', file: 'library_capsule.png', label: 'Library capsule', width: 600, height: 900, kind: 'art+logo', logoBox: [0.8, 0.35] },
  { id: 'library-header', file: 'library_header.png', label: 'Library header', width: 920, height: 430, kind: 'art+logo', logoBox: [0.7, 0.6] },
  { id: 'library-hero', file: 'library_hero.png', label: 'Library hero', width: 3840, height: 1240, kind: 'art', logoBox: null },
  { id: 'library-logo', file: 'library_logo.png', label: 'Library logo', width: 1280, height: 720, kind: 'logo', logoBox: null },
];

/** Steam needs at least this many screenshots on the store page. */
export const MIN_SCREENSHOTS = 5;
/** Smaller key art is refused; anything below RECOMMENDED_KEY_ART is enlarged for some images (a warning). */
export const MIN_KEY_ART: Size = { width: 1280, height: 720 };
export const RECOMMENDED_KEY_ART: Size = { width: 3840, height: 2160 };

/** out/store: every store image `build` makes. */
export function storeDirFor(projectDir: string): string {
  return path.join(projectDir, 'out', 'store');
}

/** Where F12 and `play --screenshot` save store screenshots. `build` never touches it. */
export function screenshotDirFor(projectDir: string): string {
  return path.join(storeDirFor(projectDir), 'screenshots');
}
