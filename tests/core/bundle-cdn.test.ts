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
    // Redirects to a module with a relative import, which must resolve against the final URL.
    '/latest': { redirect: '/three@1/build/three.module.js' },
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
    expect(vendored('latest.js')).toContain(`from '${V}/three@1/build/three.core.js'`);
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

  it('warns CDN_CHANGED, keeps building and updates the lock when a locked file changes upstream', async () => {
    const projectDir = makeTmpDir();
    const stage1 = path.join(projectDir, 'stage1');
    makeGame(stage1);
    await bundleCdn(testCtx(projectDir), stage1);
    const coreUrl = `${server.base}/three@1/build/three.core.js`;
    const before = readLock(projectDir).files[coreUrl].sha256;
    server.routes['/three@1/build/three.core.js'] = { body: 'export const Core = 2;', type: JS };
    const stage2 = path.join(projectDir, 'stage2');
    makeGame(stage2);

    const result = await bundleCdn(testCtx(projectDir, makeTmpDir()), stage2);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('CDN_CHANGED');
    expect(result.warnings[0].message).toContain(coreUrl);
    expect(result.warnings[0].message).toContain(`${server.base}/three@1/build/three.module.js`); // what pulled it in
    expect(readText(stage2, `${V.slice(1)}/three@1/build/three.core.js`)).toBe('export const Core = 2;');
    const after = readLock(projectDir).files[coreUrl].sha256;
    expect(after).not.toBe(before);
    expect(after).toBe(result.files.find((f) => f.url === coreUrl)?.sha256);
  });

  it('CDN_CHANGED is an error with frozenLock', async () => {
    const projectDir = makeTmpDir();
    const stage1 = path.join(projectDir, 'stage1');
    makeGame(stage1);
    await bundleCdn(testCtx(projectDir), stage1);
    const lockBefore = readText(projectDir, 'gameshipper.lock');
    server.routes['/three@1/build/three.core.js'] = { body: 'export const Core = 2;', type: JS };
    const stage2 = path.join(projectDir, 'stage2');
    makeGame(stage2);

    await expect(bundleCdn(testCtx(projectDir, makeTmpDir()), stage2, { frozenLock: true })).rejects.toMatchObject({
      error: {
        code: 'CDN_CHANGED',
        message: expect.stringContaining(`${server.base}/three@1/build/three.core.js`),
        fix: 'Run a build without --frozen-lock to accept the new version, or pin an exact version in the URL.',
      },
    });
    expect(readText(projectDir, 'gameshipper.lock')).toBe(lockBefore);
  });

  it('frozenLock builds normally when nothing changed', async () => {
    const projectDir = makeTmpDir();
    makeGame(path.join(projectDir, 'stage1'));
    await bundleCdn(testCtx(projectDir), path.join(projectDir, 'stage1'));
    makeGame(path.join(projectDir, 'stage2'));
    const result = await bundleCdn(testCtx(projectDir, makeTmpDir()), path.join(projectDir, 'stage2'), { frozenLock: true });
    expect(result.warnings).toEqual([]);
    expect(result.files).toHaveLength(7);
  });

  it('CDN_NOT_LOCKED with frozenLock when there is no lock yet, without downloading or writing one', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    makeGame(stageDir);

    await expect(bundleCdn(testCtx(projectDir), stageDir, { frozenLock: true })).rejects.toMatchObject({
      error: {
        code: 'CDN_NOT_LOCKED',
        message: expect.stringContaining(`${server.base}/three@1/build/three.module.js`),
        fix: 'Run a build without --frozen-lock once to record it in gameshipper.lock.',
      },
    });
    expect(server.hits).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, 'gameshipper.lock'))).toBe(false);
  });

  it('CDN_NOT_LOCKED with frozenLock when the game loads a URL the lock does not record', async () => {
    const projectDir = makeTmpDir();
    makeGame(path.join(projectDir, 'stage1'));
    await bundleCdn(testCtx(projectDir), path.join(projectDir, 'stage1'));
    const lockBefore = readText(projectDir, 'gameshipper.lock');
    server.routes['/extra.js'] = { body: 'window.EXTRA = 1;', type: JS };
    const stage2 = path.join(projectDir, 'stage2');
    makeGame(stage2);
    writeFiles(stage2, { 'extra.html': `<script src="${server.base}/extra.js"></script>` });

    await expect(bundleCdn(testCtx(projectDir, makeTmpDir()), stage2, { frozenLock: true })).rejects.toMatchObject({
      error: { code: 'CDN_NOT_LOCKED', message: expect.stringContaining(`${server.base}/extra.js`) },
    });
    expect(readText(projectDir, 'gameshipper.lock')).toBe(lockBefore);
  });

  it('frozenLock never rewrites the lock, even when the game stops loading remote files', async () => {
    const projectDir = makeTmpDir();
    makeGame(path.join(projectDir, 'stage1'));
    await bundleCdn(testCtx(projectDir), path.join(projectDir, 'stage1'));
    const lockBefore = readText(projectDir, 'gameshipper.lock');
    const plain = path.join(projectDir, 'plain');
    writeFiles(plain, { 'index.html': '<script src="./game.js"></script>', 'game.js': 'console.log(1)' });

    const result = await bundleCdn(testCtx(projectDir), plain, { frozenLock: true });

    expect(result.files).toEqual([]);
    expect(readText(projectDir, 'gameshipper.lock')).toBe(lockBefore);
  });

  it('frozenLock keeps an optional file that is still missing a warning, and fails once it appears', async () => {
    server.routes['/opt/mod.js'] = { body: "export const load = () => import('./later.js');", type: JS };
    const projectDir = makeTmpDir();
    const game = (stageDir: string) => writeFiles(stageDir, { 'index.html': `<script type="module" src="${server.base}/opt/mod.js"></script>` });
    game(path.join(projectDir, 'stage1'));
    await bundleCdn(testCtx(projectDir), path.join(projectDir, 'stage1'));
    game(path.join(projectDir, 'stage2'));

    const again = await bundleCdn(testCtx(projectDir, makeTmpDir()), path.join(projectDir, 'stage2'), { frozenLock: true });
    expect(again.warnings.map((w) => w.code)).toEqual(['CDN_OPTIONAL_MISSING']);

    server.routes['/opt/later.js'] = { body: 'export const later = 1;', type: JS };
    game(path.join(projectDir, 'stage3'));
    await expect(bundleCdn(testCtx(projectDir, makeTmpDir()), path.join(projectDir, 'stage3'), { frozenLock: true })).rejects.toMatchObject({
      error: { code: 'CDN_NOT_LOCKED', message: expect.stringContaining(`${server.base}/opt/later.js`) },
    });
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

  it('does not warn when a CDN module imports a name the import map points at a local file', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, {
      'index.html': `<script type="importmap">{"imports":{"three":"./three.js","three/addons/":"${server.base}/three@1/examples/jsm/"}}</script>`,
      'three.js': 'export const THREE = 1;',
      'main.js': "import { Orbit } from 'three/addons/controls/Orbit.js';",
    });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.warnings).toEqual([]);
    expect(result.files.map((f) => f.path)).toEqual([`${V.slice(1)}/three@1/examples/jsm/controls/Orbit.js`]);
  });

  it('empties an existing lock when the game no longer loads remote files', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    makeGame(stageDir);
    await bundleCdn(testCtx(projectDir), stageDir);
    const plain = path.join(projectDir, 'plain');
    writeFiles(plain, { 'index.html': '<script src="./game.js"></script>', 'game.js': 'console.log(1)' });

    await bundleCdn(testCtx(projectDir), plain);

    expect(readLock(projectDir)).toEqual({ version: 1, files: {} });
  });

  it('ignores import-map entries that are not strings', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, {
      'index.html': `<script type="importmap">{"imports":{"bad":1,"three":"${server.base}/three@1/build/three.core.js"}}</script>`,
      'main.js': "import 'three';",
    });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.files).toHaveLength(1);
    expect(readText(stageDir, 'index.html')).toContain('"bad": 1');
  });

  it('bundles each page with its own import map and warns IMPORT_MAP_CONFLICT', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    const level = '<script type="importmap">{"imports":{"three":"./three.js"}}</script><script type="module">import \'three\';</script>';
    writeFiles(stageDir, {
      'index.html': `<script type="importmap">{"imports":{"three":"${server.base}/three@1/build/three.core.js"}}</script><script type="module">import 'three';</script>`,
      'level.html': level,
      'three.js': 'export const Core = 0;',
    });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.files.map((f) => f.path)).toEqual([`${V.slice(1)}/three@1/build/three.core.js`]);
    expect(readText(stageDir, 'index.html')).toContain(`"three": "${V}/three@1/build/three.core.js"`);
    expect(readText(stageDir, 'level.html')).toBe(level);
    expect(result.warnings.map((w) => w.code)).toEqual(['IMPORT_MAP_CONFLICT']);
    expect(result.warnings[0].message).toContain('index.html');
    expect(result.warnings[0].message).toContain('level.html');
  });

  it('no IMPORT_MAP_CONFLICT when pages in different folders point at the same file', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, {
      'index.html': '<script type="importmap">{"imports":{"three":"./three.js"}}</script>',
      'levels/one.html': '<script type="importmap">{"imports":{"three":"../three.js"}}</script>',
      'three.js': 'export const Core = 0;',
    });
    const result = await bundleCdn(testCtx(projectDir), stageDir);
    expect(result.warnings).toEqual([]);
  });

  it('finishes when downloaded modules import each other', async () => {
    server.routes['/cycle/a.js'] = { body: "import { b } from './b.js';\nexport const a = 1;", type: JS };
    server.routes['/cycle/b.js'] = { body: "import { a } from './a.js';\nexport const b = 2;", type: JS };
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, { 'index.html': `<script type="module" src="${server.base}/cycle/a.js"></script>` });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.files).toHaveLength(2);
    expect(readText(stageDir, `${V.slice(1)}/cycle/a.js`)).toContain(`from '${V}/cycle/b.js'`);
    expect(readText(stageDir, `${V.slice(1)}/cycle/b.js`)).toContain(`from '${V}/cycle/a.js'`);
    expect(server.hits.filter((h) => h.startsWith('/cycle/'))).toEqual(['/cycle/a.js', '/cycle/b.js']);
  });

  it('warns CDN_OPTIONAL_MISSING for files only a downloaded file refers to', async () => {
    server.routes['/opt/mod.js'] = {
      body: "export const load = () => import('./missing.js');\nexport const slow = () => import('./slow.js');",
      type: JS,
    };
    server.routes['/opt/slow.js'] = { hang: true };
    server.routes['/opt/style.css'] = { body: '.a { background: url(gone.png); } .b { background: url(about:blank); }', type: 'text/css' };
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, {
      'index.html': `<link rel="stylesheet" href="${server.base}/opt/style.css"><script type="module" src="${server.base}/opt/mod.js"></script>`,
    });

    const result = await bundleCdn(testCtx(projectDir), stageDir, { timeoutMs: 200 });

    expect(result.files.map((f) => f.url)).toEqual([`${server.base}/opt/mod.js`, `${server.base}/opt/style.css`]);
    expect(result.warnings.map((w) => w.code)).toEqual(['CDN_OPTIONAL_MISSING', 'CDN_OPTIONAL_MISSING', 'CDN_OPTIONAL_MISSING']);
    const messages = result.warnings.map((w) => w.message).join('\n');
    expect(messages).toContain(`${server.base}/opt/missing.js`);
    expect(messages).toContain('timed out');
    expect(messages).toContain(`${server.base}/opt/gone.png`);
    expect(messages).toContain(`${server.base}/opt/style.css`); // what referred to it
    expect(server.hits).not.toContain('/opt/about:blank');
    expect(readText(stageDir, `${V.slice(1)}/opt/style.css`)).toContain('url(about:blank)');
    // What was left out still loads from the internet, instead of a local path that doesn't exist.
    const mod = readText(stageDir, `${V.slice(1)}/opt/mod.js`);
    expect(mod).toContain(`import(${JSON.stringify(`${server.base}/opt/missing.js`)})`);
    expect(mod).toContain(`import(${JSON.stringify(`${server.base}/opt/slow.js`)})`);
    expect(readText(stageDir, `${V.slice(1)}/opt/style.css`)).toContain(`url(${server.base}/opt/gone.png)`);
  });

  describe('static imports inside downloaded modules', () => {
    const game = (stageDir: string) => writeFiles(stageDir, { 'index.html': `<script type="module" src="${server.base}/net/mod.js"></script>` });
    beforeEach(() => {
      server.routes['/net/mod.js'] = { body: "import { dep } from './dep.js';\nexport const load = () => import('./later.js');\nexport const m = dep;", type: JS };
    });

    it('retries a network error once', async () => {
      server.routes['/net/dep.js'] = { body: 'export const dep = 1;', type: JS, reset: 1 };
      server.routes['/net/later.js'] = { body: 'export const later = 1;', type: JS };
      const projectDir = makeTmpDir();
      const stageDir = path.join(projectDir, 'stage');
      game(stageDir);

      const result = await bundleCdn(testCtx(projectDir), stageDir);

      expect(result.warnings).toEqual([]);
      expect(server.hits.filter((h) => h === '/net/dep.js')).toHaveLength(2);
      expect(readText(stageDir, `${V.slice(1)}/net/mod.js`)).toContain(`from '${V}/net/dep.js'`);
    });

    it('CDN_FETCH_FAILED when the retry fails too: the module cannot load without it', async () => {
      server.routes['/net/dep.js'] = { body: 'export const dep = 1;', type: JS, reset: 2 };
      const projectDir = makeTmpDir();
      const stageDir = path.join(projectDir, 'stage');
      game(stageDir);

      const failure = await bundleCdn(testCtx(projectDir), stageDir).catch((e) => e);

      expect(failure).toMatchObject({ error: { code: 'CDN_FETCH_FAILED' } });
      expect(failure.error.message).toContain(`${server.base}/net/dep.js`);
      expect(failure.error.message).toContain(`${server.base}/net/mod.js`); // what imports it
      expect(server.hits.filter((h) => h === '/net/dep.js')).toHaveLength(2);
    });

    it('CDN_OPTIONAL_MISSING, without a retry, when the server answers with an HTTP error', async () => {
      server.routes['/net/later.js'] = { body: 'export const later = 1;', type: JS };
      const projectDir = makeTmpDir();
      const stageDir = path.join(projectDir, 'stage');
      game(stageDir);

      const result = await bundleCdn(testCtx(projectDir), stageDir);

      expect(result.warnings.map((w) => [w.code, w.message])).toEqual([['CDN_OPTIONAL_MISSING', expect.stringContaining(`${server.base}/net/dep.js`)]]);
      expect(server.hits.filter((h) => h === '/net/dep.js')).toHaveLength(1);
      expect(readText(stageDir, `${V.slice(1)}/net/mod.js`)).toContain(`from '${server.base}/net/dep.js'`);
    });

    it('dynamic imports stay optional on a network error', async () => {
      server.routes['/net/dep.js'] = { body: 'export const dep = 1;', type: JS };
      server.routes['/net/later.js'] = { body: 'export const later = 1;', type: JS, reset: 2 };
      const projectDir = makeTmpDir();
      const stageDir = path.join(projectDir, 'stage');
      game(stageDir);

      const result = await bundleCdn(testCtx(projectDir), stageDir);

      expect(result.warnings.map((w) => w.code)).toEqual(['CDN_OPTIONAL_MISSING']);
      expect(result.warnings[0].message).toContain(`${server.base}/net/later.js`);
      expect(server.hits.filter((h) => h === '/net/later.js')).toHaveLength(1);
    });
  });

  it('CDN_FETCH_FAILED when a file the game refers to directly is missing', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, { 'index.html': `<script src="${server.base}/nope.js"></script>` });
    await expect(bundleCdn(testCtx(projectDir), stageDir)).rejects.toMatchObject({ error: { code: 'CDN_FETCH_FAILED' } });
  });

  it('keeps #fragments when rewriting url() in downloaded CSS', async () => {
    server.routes['/icons/style.css'] = { body: '.i { mask: url("sprite.svg#play"); }', type: 'text/css' };
    server.routes['/icons/sprite.svg'] = { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', type: 'image/svg+xml' };
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, { 'index.html': `<link rel="stylesheet" href="${server.base}/icons/style.css">` });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.files.map((f) => f.url)).toEqual([`${server.base}/icons/sprite.svg`, `${server.base}/icons/style.css`]);
    expect(readText(stageDir, `${V.slice(1)}/icons/style.css`)).toBe(`.i { mask: url("${V}/icons/sprite.svg#play"); }`);
  });

  it('gives colliding vendored files distinct paths instead of overwriting', async () => {
    const routes: Record<string, string> = {
      '/dup/lib': 'export const v = "lib (no extension)";',
      '/dup/lib.js': 'export const v = "lib.js";',
      '/dup/A.js': 'export const v = "A";',
      '/dup/a.js': 'export const v = "a";', // same file as A.js on macOS and Windows
      '/chart.js': 'export const v = "chart";',
      '/chart.js/helpers': 'export const v = "helpers";', // needs chart.js to be a folder
    };
    for (const [route, body] of Object.entries(routes)) server.routes[route] = { body, type: JS };
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    const imports = Object.keys(routes).map((r, i) => `import { v as v${i} } from '${server.base}${r}';`);
    writeFiles(stageDir, { 'index.html': '<script type="module" src="./main.js"></script>', 'main.js': imports.join('\n') });

    const result = await bundleCdn(testCtx(projectDir), stageDir);

    expect(result.warnings).toEqual([]);
    const paths = result.files.map((f) => f.path.toLowerCase());
    expect(new Set(paths).size).toBe(6);
    for (const p of paths) expect(paths.some((q) => q.startsWith(`${p}/`))).toBe(false); // no file is also a folder
    const mainJs = readText(stageDir, 'main.js');
    for (const [route, body] of Object.entries(routes)) {
      const file = result.files.find((f) => f.url === `${server.base}${route}`);
      expect(file, route).toBeDefined();
      expect(readText(stageDir, file?.path ?? ''), route).toBe(body);
      expect(mainJs).toContain(`from '/${file?.path}'`);
    }
    // Deterministic: URL order (code units) decides who keeps the plain name.
    expect(result.files.map((f) => f.url.slice(server.base.length))).toEqual(['/chart.js', '/chart.js/helpers', '/dup/A.js', '/dup/a.js', '/dup/lib', '/dup/lib.js']);
    const byRoute = (r: string) => result.files.find((f) => f.url === `${server.base}${r}`)?.path;
    expect(byRoute('/dup/lib')).toBe(`${V.slice(1)}/dup/lib.js`);
    expect(byRoute('/dup/lib.js')).toMatch(new RegExp(`^${V.slice(1)}/dup/lib__[0-9a-f]{8}\\.js$`));
    expect(byRoute('/dup/A.js')).toBe(`${V.slice(1)}/dup/A.js`);
    expect(byRoute('/dup/a.js')).toMatch(new RegExp(`^${V.slice(1)}/dup/a__[0-9a-f]{8}\\.js$`));
    expect(byRoute('/chart.js')).toBe(`${V.slice(1)}/chart__file.js`);
    expect(byRoute('/chart.js/helpers')).toBe(`${V.slice(1)}/chart.js/helpers.js`);
  });

  it('reports each identical warning once', async () => {
    const projectDir = makeTmpDir();
    const stageDir = path.join(projectDir, 'stage');
    writeFiles(stageDir, {
      'index.html': '<script type="module" src="./m.js"></script>',
      'm.js': "import a from 'lodash';\nimport { b } from 'lodash';\nconst c = () => import('lodash');",
    });
    const result = await bundleCdn(testCtx(projectDir), stageDir);
    expect(result.warnings.map((w) => w.code)).toEqual(['BARE_IMPORT_UNRESOLVED']);
  });
});
