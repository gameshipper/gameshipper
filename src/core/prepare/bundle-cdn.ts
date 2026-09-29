import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx } from '../context.js';
import { listFiles } from '../fsutil.js';
import { GsFailure, gsError, type GsError } from '../result.js';
import { fetchRemote, type Fetched } from './fetcher.js';
import { byCodeUnit, lockExists, readLock, writeLock } from './lockfile.js';
import { findCssUrls, rewriteCss } from './rewrite-css.js';
import { rewriteHtml, scanHtml, type HtmlScan } from './rewrite-html.js';
import { findJsSpecifiers, rewriteJs, type JsSpecifier } from './rewrite-js.js';
import {
  isRelative,
  isRemote,
  normalizeRemote,
  resolveBare,
  vendorPathFor,
  vendorPrefixFor,
  type ImportMap,
} from './remote.js';

export interface VendoredFile {
  url: string;
  path: string;
  sha256: string;
}

export interface BundleResult {
  files: VendoredFile[];
  warnings: GsError[];
}

export interface BundleOptions {
  /** Fail with CDN_CHANGED when a file no longer matches gameshipper.lock (`build --frozen-lock`). */
  frozenLock?: boolean;
  /** Per-download timeout in milliseconds (default 60 s). */
  timeoutMs?: number;
}

interface Pending {
  url: string;
  /** The game file or downloaded URL that refers to `url`. */
  from: string;
  /** Referenced by the game itself. Only these must download; files found inside downloads are optional. */
  direct: boolean;
}

interface Page {
  scan: HtmlScan;
  map: ImportMap;
}

interface Vendored extends Fetched {
  path: string;
}

const IS_HTML = /\.html?$/i;
const IS_JS = /\.m?js$/i;
const IS_CSS = /\.css$/i;

const hasScheme = (spec: string) => /^[a-z][a-z0-9+.-]*:/i.test(spec);
/** "three" or "three/addons/x.js": resolved by an import map. Not a path, and not a URL like data: or node:. */
const isBare = (spec: string) => !isRemote(spec) && !isRelative(spec) && !hasScheme(spec);
const quietSpecifiers = (code: string) => findJsSpecifiers(code).catch((): JsSpecifier[] => []);

/** The part of a URL to download, and its #fragment ('' if none). */
function splitHash(url: string): [string, string] {
  const i = url.indexOf('#');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i)];
}

/** A reference inside a downloaded file, resolved against the URL it was served from; null unless http(s). */
function resolveRef(ref: string, base: string): string | null {
  const u = URL.parse(ref, base);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
}

/** Only string values count; browsers ignore the rest. */
function stringEntries(map: ImportMap | null): ImportMap {
  const out: ImportMap = {};
  for (const [key, value] of Object.entries(map ?? {})) if (typeof value === 'string') out[key] = value;
  return out;
}

function unique(warnings: GsError[]): GsError[] {
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.code}\n${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Inserts `suffix` before the file extension: a/chart.js + __file → a/chart__file.js. */
function withSuffix(p: string, suffix: string): string {
  const ext = path.posix.extname(p.slice(p.lastIndexOf('/') + 1));
  return `${p.slice(0, p.length - ext.length)}${suffix}${ext}`;
}

/**
 * Final vendor paths. Two URLs can want the same file (/lib served as JS and /lib.js; A.js and a.js on
 * case-insensitive disks), and a file can sit where another URL needs a folder (esm.sh/chart.js and
 * esm.sh/chart.js/helpers). Resolved in URL order, so the same URLs always get the same paths.
 */
function assignPaths(wanted: Map<string, string>): Map<string, string> {
  const fold = (p: string) => p.toLowerCase();
  const folders = new Set<string>();
  for (const p of wanted.values()) {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) folders.add(fold(p.slice(0, i)));
  }
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const url of [...wanted.keys()].sort(byCodeUnit)) {
    let p = wanted.get(url) as string;
    if (folders.has(fold(p))) p = withSuffix(p, '__file');
    if (taken.has(fold(p)) || folders.has(fold(p))) {
      p = withSuffix(p, `__${createHash('sha1').update(url).digest('hex').slice(0, 8)}`);
    }
    taken.add(fold(p));
    out.set(url, p);
  }
  return out;
}

export async function bundleCdn(ctx: Ctx, stageDir: string, opts: BundleOptions = {}): Promise<BundleResult> {
  const warnings: GsError[] = [];
  const lock = readLock(ctx.projectDir);
  const gameFiles = listFiles(stageDir);
  const abs = (rel: string) => path.join(stageDir, ...rel.split('/'));
  const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');

  const specifiers = async (code: string, label: string): Promise<JsSpecifier[]> => {
    try {
      return await findJsSpecifiers(code);
    } catch (e) {
      warnings.push(
        gsError(
          'JS_PARSE_FAILED',
          `Couldn't scan ${label} for imports: ${(e as Error).message}`,
          'If this file loads anything from the internet, the build may be missing it. Run `npx gameshipper play --smoke` to check.',
        ),
      );
      return [];
    }
  };

  // Each page keeps its own import map. Standalone JS files and downloaded modules can be loaded by any
  // page, so their bare imports are resolved with every page's map.
  const pages = new Map<string, Page>();
  const firstDefinition = new Map<string, { value: string; target: string; page: string }>();
  // What a value points at: "./three.js" on index.html and "../three.js" on levels/one.html are the same file.
  const targetOf = (value: string, page: string) => URL.parse(normalizeRemote(value), `app://game/${page}`)?.href ?? value;
  for (const rel of gameFiles.filter((f) => IS_HTML.test(f))) {
    const scan = scanHtml(read(rel));
    const map = stringEntries(scan.importMap);
    pages.set(rel, { scan, map });
    for (const [key, value] of Object.entries(map)) {
      const first = firstDefinition.get(key);
      if (!first) firstDefinition.set(key, { value, target: targetOf(value, rel), page: rel });
      else if (first.target !== targetOf(value, rel)) {
        warnings.push(
          gsError(
            'IMPORT_MAP_CONFLICT',
            `${first.page} and ${rel} map "${key}" differently ("${first.value}" and "${value}").`,
            `Each page is bundled with its own import map, so scripts shared by these pages load a different "${key}" on each page. Use the same mapping on every page unless that's intended.`,
          ),
        );
      }
    }
  }
  const allMaps = [...pages.values()].map((p) => p.map).filter((m) => Object.keys(m).length > 0);

  const queue: Pending[] = [];
  const queued = new Set<string>();
  const enqueue = (url: string, from: string, direct: boolean): void => {
    const [u] = splitHash(normalizeRemote(url));
    if (queued.has(u)) return;
    queued.add(u);
    queue.push({ url: u, from, direct });
  };
  // Bare specifiers that resolve through a prefix key ("react-dom/" + "client"). Their vendored file may be
  // named differently from what the prefix implies (".js" added, query hashed), so each gets an exact entry.
  const viaPrefix = new Set<string>();
  /** The remote URLs `spec` maps to under these import maps, and whether any of them defines it. */
  const resolveBareIn = (spec: string, maps: ImportMap[]): { urls: string[]; defined: boolean } => {
    const urls: string[] = [];
    let defined = false;
    for (const map of maps) {
      const mapped = resolveBare(spec, map);
      if (mapped === null) continue;
      defined = true;
      if (!isRemote(mapped)) continue;
      if (!Object.hasOwn(map, spec)) viaPrefix.add(spec);
      urls.push(normalizeRemote(mapped));
    }
    return { urls, defined };
  };
  const unresolvedBare = (spec: string, where: string): GsError =>
    gsError(
      'BARE_IMPORT_UNRESOLVED',
      `${where} imports "${spec}", which your import map doesn't define.`,
      `Add "${spec}" to the import map in your HTML, pointing at a CDN URL, or add a build step.`,
    );
  const seedFromGameJs = (specs: JsSpecifier[], where: string, maps: ImportMap[]): void => {
    for (const { specifier } of specs) {
      if (isRemote(specifier)) enqueue(specifier, where, true);
      else if (isBare(specifier)) {
        const { urls, defined } = resolveBareIn(specifier, maps);
        for (const u of urls) enqueue(u, where, true);
        if (!defined) warnings.push(unresolvedBare(specifier, where));
      }
    }
  };

  // 1. Seed from the game's own files.
  for (const [rel, { scan, map }] of pages) {
    for (const [key, value] of Object.entries(map)) if (!key.endsWith('/') && isRemote(value)) enqueue(value, rel, true);
    for (const u of scan.urls) if (isRemote(u)) enqueue(u, rel, true);
    for (const code of scan.moduleScripts) seedFromGameJs(await specifiers(code, rel), rel, [map]);
    for (const css of scan.styles) for (const u of findCssUrls(css)) if (isRemote(u)) enqueue(u, rel, true);
  }
  for (const rel of gameFiles.filter((f) => IS_JS.test(f))) seedFromGameJs(await specifiers(read(rel), rel), rel, allMaps);
  for (const rel of gameFiles.filter((f) => IS_CSS.test(f))) {
    for (const u of findCssUrls(read(rel))) if (isRemote(u)) enqueue(u, rel, true);
  }

  // 2. Download everything reachable. References resolve against the URL a file was served from (after redirects).
  const fetched = new Map<string, Fetched>();
  const wantedPaths = new Map<string, string>();
  while (queue.length) {
    const { url, from, direct } = queue.shift() as Pending;
    const expected = lock.files[url]?.sha256 ?? null;
    let got: Fetched;
    try {
      got = await fetchRemote(ctx, url, expected, { timeoutMs: opts.timeoutMs });
    } catch (e) {
      if (direct || !(e instanceof GsFailure) || e.error.code !== 'CDN_FETCH_FAILED') throw e;
      warnings.push(
        gsError(
          'CDN_OPTIONAL_MISSING',
          `Left out ${url}, which ${from} refers to. ${e.error.message}`,
          "The game only breaks if it actually loads this file. Run `npx gameshipper play --smoke` to check; if it's needed, download it into your game folder and load it from there.",
        ),
      );
      continue;
    }
    if (expected !== null && got.sha256 !== expected) {
      const changed = `${url} (loaded by ${from}) has changed since it was recorded in gameshipper.lock.`;
      if (opts.frozenLock) {
        throw new GsFailure('CDN_CHANGED', changed, 'Run a build without --frozen-lock to accept the new version, or pin an exact version in the URL.');
      }
      warnings.push(
        gsError(
          'CDN_CHANGED',
          `${changed} Using the new version and updating the lock.`,
          "If you didn't expect this, pin an exact version in the URL (e.g. three@0.170.0). Build with --frozen-lock to make this an error.",
        ),
      );
    }
    fetched.set(url, got);
    wantedPaths.set(url, vendorPathFor(url, got.contentType));
    if (IS_JS.test(wantedPaths.get(url) as string)) {
      for (const { specifier } of await specifiers(got.body.toString('utf8'), url)) {
        if (isBare(specifier)) {
          const { urls, defined } = resolveBareIn(specifier, allMaps);
          for (const u of urls) enqueue(u, url, false);
          if (!defined) warnings.push(unresolvedBare(specifier, url));
        } else {
          const r = resolveRef(specifier, got.finalUrl);
          if (r) enqueue(r, url, false);
        }
      }
    } else if (IS_CSS.test(wantedPaths.get(url) as string)) {
      for (const u of findCssUrls(got.body.toString('utf8'))) {
        const r = resolveRef(u, got.finalUrl);
        if (r) enqueue(r, url, false);
      }
    }
  }
  if (fetched.size === 0) {
    if (lockExists(ctx.projectDir)) writeLock(ctx.projectDir, { version: 1, files: {} });
    return { files: [], warnings: unique(warnings) };
  }

  const paths = assignPaths(wantedPaths);
  const vendored = new Map<string, Vendored>([...fetched].map(([url, got]) => [url, { ...got, path: paths.get(url) as string }]));
  const local = (url: string): string | null => {
    const [key, hash] = splitHash(normalizeRemote(url));
    const v = vendored.get(key);
    return v ? `/${v.path}${hash}` : null;
  };
  const gameUrl = (u: string): string | null => (isRemote(u) ? local(u) : null);

  // 3. Write downloaded files with their references pointed at local copies.
  for (const [url, v] of vendored) {
    const dest = abs(v.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (IS_JS.test(v.path)) {
      const code = v.body.toString('utf8');
      const rewritten = rewriteJs(code, await quietSpecifiers(code), (spec) => {
        if (isBare(spec)) return null; // the page's import map resolves these
        const r = resolveRef(spec, v.finalUrl);
        return r ? local(r) : null;
      });
      fs.writeFileSync(dest, rewritten);
    } else if (IS_CSS.test(v.path)) {
      const css = v.body.toString('utf8');
      fs.writeFileSync(
        dest,
        rewriteCss(css, (u) => {
          const r = resolveRef(u, v.finalUrl);
          return r ? local(r) : null;
        }),
      );
    } else {
      fs.writeFileSync(dest, v.body);
    }
    ctx.log(`vendored ${url} → ${v.path}`);
  }

  // 4. Point the game's own files at the local copies.
  const rewriteImportMap = (map: ImportMap): ImportMap => {
    const entries = Object.entries(map).map(([key, value]): [string, string] => {
      if (typeof value !== 'string' || !isRemote(value)) return [key, value];
      return [key, key.endsWith('/') ? `/${vendorPrefixFor(value)}` : (local(value) ?? value)];
    });
    // Exact entries win over prefixes, so these point each prefix-resolved import at its real file.
    for (const spec of [...viaPrefix].sort(byCodeUnit)) {
      if (Object.hasOwn(map, spec)) continue;
      const target = resolveBare(spec, stringEntries(map));
      const file = target !== null && isRemote(target) ? local(target) : null;
      if (file) entries.push([spec, file]);
    }
    return Object.fromEntries(entries);
  };
  const rewriteGameJs = async (code: string) => rewriteJs(code, await quietSpecifiers(code), gameUrl);

  for (const [rel, { scan }] of pages) {
    const modules = new Map<string, string>();
    for (const code of scan.moduleScripts) modules.set(code, await rewriteGameJs(code));
    const html = read(rel);
    const next = rewriteHtml(html, {
      url: gameUrl,
      importMap: rewriteImportMap,
      moduleScript: (code) => modules.get(code) ?? code,
      style: (css) => rewriteCss(css, gameUrl),
    });
    if (next !== html) fs.writeFileSync(abs(rel), next);
  }
  for (const rel of gameFiles.filter((f) => IS_JS.test(f))) {
    const code = read(rel);
    const next = await rewriteGameJs(code);
    if (next !== code) fs.writeFileSync(abs(rel), next);
  }
  for (const rel of gameFiles.filter((f) => IS_CSS.test(f))) {
    const css = read(rel);
    const next = rewriteCss(css, gameUrl);
    if (next !== css) fs.writeFileSync(abs(rel), next);
  }

  const files = [...vendored].map(([url, v]) => ({ url, path: v.path, sha256: v.sha256 })).sort((a, b) => byCodeUnit(a.url, b.url));
  writeLock(ctx.projectDir, { version: 1, files: Object.fromEntries(files.map((f) => [f.url, { path: f.path, sha256: f.sha256 }])) });
  return { files, warnings: unique(warnings) };
}
