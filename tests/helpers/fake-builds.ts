import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../src/core/config/load.js';
import type { Config, DesktopTarget } from '../../src/core/config/schema.js';
import { executableFor, macAppFor } from '../../src/core/desktop/package.js';
import { findDesktopBuilds, type DesktopBuild } from '../../src/core/publish/builds.js';
import { makeTmpDir, writeFiles } from './tmp.js';

/** Stand-ins for SteamCMD and butler (tests/helpers/fake-steamcmd.mjs, fake-butler.mjs). */
export const FAKE_STEAMCMD = fileURLToPath(new URL('./fake-steamcmd.mjs', import.meta.url));
export const FAKE_BUTLER = fileURLToPath(new URL('./fake-butler.mjs', import.meta.url));

export interface FakeProject {
  dir: string;
  config: Config;
  builds: DesktopBuild[];
}

/**
 * A game folder with gameshipper.json and out/<target> folders shaped like real builds, without Electron: the
 * executable where executableFor expects it, a resources file and a license, and on macOS and Linux a framework
 * symlink inside the Mac app.
 */
export function fakeProject(raw: Record<string, unknown> = {}, built: DesktopTarget[] = ['windows', 'mac', 'linux']): FakeProject {
  const dir = makeTmpDir('gs-pub-');
  const json = { name: 'Moon Game', version: '1.2.3', targets: built.length ? built : ['windows'], ...raw };
  writeFiles(dir, { 'index.html': '<html></html>', 'gameshipper.json': JSON.stringify(json, null, 2) });
  const config = parseConfig(json).data!;
  for (const target of built) {
    const out = path.join(dir, 'out', target);
    const exe = executableFor(config, target, out);
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '#!/bin/sh\necho game\n', { mode: 0o755 });
    writeFiles(out, { LICENSE: 'MIT' });
    const resources = target === 'mac' ? path.join(macAppFor(config, out), 'Contents', 'Resources') : path.join(out, 'resources');
    writeFiles(resources, { 'app.asar': `${target} app` });
    if (target === 'mac' && process.platform !== 'win32') {
      const fw = path.join(macAppFor(config, out), 'Contents', 'Frameworks', 'X.framework');
      writeFiles(fw, { 'Versions/A/X': 'lib' });
      fs.symlinkSync('A', path.join(fw, 'Versions', 'Current'));
    }
  }
  return { dir, config, builds: findDesktopBuilds(dir, config).builds };
}
