/** url("…"), url('…') or url(…); the URL is in group 1, 2 or 3. */
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s'"()]*))\s*\)/dgi;
/** @import "…" or @import '…'; the URL is in group 1 or 2. (@import url(…) is matched by URL_RE.) */
const IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/dgi;
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
      const group = m.findIndex((g, i) => i > 0 && g !== undefined);
      const span = m.indices?.[group];
      const url = m[group];
      if (group === -1 || !span || !url || isLocalOnly(url)) continue;
      refs.push({ url, start: span[0], end: span[1] });
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
