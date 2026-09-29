import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import type { ImportMap } from './remote.js';

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const URL_ATTRS: Array<[tag: string, attr: string]> = [
  ['script', 'src'],
  ['link', 'href'],
  ['img', 'src'],
  ['audio', 'src'],
  ['video', 'src'],
  ['source', 'src'],
];

export interface HtmlScan {
  importMap: ImportMap | null;
  urls: string[];
  moduleScripts: string[];
  styles: string[];
}

export interface HtmlRewrite {
  url(value: string): string | null;
  importMap(map: ImportMap): ImportMap;
  moduleScript(code: string): string;
  style(css: string): string;
}

interface Range {
  start: number;
  end: number;
}

interface Edit extends Range {
  text: string;
}

interface UrlRef {
  el: Element;
  attr: string;
  value: string;
}

interface Body extends Range {
  text: string;
}

interface Doc {
  urls: UrlRef[];
  importMap: Body | null;
  modules: Body[];
  styles: Body[];
}

const SPACE = /[\t\n\f\r ]/;

/** Every element in document order, including the content of <template> elements. */
function elements(html: string): Element[] {
  const out: Element[] = [];
  const visit = (node: ParentNode): void => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue;
      out.push(child);
      visit(child);
      if ('content' in child) visit(child.content);
    }
  };
  visit(parse(html, { sourceCodeLocationInfo: true }));
  return out;
}

const getAttr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

const scriptType = (el: Element): string => (getAttr(el, 'type') ?? '').trim().toLowerCase();

/** The source text between an element's tags (script and style bodies). */
function body(html: string, el: Element): Body | null {
  const loc = el.sourceCodeLocation;
  if (!loc) return null;
  let range: Range;
  if (el.childNodes.length > 0) {
    const first = el.childNodes[0].sourceCodeLocation;
    const last = el.childNodes[el.childNodes.length - 1].sourceCodeLocation;
    if (!first || !last) return null;
    range = { start: first.startOffset, end: last.endOffset };
  } else {
    const at = loc.startTag?.endOffset;
    if (at === undefined) return null;
    range = { start: at, end: at };
  }
  return { ...range, text: html.slice(range.start, range.end) };
}

function inspect(html: string): Doc {
  const els = elements(html);
  const urls: UrlRef[] = [];
  for (const [tag, attr] of URL_ATTRS) {
    for (const el of els) {
      if (el.tagName !== tag) continue;
      const value = getAttr(el, attr);
      if (value) urls.push({ el, attr, value });
    }
  }
  const scripts = els.filter((el) => el.tagName === 'script');
  const mapEl = scripts.find((el) => scriptType(el) === 'importmap');
  const bodies = (list: Element[]): Body[] => list.map((el) => body(html, el)).filter((b): b is Body => b !== null);
  return {
    urls,
    importMap: mapEl ? body(html, mapEl) : null,
    modules: bodies(scripts.filter((el) => scriptType(el) === 'module' && getAttr(el, 'src') === undefined)),
    styles: bodies(els.filter((el) => el.tagName === 'style')),
  };
}

function readImportMap(text: string): { imports?: ImportMap } | null {
  try {
    const parsed = JSON.parse(text) as { imports?: ImportMap };
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Where an attribute's value sits in the source, and the quote around it ('' when unquoted). */
function valueRange(html: string, el: Element, name: string): (Range & { quote: string }) | null {
  const loc = el.sourceCodeLocation?.attrs?.[name];
  if (!loc) return null;
  let i = html.indexOf('=', loc.startOffset + name.length);
  if (i === -1 || i >= loc.endOffset) return null;
  i++;
  while (i < loc.endOffset && SPACE.test(html[i])) i++;
  const quote = html[i];
  if (quote === '"' || quote === "'") {
    const closed = loc.endOffset - 1 > i && html[loc.endOffset - 1] === quote;
    return { start: i + 1, end: closed ? loc.endOffset - 1 : loc.endOffset, quote };
  }
  return { start: i, end: loc.endOffset, quote: '' };
}

/** An attribute plus the whitespace before it, for deletion. */
function attrWithSpace(html: string, el: Element, name: string): Range | null {
  const loc = el.sourceCodeLocation?.attrs?.[name];
  if (!loc) return null;
  let start = loc.startOffset;
  while (start > 0 && SPACE.test(html[start - 1])) start--;
  return { start, end: loc.endOffset };
}

function escapeAttr(value: string, quote: '"' | "'"): string {
  const escaped = value.replace(/&/g, '&amp;');
  return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&#39;');
}

function applyEdits(html: string, edits: Edit[]): string {
  let out = html;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

export function scanHtml(html: string): HtmlScan {
  const doc = inspect(html);
  return {
    importMap: (doc.importMap && readImportMap(doc.importMap.text)?.imports) ?? null,
    urls: doc.urls.map((u) => u.value),
    moduleScripts: doc.modules.map((b) => b.text),
    styles: doc.styles.map((b) => b.text),
  };
}

/** Rewrites references by splicing edits into the original text; everything else stays byte-identical. */
export function rewriteHtml(html: string, rw: HtmlRewrite): string {
  const doc = inspect(html);
  const edits: Edit[] = [];
  for (const { el, attr, value } of doc.urls) {
    const next = rw.url(value);
    if (next === null || next === value) continue;
    const range = valueRange(html, el, attr);
    if (!range) continue;
    const text = range.quote === "'" ? escapeAttr(next, "'") : escapeAttr(next, '"');
    edits.push({ start: range.start, end: range.end, text: range.quote ? text : `"${text}"` });
    for (const name of ['integrity', 'crossorigin']) {
      const drop = attrWithSpace(html, el, name);
      if (drop) edits.push({ ...drop, text: '' });
    }
  }
  const replaceBody = (b: Body, next: string): void => {
    if (next !== b.text) edits.push({ start: b.start, end: b.end, text: next });
  };
  const map = doc.importMap && readImportMap(doc.importMap.text);
  if (doc.importMap && map) {
    const before = JSON.stringify(map.imports ?? {});
    map.imports = rw.importMap(map.imports ?? {});
    if (JSON.stringify(map.imports) !== before) replaceBody(doc.importMap, JSON.stringify(map, null, 2));
  }
  for (const b of doc.modules) replaceBody(b, rw.moduleScript(b.text));
  for (const b of doc.styles) replaceBody(b, rw.style(b.text));
  return edits.length === 0 ? html : applyEdits(html, edits);
}
