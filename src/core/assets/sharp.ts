import { GsFailure } from '../result.js';

export type SharpFactory = typeof import('sharp').default;

let cached: SharpFactory | null = null;

/**
 * Loads sharp (the native image library) the first time images are needed, so commands that never touch
 * images keep working on a computer where sharp's binary is missing.
 */
export async function loadSharp(): Promise<SharpFactory> {
  if (cached) return cached;
  try {
    cached = (await import('sharp')).default;
  } catch (e) {
    throw new GsFailure(
      'IMAGE_LIB_UNAVAILABLE',
      `Couldn't load the image library (sharp): ${e instanceof Error ? e.message : String(e)}`,
      'Reinstall Gameshipper so npm downloads sharp for this computer (`npx gameshipper@latest`, or delete node_modules and run `npm install`). sharp supports Windows x64, macOS and Linux x64/arm64.',
    );
  }
  return cached;
}
