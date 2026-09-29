import { createHash } from 'node:crypto';

export type ImportMap = Record<string, string>;

export const VENDOR_ROOT = '_gameshipper/cdn';

const KNOWN_EXT = /\.(m?js|css|json|wasm|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp3|ogg|wav|m4a|mp4|webm|glb|gltf|bin|hdr|ktx2|txt)$/i;

const EXT_BY_TYPE: Array<[RegExp, string]> = [
  [/javascript|ecmascript/, '.js'],
  [/text\/css/, '.css'],
  [/json/, '.json'],
  [/wasm/, '.wasm'],
  [/font\/woff2/, '.woff2'],
  [/font\/woff/, '.woff'],
  [/font\/ttf|font\/sfnt/, '.ttf'],
  [/image\/png/, '.png'],
  [/image\/svg/, '.svg'],
];

export function isRemote(spec: string): boolean {
  return /^https?:\/\//i.test(spec) || spec.startsWith('//');
}

export function normalizeRemote(spec: string): string {
  return spec.startsWith('//') ? `https:${spec}` : spec;
}

export function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || (spec.startsWith('/') && !spec.startsWith('//'));
}

export function extForContentType(contentType: string | null): string {
  if (!contentType) return '';
  const ct = contentType.toLowerCase();
  return EXT_BY_TYPE.find(([re]) => re.test(ct))?.[1] ?? '';
}

function cleanSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9@._+~-]/g, '_');
  return cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

function hostDir(u: URL): string {
  return u.host.replace(/[^A-Za-z0-9.-]/g, '_');
}

function pathSegments(u: URL): string[] {
  return decodeURIComponent(u.pathname).split('/').filter(Boolean).map(cleanSegment);
}

/** Where a downloaded URL is stored inside the staged game (posix path, no leading slash). */
export function vendorPathFor(url: string, contentType: string | null): string {
  const u = new URL(normalizeRemote(url));
  const segments = pathSegments(u);
  let file = u.pathname.endsWith('/') || segments.length === 0 ? 'index' : (segments.pop() as string);
  const known = file.match(KNOWN_EXT);
  let ext: string;
  if (known) {
    ext = known[0];
    file = file.slice(0, -ext.length);
  } else {
    ext = extForContentType(contentType);
  }
  if (u.search) file += `__q${createHash('sha1').update(u.search).digest('hex').slice(0, 10)}`;
  return [VENDOR_ROOT, hostDir(u), ...segments, `${file}${ext}`].join('/');
}

/** Vendor folder for an import-map prefix like "https://unpkg.com/three@0.170.0/examples/jsm/". */
export function vendorPrefixFor(urlPrefix: string): string {
  const u = new URL(normalizeRemote(urlPrefix));
  return `${[VENDOR_ROOT, hostDir(u), ...pathSegments(u)].join('/')}/`;
}

export function resolveBare(spec: string, map: ImportMap): string | null {
  if (map[spec] !== undefined) return map[spec];
  const prefix = Object.keys(map)
    .filter((k) => k.endsWith('/') && spec.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? map[prefix] + spec.slice(prefix.length) : null;
}
