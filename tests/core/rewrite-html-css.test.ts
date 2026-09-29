import { describe, expect, it } from 'vitest';
import { findCssUrls, rewriteCss } from '../../src/core/prepare/rewrite-css.js';
import { rewriteHtml, scanHtml } from '../../src/core/prepare/rewrite-html.js';

const HTML = `<!DOCTYPE html>
<html><head>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.170.0/build/three.module.js"}}</script>
<link rel="stylesheet" href="https://fonts.x/css" integrity="sha384-abc" crossorigin="anonymous">
<style>body { background: url(https://x/bg.png) } a<b{}</style>
<script src="https://x/lib.js"></script>
</head><body>
<img src="./local.png">
<script type="module">if (a < b) { import("https://x/m.js"); }</script>
</body></html>`;

describe('scanHtml', () => {
  it('collects the import map, attribute URLs, inline modules and styles', () => {
    const scan = scanHtml(HTML);
    expect(scan.importMap).toEqual({ three: 'https://unpkg.com/three@0.170.0/build/three.module.js' });
    expect(scan.urls).toEqual(['https://x/lib.js', 'https://fonts.x/css', './local.png']);
    expect(scan.moduleScripts).toEqual(['if (a < b) { import("https://x/m.js"); }']);
    expect(scan.styles).toEqual(['body { background: url(https://x/bg.png) } a<b{}']);
  });

  it('returns a null import map when there is none or it is invalid', () => {
    expect(scanHtml('<script type="importmap">{nope</script>').importMap).toBeNull();
    expect(scanHtml('<p></p>').importMap).toBeNull();
  });
});

describe('rewriteHtml', () => {
  it('rewrites URLs, strips integrity, and rewrites import map, modules and styles', () => {
    const out = rewriteHtml(HTML, {
      url: (u) => (u.startsWith('https://') ? '/v/file' : null),
      importMap: (m) => Object.fromEntries(Object.keys(m).map((k) => [k, '/v/three.js'])),
      moduleScript: (code) => code.replace('https://x/m.js', '/v/m.js'),
      style: (css) => css.replace('https://x/bg.png', '/v/bg.png'),
    });
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<link rel="stylesheet" href="/v/file">');
    expect(out).toContain('<script src="/v/file"></script>');
    expect(out).toContain('<img src="./local.png">');
    expect(out).toContain('"three": "/v/three.js"');
    expect(out).toContain('import("/v/m.js")');
    expect(out).toContain('if (a < b)');
    expect(out).toContain('url(/v/bg.png) } a<b{}');
  });
});

describe('css', () => {
  const CSS = `@import "https://x/base.css";
@font-face { src: url('https://x/f.woff2') format('woff2'), url(data:font/woff2;base64,AA==); }
.a { background: url("./local.png"); }`;

  it('finds url() and @import references', () => {
    expect(findCssUrls(CSS)).toEqual(['https://x/base.css', 'https://x/f.woff2', 'data:font/woff2;base64,AA==', './local.png']);
  });

  it('rewrites the ones the callback maps, keeping quotes', () => {
    const out = rewriteCss(CSS, (u) => (u.startsWith('https://') ? `/v/${u.split('/').pop()}` : null));
    expect(out).toContain('@import "/v/base.css";');
    expect(out).toContain("url('/v/f.woff2')");
    expect(out).toContain('url(data:font/woff2;base64,AA==)');
    expect(out).toContain('url("./local.png")');
  });
});
