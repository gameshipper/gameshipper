const URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g;
const IMPORT_RE = /@import\s+(['"])([^'"]+)\1/g;

export function findCssUrls(css: string): string[] {
  const found: Array<[number, string]> = [];
  for (const m of css.matchAll(IMPORT_RE)) found.push([m.index, m[2]]);
  for (const m of css.matchAll(URL_RE)) found.push([m.index, m[2]]);
  return found.sort((a, b) => a[0] - b[0]).map(([, u]) => u);
}

export function rewriteCss(css: string, replace: (url: string) => string | null): string {
  return css
    .replace(IMPORT_RE, (all, quote: string, url: string) => {
      const next = replace(url);
      return next === null ? all : `@import ${quote}${next}${quote}`;
    })
    .replace(URL_RE, (all, quote: string, url: string) => {
      const next = replace(url);
      return next === null ? all : `url(${quote}${next}${quote})`;
    });
}
