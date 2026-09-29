const URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/dgi;
const IMPORT_RE = /@import\s+(['"])([^'"]+)\1/dgi;
/** Comments (possibly unterminated) and strings, so a "/*" inside a string isn't taken for a comment. */
const COMMENT_OR_STRING = /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?/g;

interface CssRef {
  url: string;
  start: number;
  end: number;
}

/** Blank out comments with spaces, keeping every offset the same. */
const maskComments = (css: string): string =>
  css.replace(COMMENT_OR_STRING, (m) => (m.startsWith('/*') ? ' '.repeat(m.length) : m));

/** Nothing to fetch: inline data, or a reference to an element in the same document (url(#grad)). */
const isLocalOnly = (url: string): boolean => /^data:/i.test(url) || url.startsWith('#');

function cssRefs(css: string): CssRef[] {
  const masked = maskComments(css);
  const refs: CssRef[] = [];
  for (const re of [IMPORT_RE, URL_RE]) {
    for (const m of masked.matchAll(re)) {
      const span = m.indices?.[2];
      if (!span || isLocalOnly(m[2])) continue;
      refs.push({ url: m[2], start: span[0], end: span[1] });
    }
  }
  return refs.sort((a, b) => a.start - b.start);
}

export function findCssUrls(css: string): string[] {
  return cssRefs(css).map((r) => r.url);
}

/** Replaces only the URL text of each reference; comments, quotes and spelling stay as they were. */
export function rewriteCss(css: string, replace: (url: string) => string | null): string {
  const edits: Array<CssRef & { next: string }> = [];
  for (const ref of cssRefs(css)) {
    const next = replace(ref.url);
    if (next !== null && next !== ref.url) edits.push({ ...ref, next });
  }
  let out = css;
  for (const { start, end, next } of edits.reverse()) out = out.slice(0, start) + next + out.slice(end);
  return out;
}
