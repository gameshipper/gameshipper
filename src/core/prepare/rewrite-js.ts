import { init, parse } from 'es-module-lexer';

export interface JsSpecifier {
  specifier: string;
  start: number;
  end: number;
  /** true when [start, end) includes the surrounding quotes (dynamic imports). */
  quoted: boolean;
}

export async function findJsSpecifiers(code: string): Promise<JsSpecifier[]> {
  await init();
  const [imports] = parse(code);
  const out: JsSpecifier[] = [];
  for (const imp of imports) {
    if (imp.type === 'static' || imp.type === 'reexport-star') {
      out.push({ specifier: imp.specifier, start: imp.start, end: imp.end, quoted: false });
    } else if (imp.type === 'dynamic' && typeof imp.specifier === 'string') {
      out.push({ specifier: imp.specifier, start: imp.start, end: imp.end, quoted: true });
    }
  }
  return out;
}

export function rewriteJs(code: string, specs: JsSpecifier[], replace: (specifier: string) => string | null): string {
  let out = code;
  for (const spec of [...specs].sort((a, b) => b.start - a.start)) {
    const next = replace(spec.specifier);
    if (next === null || next === spec.specifier) continue;
    out = out.slice(0, spec.start) + (spec.quoted ? JSON.stringify(next) : next) + out.slice(spec.end);
  }
  return out;
}
