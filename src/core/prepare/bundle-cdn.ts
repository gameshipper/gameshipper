import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx } from '../context.js';
import { listFiles } from '../fsutil.js';
import { gsError, type GsError } from '../result.js';
import { fetchRemote, type Fetched } from './fetcher.js';
import { lockExists, readLock, writeLock } from './lockfile.js';
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

interface Vendored extends Fetched {
  path: string;
}

const IS_HTML = /\.html?$/i;
const IS_JS = /\.m?js$/i;
const IS_CSS = /\.css$/i;

const isBare = (spec: string) => !isRemote(spec) && !isRelative(spec);
const quietSpecifiers = (code: string) => findJsSpecifiers(code).catch((): JsSpecifier[] => []);

export async function bundleCdn(ctx: Ctx, stageDir: string): Promise<BundleResult> {
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

  // Import maps from every page (games almost always have one page).
  const importMap: ImportMap = {};
  const scans = new Map<string, HtmlScan>();
  for (const rel of gameFiles.filter((f) => IS_HTML.test(f))) {
    const scan = scanHtml(read(rel));
    scans.set(rel, scan);
    // Browsers ignore entries that aren't strings; so do we.
    for (const [key, value] of Object.entries(scan.importMap ?? {})) if (typeof value === 'string') importMap[key] = value;
  }

  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (url: string): void => {
    const u = normalizeRemote(url);
    if (queued.has(u)) return;
    queued.add(u);
    queue.push(u);
  };
  // Bare specifiers that resolve through a prefix key ("react-dom/" + "client"). Their vendored file may be
  // named differently from what the prefix implies (".js" added, query hashed), so each gets an exact entry.
  const viaPrefix = new Set<string>();
  const viaImportMap = (spec: string): string | null => {
    const mapped = resolveBare(spec, importMap);
    if (mapped === null || !isRemote(mapped)) return null;
    if (!Object.hasOwn(importMap, spec)) viaPrefix.add(spec);
    return normalizeRemote(mapped);
  };
  const unresolvedBare = (spec: string, where: string): GsError =>
    gsError(
      'BARE_IMPORT_UNRESOLVED',
      `${where} imports "${spec}", which your import map doesn't define.`,
      `Add "${spec}" to the import map in your HTML, pointing at a CDN URL, or add a build step.`,
    );
  const seedFromGameJs = (specs: JsSpecifier[], where: string): void => {
    for (const { specifier } of specs) {
      if (isRemote(specifier)) enqueue(specifier);
      else if (isBare(specifier)) {
        const mapped = viaImportMap(specifier);
        if (mapped) enqueue(mapped);
        else if (resolveBare(specifier, importMap) === null) warnings.push(unresolvedBare(specifier, where));
      }
    }
  };

  // 1. Seed from the game's own files.
  for (const [key, value] of Object.entries(importMap)) if (!key.endsWith('/') && isRemote(value)) enqueue(value);
  for (const [rel, scan] of scans) {
    for (const u of scan.urls) if (isRemote(u)) enqueue(u);
    for (const code of scan.moduleScripts) seedFromGameJs(await specifiers(code, rel), rel);
    for (const css of scan.styles) for (const u of findCssUrls(css)) if (isRemote(u)) enqueue(u);
  }
  for (const rel of gameFiles.filter((f) => IS_JS.test(f))) seedFromGameJs(await specifiers(read(rel), rel), rel);
  for (const rel of gameFiles.filter((f) => IS_CSS.test(f))) for (const u of findCssUrls(read(rel))) if (isRemote(u)) enqueue(u);

  // 2. Download everything reachable. Relative imports resolve against the URL the file was served from.
  const vendored = new Map<string, Vendored>();
  const resolveInVendored = (spec: string, base: string): string | null => {
    if (isRemote(spec)) return normalizeRemote(spec);
    if (isRelative(spec)) return new URL(spec, base).href;
    return viaImportMap(spec);
  };
  while (queue.length) {
    const url = queue.shift() as string;
    const got = await fetchRemote(ctx, url, lock.files[url]?.sha256 ?? null);
    const entry: Vendored = { ...got, path: vendorPathFor(url, got.contentType) };
    vendored.set(url, entry);
    if (IS_JS.test(entry.path)) {
      for (const { specifier } of await specifiers(got.body.toString('utf8'), url)) {
        const r = resolveInVendored(specifier, got.finalUrl);
        if (r) enqueue(r);
        else if (resolveBare(specifier, importMap) === null) warnings.push(unresolvedBare(specifier, url));
      }
    } else if (IS_CSS.test(entry.path)) {
      for (const u of findCssUrls(got.body.toString('utf8'))) if (!u.startsWith('data:')) enqueue(new URL(u, got.finalUrl).href);
    }
  }
  if (vendored.size === 0) {
    if (lockExists(ctx.projectDir)) writeLock(ctx.projectDir, { version: 1, files: {} });
    return { files: [], warnings };
  }

  const local = (url: string): string | null => {
    const v = vendored.get(normalizeRemote(url));
    return v ? `/${v.path}` : null;
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
        const r = resolveInVendored(spec, v.finalUrl);
        return r ? local(r) : null;
      });
      fs.writeFileSync(dest, rewritten);
    } else if (IS_CSS.test(v.path)) {
      const css = v.body.toString('utf8');
      fs.writeFileSync(dest, rewriteCss(css, (u) => (u.startsWith('data:') ? null : local(new URL(u, v.finalUrl).href))));
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
    for (const spec of [...viaPrefix].sort()) {
      if (Object.hasOwn(map, spec)) continue;
      const target = resolveBare(spec, map);
      const file = target !== null && isRemote(target) ? local(target) : null;
      if (file) entries.push([spec, file]);
    }
    return Object.fromEntries(entries);
  };
  const rewriteGameJs = async (code: string) => rewriteJs(code, await quietSpecifiers(code), gameUrl);

  for (const [rel, scan] of scans) {
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

  const files = [...vendored]
    .map(([url, v]) => ({ url, path: v.path, sha256: v.sha256 }))
    .sort((a, b) => a.url.localeCompare(b.url));
  writeLock(ctx.projectDir, { version: 1, files: Object.fromEntries(files.map((f) => [f.url, { path: f.path, sha256: f.sha256 }])) });
  return { files, warnings };
}
