import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/schema.js';
import type { Ctx } from '../context.js';
import { listFiles } from '../fsutil.js';
import { slugify } from '../names.js';
import { NATIVE_PACKAGES, packageDir, packageVersion } from './capacitor.js';
import { injectShim, MOBILE_SHIM_JS, SHIM_FILE } from './shim.js';

/** A throwaway Capacitor project; the generated ios/ and android/ folders are moved to out/ afterwards. */
export function mobileWorkDir(projectDir: string): string {
  return path.join(projectDir, '.gameshipper', 'mobile');
}

export function capacitorConfig(config: Config): Record<string, unknown> {
  return {
    appId: config.mobile.bundleId,
    appName: config.name,
    webDir: 'www',
    backgroundColor: '#000000',
    ios: { scrollEnabled: false, contentInset: 'never' },
    ...(config.game.entry === 'index.html' ? {} : { server: { appStartPath: config.game.entry } }),
    plugins: { SystemBars: { hidden: true } },
  };
}

const HTML_PAGE = /\.html?$/i;
/** Files bundled from CDNs (core/prepare/remote.ts VENDOR_ROOT) stay as they were downloaded. */
const BUNDLED = /^_gameshipper\//;

/**
 * Builds <project>/.gameshipper/mobile: package.json, capacitor.config.json, www/ (a copy of the staged game with
 * the saves shim in every page, so a game of several pages has window.gameshipper on each, as on desktop) and
 * node_modules/ with copies of Gameshipper's own Capacitor packages, so the Capacitor CLI finds them wherever npx
 * installed Gameshipper.
 */
export function prepareMobileWorkspace(ctx: Ctx, config: Config, stageDir: string): string {
  const workDir = mobileWorkDir(ctx.projectDir);
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });

  const www = path.join(workDir, 'www');
  fs.cpSync(stageDir, www, { recursive: true });
  const pages = new Set([config.game.entry, ...listFiles(www).filter((f) => HTML_PAGE.test(f) && !BUNDLED.test(f))]);
  for (const rel of pages) {
    const page = path.join(www, ...rel.split('/'));
    fs.writeFileSync(page, injectShim(fs.readFileSync(page, 'utf8')));
  }
  const shim = path.join(www, ...SHIM_FILE.split('/'));
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, MOBILE_SHIM_JS);
  // The Capacitor CLI insists on www/index.html; the app itself starts at server.appStartPath.
  const index = path.join(www, 'index.html');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, `<!DOCTYPE html><meta charset="utf-8"><script>location.replace(${JSON.stringify(config.game.entry)})</script>\n`);
  }

  const dependencies = Object.fromEntries(NATIVE_PACKAGES.map((name) => [name, packageVersion(name)]));
  const pkg = { name: `${slugify(config.name)}-mobile`, version: config.version, private: true, dependencies };
  fs.writeFileSync(path.join(workDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(workDir, 'capacitor.config.json'), `${JSON.stringify(capacitorConfig(config), null, 2)}\n`);
  for (const name of NATIVE_PACKAGES) {
    fs.cpSync(packageDir(name), path.join(workDir, 'node_modules', ...name.split('/')), { recursive: true, dereference: true });
  }
  ctx.log(`prepared mobile workspace ${workDir}`);
  return workDir;
}
