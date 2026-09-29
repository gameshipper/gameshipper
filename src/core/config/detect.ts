import * as fs from 'node:fs';
import * as path from 'node:path';
import { iconFileProblem } from '../desktop/icons.js';
import { readJsonFile } from '../fsutil.js';
import { titleCase } from '../names.js';

export interface Detected {
  name: string;
  entry: string | null;
  buildCommand: string | null;
  outputDir: string | null;
  /** The first icon candidate that is a square PNG of at least 1024x1024. */
  icon: string | null;
  /** When no candidate qualifies, the first one found and what it is instead ("is 512x512"). */
  unsuitableIcon: { path: string; found: string } | null;
  /** Key art and logo for the store images, found only under unambiguous names (KEY_ART_CANDIDATES, LOGO_CANDIDATES). */
  keyArt: string | null;
  logo: string | null;
}

const BUNDLER_OUTPUT: Record<string, string> = { vite: 'dist', parcel: 'dist', webpack: 'dist', esbuild: 'dist', rollup: 'dist' };
const ICON_CANDIDATES = ['icon.png', 'art/icon.png', 'assets/icon.png', 'public/icon.png'];
// Store art is only picked up under names that can't mean anything else: a game's own logo.png is often an
// opaque in-game image, which the store images can't use (LOGO_NOT_TRANSPARENT).
const KEY_ART_CANDIDATES = ['art/key-art.png', 'art/key-art.jpg', 'key-art.png', 'key-art.jpg'];
const LOGO_CANDIDATES = ['art/logo.png', 'art/store-logo.png', 'store-logo.png'];

interface PackageJson {
  name?: unknown;
  productName?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    return readJsonFile(path.join(dir, 'package.json')) as PackageJson;
  } catch {
    return null;
  }
}

function findIcon(dir: string): Pick<Detected, 'icon' | 'unsuitableIcon'> {
  let unsuitableIcon: Detected['unsuitableIcon'] = null;
  for (const candidate of ICON_CANDIDATES) {
    const file = path.join(dir, candidate);
    if (!fs.existsSync(file)) continue;
    const problem = iconFileProblem(file);
    if (!problem) return { icon: candidate, unsuitableIcon: null };
    unsuitableIcon ??= { path: candidate, found: problem.found };
  }
  return { icon: null, unsuitableIcon };
}

function firstExisting(dir: string, candidates: string[]): string | null {
  return candidates.find((c) => fs.existsSync(path.join(dir, c))) ?? null;
}

function findEntry(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'index.html';
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    // A missing or unreadable folder has nothing to detect; the caller reports the folder itself.
    return null;
  }
  const html = files.filter((f) => /\.html?$/i.test(f)).sort();
  return html[0] ?? null;
}

export function detectProject(dir: string): Detected {
  const pkg = readPackageJson(dir);
  let buildCommand: string | null = null;
  let outputDir: string | null = null;
  if (pkg?.scripts && typeof pkg.scripts.build === 'string') {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const bundler = Object.keys(BUNDLER_OUTPUT).find((b) => b in deps);
    if (bundler) {
      buildCommand = 'npm run build';
      outputDir = BUNDLER_OUTPUT[bundler];
    }
  }
  const pkgName = typeof pkg?.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : null;
  const name = typeof pkg?.productName === 'string' ? pkg.productName : titleCase(pkgName ?? path.basename(path.resolve(dir)));
  return {
    name,
    entry: buildCommand ? 'index.html' : findEntry(dir),
    buildCommand,
    outputDir,
    ...findIcon(dir),
    keyArt: firstExisting(dir, KEY_ART_CANDIDATES),
    logo: firstExisting(dir, LOGO_CANDIDATES),
  };
}
