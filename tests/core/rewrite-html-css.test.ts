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

describe('rewriteHtml keeps the original markup', () => {
  const urlOnly = (map: Record<string, string>) => ({
    url: (u: string) => map[u] ?? null,
    importMap: (m: Record<string, string>) => m,
    moduleScript: (code: string) => code,
    style: (css: string) => css,
  });

  it('keeps options with implied end tags', () => {
    const html = '<select><option>Low<option selected>High</select>\n<img src="https://x/a.png">';
    expect(rewriteHtml(html, urlOnly({ 'https://x/a.png': '/v/a.png' }))).toBe(html.replace('https://x/a.png', '/v/a.png'));
  });

  it('keeps table cells and rows with implied end tags', () => {
    const html = '<table><tr><td>a<td>b<tr><td>c</table><img src="https://x/a.png">';
    expect(rewriteHtml(html, urlOnly({ 'https://x/a.png': '/v/a.png' }))).toBe(html.replace('https://x/a.png', '/v/a.png'));
  });

  it('keeps the doctype, comments, whitespace, entities and line endings', () => {
    const html =
      '<!DOCTYPE html>\r\n<!-- <img src="https://x/a.png"> -->\r\n<HTML>\r\n  <body class=game>\r\n' +
      '    <p>Tom &amp; Jerry&nbsp;&copy;</p>\r\n    <IMG  SRC="https://x/a.png"  alt=\'\'>\r\n';
    const out = rewriteHtml(html, urlOnly({ 'https://x/a.png': '/v/a.png' }));
    expect(out).toBe(html.replace('SRC="https://x/a.png"', 'SRC="/v/a.png"'));
  });

  it('returns the input unchanged when nothing is rewritten', () => {
    const html =
      '<!doctype html><title>x</title>\n<script type="importmap">{"imports":{"three":"https://x/three.js"}}</script>\n' +
      '<style>a{b:c}</style><script type=module>import "three";</script><p>unclosed<li>item<img src=x.png>';
    expect(rewriteHtml(html, urlOnly({}))).toBe(html);
  });

  it('keeps attribute names and quote style, and quotes unquoted values', () => {
    const html = `<img SRC=https://x/a.png><img src='https://x/b.png'><img src = "https://x/c.png">`;
    const out = rewriteHtml(html, urlOnly({ 'https://x/a.png': '/v/a.png', 'https://x/b.png': '/v/b.png', 'https://x/c.png': '/v/c.png' }));
    expect(out).toBe(`<img SRC="/v/a.png"><img src='/v/b.png'><img src = "/v/c.png">`);
  });

  it('decodes attribute values for the callback and escapes the new value', () => {
    const html = '<img src="https://x/a.png?w=1&amp;h=2">';
    expect(scanHtml(html).urls).toEqual(['https://x/a.png?w=1&h=2']);
    const out = rewriteHtml(html, urlOnly({ 'https://x/a.png?w=1&h=2': '/v/a.png?q=1&r="2"' }));
    expect(out).toBe('<img src="/v/a.png?q=1&amp;r=&quot;2&quot;">');
  });

  it('removes integrity and crossorigin with their whitespace only on rewritten elements', () => {
    const html =
      '<script\n  src="https://x/lib.js"\n  integrity="sha384-abc"\n  crossorigin></script>\n' +
      '<script src="./local.js" integrity="sha384-def" crossorigin="anonymous"></script>';
    const out = rewriteHtml(html, urlOnly({ 'https://x/lib.js': '/v/lib.js' }));
    expect(out).toBe(
      '<script\n  src="/v/lib.js"></script>\n<script src="./local.js" integrity="sha384-def" crossorigin="anonymous"></script>',
    );
  });

  it('splices inline module and style text without touching the rest', () => {
    const html = '<style>\r\n  a { background: url(https://x/bg.png) }\r\n</style>\r\n<script type="module">\r\n  import "https://x/m.js";\r\n</script>';
    const out = rewriteHtml(html, {
      ...urlOnly({}),
      moduleScript: (code) => code.replace('https://x/m.js', '/v/m.js'),
      style: (css) => css.replace('https://x/bg.png', '/v/bg.png'),
    });
    expect(out).toBe(html.replace('https://x/m.js', '/v/m.js').replace('https://x/bg.png', '/v/bg.png'));
  });
});

describe('scanHtml details', () => {
  it('matches script types case-insensitively', () => {
    const scan = scanHtml('<script TYPE="ImportMap">{"imports":{"a":"https://x/a.js"}}</script><script type="MODULE">go()</script>');
    expect(scan.importMap).toEqual({ a: 'https://x/a.js' });
    expect(scan.moduleScripts).toEqual(['go()']);
  });

  it('collects only the Google Fonts stylesheet, not its preconnect links', () => {
    const html = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto&display=swap" rel="stylesheet">`;
    expect(scanHtml(html).urls).toEqual(['https://fonts.googleapis.com/css2?family=Roboto&display=swap']);
    const out = rewriteHtml(html, { url: () => '/v/f.css', importMap: (m) => m, moduleScript: (c) => c, style: (c) => c });
    expect(out).toBe(html.replace('https://fonts.googleapis.com/css2?family=Roboto&display=swap', '/v/f.css'));
  });

  it('collects <link> URLs only for rels that load a resource', () => {
    const rels = ['stylesheet', 'modulepreload', 'PRELOAD', 'shortcut icon', 'apple-touch-icon', 'canonical', 'dns-prefetch', 'manifest', ''];
    const html = rels.map((rel, i) => `<link rel="${rel}" href="https://x/${i}">`).join('\n') + '\n<link href="https://x/no-rel">';
    expect(scanHtml(html).urls).toEqual(['https://x/0', 'https://x/1', 'https://x/2', 'https://x/3', 'https://x/4']);
  });

  it('looks inside <template> content', () => {
    const html = '<template><img src="https://x/t.png"><style>b{}</style></template>';
    expect(scanHtml(html).urls).toEqual(['https://x/t.png']);
    expect(scanHtml(html).styles).toEqual(['b{}']);
    const out = rewriteHtml(html, {
      url: () => '/v/t.png',
      importMap: (m) => m,
      moduleScript: (c) => c,
      style: (c) => c,
    });
    expect(out).toBe('<template><img src="/v/t.png"><style>b{}</style></template>');
  });
});

describe('css', () => {
  const CSS = `@import "https://x/base.css";
@font-face { src: url('https://x/f.woff2') format('woff2'), url(data:font/woff2;base64,AA==); }
.a { background: url("./local.png"); }`;

  it('finds url() and @import references', () => {
    expect(findCssUrls(CSS)).toEqual(['https://x/base.css', 'https://x/f.woff2', './local.png']);
  });

  it('rewrites the ones the callback maps, keeping quotes', () => {
    const out = rewriteCss(CSS, (u) => (u.startsWith('https://') ? `/v/${u.split('/').pop()}` : null));
    expect(out).toContain('@import "/v/base.css";');
    expect(out).toContain("url('/v/f.woff2')");
    expect(out).toContain('url(data:font/woff2;base64,AA==)');
    expect(out).toContain('url("./local.png")');
  });

  it('ignores references inside comments', () => {
    const css = `/* old: url(https://x/old.png)
   @import "https://x/old.css"; */
.a { background: url(https://x/new.png) /* url(https://x/inline.png) */ }
/* unterminated url(https://x/tail.png)`;
    expect(findCssUrls(css)).toEqual(['https://x/new.png']);
    expect(rewriteCss(css, () => '/v/x.png')).toBe(css.replace('url(https://x/new.png)', 'url(/v/x.png)'));
  });

  it('does not treat /* inside a string as a comment', () => {
    const css = `.a::before { content: "/*"; } .b { background: url(https://x/b.png) } .c::after { content: '*/' }`;
    expect(findCssUrls(css)).toEqual(['https://x/b.png']);
  });

  it('matches url( case-insensitively and keeps the original spelling', () => {
    const css = `.a { background: URL( "https://x/a.png" ) } .b { mask: Url(https://x/b.svg) }`;
    expect(findCssUrls(css)).toEqual(['https://x/a.png', 'https://x/b.svg']);
    expect(rewriteCss(css, (u) => `/v/${u.split('/').pop()}`)).toBe(`.a { background: URL( "/v/a.png" ) } .b { mask: Url(/v/b.svg) }`);
  });

  it('reads quoted URLs that contain parentheses or the other quote', () => {
    const css = `.a { background: url("https://x/a(1).png") } .b { background: url('https://x/it"s.png') }`;
    expect(findCssUrls(css)).toEqual(['https://x/a(1).png', 'https://x/it"s.png']);
    const out = rewriteCss(css, (u) => (u === 'https://x/a(1).png' ? '/v/a1.png' : null));
    expect(out).toBe(css.replace('https://x/a(1).png', '/v/a1.png'));
  });

  it('does not find url() inside a quoted data: URI', () => {
    const css = `.a { background: url("data:image/svg+xml,%3Csvg%3E%3Crect fill='url(%23g)'/%3E%3C/svg%3E") }
.b { background: url(https://x/b.png) }`;
    expect(findCssUrls(css)).toEqual(['https://x/b.png']);
  });

  it('reads escaped quotes inside a quoted URL as part of it', () => {
    const svg = String.raw`data:image/svg+xml,%3Csvg%3E%3Crect fill=\"url(%23g)\"/%3E%3C/svg%3E`;
    const css = String.raw`.a { background: url("${svg}") } .b { background: url('https://x/it\'s.png') } .c { background: url(https://x/c.png) }`;
    expect(findCssUrls(css)).toEqual([String.raw`https://x/it\'s.png`, 'https://x/c.png']);
    expect(rewriteCss(css, (u) => (u === 'https://x/c.png' ? '/v/c.png' : null))).toBe(css.replace('https://x/c.png', '/v/c.png'));
  });

  it('ignores url( and @import inside other strings', () => {
    const css = `.a::before { content: "url(https://x/not.png) @import 'https://x/not.css'"; } .b { background: url(https://x/b.png) }`;
    expect(findCssUrls(css)).toEqual(['https://x/b.png']);
  });

  it('skips data: URLs and fragment-only references', () => {
    const css = `.a { fill: url(#grad); background: url("DATA:image/png;base64,AA=="), url(https://x/a.png) }`;
    expect(findCssUrls(css)).toEqual(['https://x/a.png']);
    const seen: string[] = [];
    const out = rewriteCss(css, (u) => {
      seen.push(u);
      return '/v/a.png';
    });
    expect(seen).toEqual(['https://x/a.png']);
    expect(out).toBe(css.replace('https://x/a.png', '/v/a.png'));
  });
});
