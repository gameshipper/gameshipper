import type { Size } from './sizes.js';

export interface CoverCrop {
  /** How much the source is scaled. Above 1 means it is enlarged (soft). */
  scale: number;
  /** Size to resize the source to before cutting. */
  resize: Size;
  /** The window to cut from the resized source. */
  extract: { left: number; top: number; width: number; height: number };
}

/**
 * Scales `src` so it covers `dst`, then picks the dst-sized window whose centre is as close to `focus`
 * (fractions of the source's width and height) as the edges allow. sharp's own crop positions only know
 * gravities and entropy/attention strategies, not a focal point.
 */
export function coverCrop(src: Size, dst: Size, focus: readonly [number, number]): CoverCrop {
  const scale = Math.max(dst.width / src.width, dst.height / src.height);
  const resize = {
    width: Math.max(dst.width, Math.round(src.width * scale)),
    height: Math.max(dst.height, Math.round(src.height * scale)),
  };
  const place = (at: number, full: number, window: number): number => Math.min(Math.max(Math.round(at * full - window / 2), 0), full - window);
  return {
    scale,
    resize,
    extract: {
      left: place(focus[0], resize.width, dst.width),
      top: place(focus[1], resize.height, dst.height),
      width: dst.width,
      height: dst.height,
    },
  };
}
