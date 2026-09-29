import * as fs from 'node:fs';
import * as path from 'node:path';
import { templateError } from './template.js';

/** The npm package folder (the nearest one with a package.json) that dir is in. */
function packageRoot(dir: string): string {
  let d = dir;
  while (!fs.existsSync(path.join(d, 'package.json'))) {
    const up = path.dirname(d);
    if (up === d) return dir;
    d = up;
  }
  return d;
}

/** Copies src to dest (without the top-level entries in skip) and brings the package's LICENSE along. */
function copyNative(src: string, dest: string, skip: readonly string[]): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      return rel === '' || !skip.includes(rel.split(path.sep)[0]);
    },
  });
  const license = path.join(packageRoot(src), 'LICENSE');
  if (fs.existsSync(license) && !fs.existsSync(path.join(dest, 'LICENSE'))) fs.copyFileSync(license, path.join(dest, 'LICENSE'));
}

/**
 * Capacitor points Package.swift at plugins in ../../../node_modules. Copies each plugin into
 * App/CapacitorPlugins/<name> and points Package.swift there. Returns the copied package names.
 */
export function vendorIos(iosDir: string): string[] {
  const spmDir = path.join(iosDir, 'App', 'CapApp-SPM');
  const file = path.join(spmDir, 'Package.swift');
  const vendored: string[] = [];
  const text = fs.readFileSync(file, 'utf8').replace(/\.package\(name: "([^"]+)", path: "([^"]+)"\)/g, (whole, name: string, rel: string) => {
    if (!rel.includes('node_modules')) return whole;
    copyNative(path.resolve(spmDir, rel), path.join(iosDir, 'App', 'CapacitorPlugins', name), ['android', 'dist', 'node_modules']);
    vendored.push(name);
    return `.package(name: "${name}", path: "../CapacitorPlugins/${name}")`;
  });
  if (text.includes('node_modules')) throw templateError('Package.swift still points into node_modules');
  fs.writeFileSync(file, text);
  return vendored;
}

/**
 * Capacitor's Android project loads its own library and plugins from ../node_modules. Copies each into
 * capacitor-libs/<module> and points capacitor.settings.gradle there. Returns the copied module names.
 */
export function vendorAndroid(androidDir: string): string[] {
  const file = path.join(androidDir, 'capacitor.settings.gradle');
  const vendored: string[] = [];
  const text = fs.readFileSync(file, 'utf8').replace(/project\(':([^']+)'\)\.projectDir = new File\('([^']+)'\)/g, (whole, name: string, rel: string) => {
    if (!rel.includes('node_modules')) return whole;
    copyNative(path.resolve(androidDir, rel), path.join(androidDir, 'capacitor-libs', name), ['build']);
    vendored.push(name);
    return `project(':${name}').projectDir = new File('capacitor-libs/${name}')`;
  });
  if (text.includes('node_modules')) throw templateError('capacitor.settings.gradle still points into node_modules');
  fs.writeFileSync(file, text);
  return vendored;
}
