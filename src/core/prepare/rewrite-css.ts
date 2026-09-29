/** A quoted string's contents, where a backslash escapes the next character (so \" doesn't end it). */
const DOUBLE_QUOTED = String.raw`"((?:[^"\\\n]|\\[\s\S])*)"`;
const SINGLE_QUOTED = String.raw`'((?:[^'\\\n]|\\[\s\S])*)'`;

/**
 * One left-to-right scan over the CSS. Whatever starts first wins, so url( inside a comment or a string
 * (including an escaped one, like fill=\"url(%23g)\" in a data: URI) is never taken for a reference.
 * - a comment, possibly unterminated
 * - url("…"), url('…') or url(…): the URL is in group 1, 2 or 3
 * - @import "…" or @import '…': the URL is in group 4 or 5 (@import url(…) is a url() token)
 * - any other string, possibly unterminated
 */
const TOKENS = new RegExp(
  [
    String.raw`\/\*[\s\S]*?(?:\*\/|$)`,
    String.raw`url\(\s*(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|([^\s'"()]*))\s*\)`,
    String.raw`@import\s+(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED})`,
    String.raw`"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?`,
  ].join('|'),
  'dgi',
);

interface CssRef {
  url: string;
  start: number;
  end: number;
}

/** Nothing to fetch: inline data, or a reference to an element in the same document (url(#grad)). */
const isLocalOnly = (url: string): boolean => /^data:/i.test(url) || url.startsWith('#');

function cssRefs(css: string): CssRef[] {
  const refs: CssRef[] = [];
  for (const m of css.matchAll(TOKENS)) {
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    if (group === -1) continue; // a comment or another string
    const span = m.indices?.[group];
    const url = m[group];
    if (!span || !url || isLocalOnly(url)) continue;
    refs.push({ url, start: span[0], end: span[1] });
  }
  return refs;
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
