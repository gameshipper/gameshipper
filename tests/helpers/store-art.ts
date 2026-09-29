import sharp from 'sharp';

/** 3840x2160 key art: a gradient with a few shapes. Drawn from SVG with no text, so no fonts are needed. */
export function makeKeyArt(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3840" height="2160">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2a49"/><stop offset="1" stop-color="#7a3b69"/></linearGradient></defs>
    <rect width="3840" height="2160" fill="url(#g)"/>
    <circle cx="1400" cy="1100" r="520" fill="#f2c14e"/>
    <rect x="2300" y="700" width="900" height="900" rx="80" fill="#4ecdc4" transform="rotate(20 2750 1150)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 1600x600 logo on a transparent background. */
export function makeLogo(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600">
    <rect x="100" y="150" width="1400" height="300" rx="150" fill="#ffffff"/>
    <rect x="200" y="230" width="1200" height="140" rx="70" fill="#e63946"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
