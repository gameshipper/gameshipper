import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleCdn } from '../../src/core/prepare/bundle-cdn.js';
import { readLock } from '../../src/core/prepare/lockfile.js';
import { testCtx } from '../helpers/ctx.js';
import { startServer, type TestServer } from '../helpers/server.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

const JS = 'text/javascript; charset=utf-8';
let server: TestServer;
let V: string; // vendored root for this server, e.g. /_gameshipper/cdn/127.0.0.1_51234

beforeEach(async () => {
  server = await startServer({
    '/three@1/build/three.module.js': { body: "import { Core } from './three.core.js';\nexport const THREE = Core;", type: JS },
    '/three@1/build/three.core.js': { body: 'export const Core = 1;', type: JS },
    '/three@1/examples/jsm/controls/Orbit.js': { body: "import { THREE } from 'three';\nexport const Orbit = THREE;", type: JS },
    '/lib?module': { body: 'window.LIB = 1;', type: JS },
    '/fonts.css': { body: '@font-face { src: url(/font.woff2) format("woff2"); }', type: 'text/css' },
    '/font.woff2': { body: Buffer.from([1, 2, 3]), type: 'font/woff2' },
    '/latest': { redirect: '/three@1/build/three.core.js' },
  });
  V = `/_gameshipper/cdn/127.0.0.1_${server.port}`;
});
afterEach(() => server.close());

function makeGame(stageDir: string): void {
  const b = server.base;
  writeFiles(stageDir, {
    'index.html': `<!DOCTYPE html><html><head>
<script type="importmap">{"imports":{"three":"${b}/three@1/build/three.module.js","three/addons/":"${b}/three@1/examples/jsm/"}}</script>
<link rel="stylesheet" href="${b}/fonts.css" integrity="sha384-x" crossorigin="anonymous">
<script src="${b}/lib?module"></script>
</head><body><script type="module" src="./main.js"></script></body></html>`,
    'main.js': `import { THREE } from 'three';\nimport { Orbit } from 'three/addons/controls/Orbit.js';\nimport core from '${b}/latest';\nconsole.log(THREE, Orbit, core);`,
  });
}

describe('bundleCdn', () => {
  it('vendors everything reachable and rewrites references', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, '.gameshipper', 'stage');
    makeGame(stageDir);

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.warnings).toEqual([]);
    expect(result.files).toHaveLength(7);
    const html = readText(stageDir, 'index.html');
    expect(html).toContain(`"three": "${V}/three@1/build/three.module.js"`);
    expect(html).toContain(`"three/addons/": "${V}/three@1/examples/jsm/"`);
    expect(html).toContain(`<link rel="stylesheet" href="${V}/fonts.css">`);
    expect(html).toMatch(new RegExp(`<script src="${V}/lib__q[0-9a-f]{10}\\.js"></script>`));

    const mainJs = readText(stageDir, 'main.js');
    expect(mainJs).toContain(`from '${V}/latest.js'`);
    expect(mainJs).toContain("from 'three'");

    const vendored = (rel: string) => readText(stageDir, `${V.slice(1)}/${rel}`);
    expect(vendored('three@1/build/three.module.js')).toContain(`from '${V}/three@1/build/three.core.js'`);
    expect(vendored('three@1/build/three.core.js')).toBe('export const Core = 1;');
    expect(vendored('three@1/examples/jsm/controls/Orbit.js')).toContain("from 'three'");
    expect(vendored('fonts.css')).toContain(`url(${V}/font.woff2)`);
    expect(fs.readFileSync(path.join(stageDir, `${V.slice(1)}/font.woff2`))).toEqual(Buffer.from([1, 2, 3]));

    expect(Object.keys(readLock(projectDir).files)).toHaveLength(7);
  });

  it('rebuilds identically from the cache with the server gone', async () => {
    const projectDir = makeTmpDir();
    const cacheDir = makeTmpDir();
    const stage1 = path.join(projectDir, 'stage1');
    makeGame(stage1);
    await bundleCdn(testCtx(projectDir, cacheDir), stage1);
    const stage2 = path.join(projectDir, 'stage2');
    makeGame(stage2);
    await server.close();

    await bundleCdn(testCtx(projectDir, cacheDir), stage2);

    expect(readText(stage2, 'index.html')).toBe(readText(stage1, 'index.html'));
    expect(readText(stage2, 'main.js')).toBe(readText(stage1, 'main.js'));
  });

  it('CDN_CHANGED when a locked file changes upstream', async () => {
    const projectDir = makeTmpDir();
    const stage1 = path.join(projectDir, 'stage1');
    makeGame(stage1);
    await bundleCdn(testCtx(projectDir), stage1);
    server.routes['/three@1/build/three.core.js'] = { body: 'export const Core = 2;', type: JS };
    const stage2 = path.join(projectDir, 'stage2');
    makeGame(stage2);

    await expect(bundleCdn(testCtx(projectDir, makeTmpDir()), stage2)).rejects.toMatchObject({ error: { code: 'CDN_CHANGED' } });
  });

  it('leaves a game without remote files untouched and writes no lock', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    const html = '<html>\n  <body><script src="./game.js"></script></body>\n</html>\n';
    writeFiles(stageDir, { 'index.html': html, 'game.js': 'console.log(1)' });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.files).toEqual([]);
    expect(readText(stageDir, 'index.html')).toBe(html);
    expect(fs.existsSync(path.join(projectDir, 'gameshipper.lock'))).toBe(false);
  });

  it('adds exact import-map entries for modules reached through a prefix', async () => {
    // Served without an extension: the vendored copy is saved as client.js / server.js.
    server.routes['/react-dom@18/client'] = { body: "import { s } from 'react-dom/server';\nexport const c = s;", type: 'text/javascript' };
    server.routes['/react-dom@18/server'] = { body: 'export const s = 1;', type: 'text/javascript' };
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, {
      'index.html': `<script type="importmap">{"imports":{"react-dom/":"${server.base}/react-dom@18/"}}</script>\n<script type="module" src="./main.js"></script>`,
      'main.js': "import { c } from 'react-dom/client';\nconsole.log(c);",
    });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.warnings).toEqual([]);
    const html = readText(stageDir, 'index.html');
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as { imports: object };
    expect(map.imports).toEqual({
      'react-dom/': `${V}/react-dom@18/`,
      'react-dom/client': `${V}/react-dom@18/client.js`,
      'react-dom/server': `${V}/react-dom@18/server.js`,
    });
    expect(readText(stageDir, `${V.slice(1)}/react-dom@18/client.js`)).toContain("from 'react-dom/server'");
    expect(readText(stageDir, `${V.slice(1)}/react-dom@18/server.js`)).toBe('export const s = 1;');
    expect(readText(stageDir, 'main.js')).toContain("from 'react-dom/client'");
  });

  it('warns about bare imports the import map does not define', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, { 'index.html': '<script type="module" src="./m.js"></script>', 'm.js': "import _ from 'lodash';" });
    const result = await bundleCdn(testCtx(projectDir), stageDir);
    expect(result.warnings.map((w) => w.code)).toEqual(['BARE_IMPORT_UNRESOLVED']);
  });
});
