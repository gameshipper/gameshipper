import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFile } from '../fsutil.js';
import { titleCase } from '../names.js';

export interface Detected {
  name: string;
  entry: string | null;
  buildCommand: string | null;
  outputDir: string | null;
  icon: string | null;
}

const BUNDLER_OUTPUT: Record<string, string> = { vite: 'dist', parcel: 'dist', webpack: 'dist', esbuild: 'dist', rollup: 'dist' };
const ICON_CANDIDATES = ['icon.png', 'art/icon.png', 'assets/icon.png', 'public/icon.png'];

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

function findEntry(dir: string): string | null {
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'index.html';
  const html = fs
    .readdirSync(dir)
    .filter((f) => /\.html?$/i.test(f))
    .sort();
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
    icon: ICON_CANDIDATES.find((c) => fs.existsSync(path.join(dir, c))) ?? null,
  };
}
