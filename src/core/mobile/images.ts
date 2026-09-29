import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSharp, type SharpFactory } from '../assets/sharp.js';
import { pngSize } from '../desktop/icons.js';
import { templateError } from './template.js';

const BACKGROUND = { r: 0, g: 0, b: 0, alpha: 1 };
/** Share of the splash screen's shorter side taken by the icon. */
const SPLASH_ICON = 0.25;
/** Android adaptive icons are 108dp with the visible area in the middle 72dp. */
const ADAPTIVE_VISIBLE = 72 / 108;

type Render = (sharp: SharpFactory, icon: Buffer, width: number, height: number) => Promise<Buffer>;

/** App Store icons must be opaque, so transparent pixels become the background colour. */
const opaqueIcon: Render = (sharp, icon, w, h) => sharp(icon).resize(w, h).flatten({ background: BACKGROUND }).png().toBuffer();

const plainIcon: Render = (sharp, icon, w, h) => sharp(icon).resize(w, h).png().toBuffer();

const roundIcon: Render = (sharp, icon, w, h) =>
  sharp(icon)
    .resize(w, h)
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}" fill="#fff"/></svg>`), blend: 'dest-in' }])
    .png()
    .toBuffer();

const adaptiveForeground: Render = async (sharp, icon, w, h) => {
  const inner = Math.round(Math.min(w, h) * ADAPTIVE_VISIBLE);
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp(icon).resize(inner, inner).png().toBuffer(), gravity: 'center' }])
    .png()
    .toBuffer();
};

const splash: Render = async (sharp, icon, w, h) => {
  const side = Math.round(Math.min(w, h) * SPLASH_ICON);
  return sharp({ create: { width: w, height: h, channels: 3, background: BACKGROUND } })
    .composite([{ input: await sharp(icon).resize(side, side).png().toBuffer(), gravity: 'center' }])
    .removeAlpha()
    .png()
    .toBuffer();
};

/** Re-renders every template PNG at its original size. Returns how many files were written. */
async function rerender(files: string[], icon: Buffer, render: Render): Promise<number> {
  const sharp = await loadSharp();
  for (const file of files) {
    const size = pngSize(fs.readFileSync(file));
    if (!size) throw templateError(`${file} isn't a PNG`);
    fs.writeFileSync(file, await render(sharp, icon, size.width, size.height));
  }
  return files.length;
}

const pngsIn = (dir: string, match: (name: string) => boolean) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png') && match(f)).map((f) => path.join(dir, f)) : [];

/** App icon (1024x1024, opaque) and launch splash (the icon centred on black). */
export async function writeIosImages(iosDir: string, iconPng: string): Promise<number> {
  const icon = fs.readFileSync(iconPng);
  const assets = path.join(iosDir, 'App', 'App', 'Assets.xcassets');
  const icons = await rerender(pngsIn(path.join(assets, 'AppIcon.appiconset'), () => true), icon, opaqueIcon);
  const splashes = await rerender(pngsIn(path.join(assets, 'Splash.imageset'), () => true), icon, splash);
  if (!icons || !splashes) throw templateError('no AppIcon or Splash images in Assets.xcassets');
  return icons + splashes;
}

/** Launcher icons (square, round, adaptive foreground on black) and splash screens for every density. */
export async function writeAndroidImages(androidDir: string, iconPng: string): Promise<number> {
  const icon = fs.readFileSync(iconPng);
  const res = path.join(androidDir, 'app', 'src', 'main', 'res');
  const dirs = fs.readdirSync(res).map((d) => path.join(res, d));
  const mipmaps = dirs.filter((d) => path.basename(d).startsWith('mipmap-'));
  const drawables = dirs.filter((d) => path.basename(d).startsWith('drawable'));
  let written = 0;
  written += await rerender(mipmaps.flatMap((d) => pngsIn(d, (f) => f === 'ic_launcher.png')), icon, plainIcon);
  written += await rerender(mipmaps.flatMap((d) => pngsIn(d, (f) => f === 'ic_launcher_round.png')), icon, roundIcon);
  written += await rerender(mipmaps.flatMap((d) => pngsIn(d, (f) => f === 'ic_launcher_foreground.png')), icon, adaptiveForeground);
  written += await rerender(drawables.flatMap((d) => pngsIn(d, (f) => f === 'splash.png')), icon, splash);
  if (!written) throw templateError('no launcher icons or splash images in app/src/main/res');
  const background = path.join(res, 'values', 'ic_launcher_background.xml');
  if (fs.existsSync(background)) {
    fs.writeFileSync(background, fs.readFileSync(background, 'utf8').replace(/#[0-9A-Fa-f]{6}/, '#000000'));
  }
  return written;
}
