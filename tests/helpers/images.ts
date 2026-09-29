import sharp from 'sharp';

type Rgb = [number, number, number];

function block(width: number, height: number, [r, g, b]: Rgb): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

/** Key art in four solid quadrants: red top-left, green top-right, blue bottom-left, yellow bottom-right. */
export async function makeQuadrantPng(width: number, height: number): Promise<Buffer> {
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: await block(w, h, [255, 0, 0]), left: 0, top: 0 },
      { input: await block(width - w, h, [0, 255, 0]), left: w, top: 0 },
      { input: await block(w, height - h, [0, 0, 255]), left: 0, top: h },
      { input: await block(width - w, height - h, [255, 255, 0]), left: w, top: h },
    ])
    .png()
    .toBuffer();
}

/** A logo: an opaque white bar with `pad` transparent pixels around it. */
export async function makeLogoPng(width: number, height: number, pad = 20): Promise<Buffer> {
  const bar = await sharp({
    create: { width: width - 2 * pad, height: height - 2 * pad, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: bar, left: pad, top: pad }])
    .png()
    .toBuffer();
}

/** RGBA of one pixel. */
export async function pixel(image: Buffer | string, x: number, y: number): Promise<number[]> {
  const data = await sharp(image).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return [...data];
}
