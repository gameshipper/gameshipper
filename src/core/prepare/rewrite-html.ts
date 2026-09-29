import { parse, TextNode, type HTMLElement } from 'node-html-parser';
import type { ImportMap } from './remote.js';

const URL_ATTRS: Array<[selector: string, attr: string]> = [
  ['script[src]', 'src'],
  ['link[href]', 'href'],
  ['img[src]', 'src'],
  ['audio[src]', 'src'],
  ['video[src]', 'src'],
  ['source[src]', 'src'],
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

function load(html: string): HTMLElement {
  return parse(html, { comment: true });
}

function readImportMap(el: HTMLElement | null): { imports?: ImportMap } | null {
  if (!el) return null;
  try {
    const parsed = JSON.parse(el.rawText) as { imports?: ImportMap };
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const inlineModules = (root: HTMLElement) => root.querySelectorAll('script[type=module]').filter((s) => !s.hasAttribute('src'));

export function scanHtml(html: string): HtmlScan {
  const root = load(html);
  const urls: string[] = [];
  for (const [selector, attr] of URL_ATTRS) {
    for (const el of root.querySelectorAll(selector)) {
      const value = el.getAttribute(attr);
      if (value) urls.push(value);
    }
  }
  return {
    importMap: readImportMap(root.querySelector('script[type=importmap]'))?.imports ?? null,
    urls,
    moduleScripts: inlineModules(root).map((s) => s.rawText),
    styles: root.querySelectorAll('style').map((s) => s.rawText),
  };
}

export function rewriteHtml(html: string, rw: HtmlRewrite): string {
  const root = load(html);
  for (const [selector, attr] of URL_ATTRS) {
    for (const el of root.querySelectorAll(selector)) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const next = rw.url(value);
      if (next === null || next === value) continue;
      el.setAttribute(attr, next);
      el.removeAttribute('integrity');
      el.removeAttribute('crossorigin');
    }
  }
  const mapEl = root.querySelector('script[type=importmap]');
  const map = readImportMap(mapEl);
  if (mapEl && map) {
    map.imports = rw.importMap(map.imports ?? {});
    mapEl.set_content(new TextNode(JSON.stringify(map, null, 2), mapEl));
  }
  for (const el of inlineModules(root)) el.set_content(new TextNode(rw.moduleScript(el.rawText), el));
  for (const el of root.querySelectorAll('style')) el.set_content(new TextNode(rw.style(el.rawText), el));
  return root.toString();
}
