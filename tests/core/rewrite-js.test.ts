import { describe, expect, it } from 'vitest';
import { findJsSpecifiers, rewriteJs } from '../../src/core/prepare/rewrite-js.js';

const SRC = [
  'import * as THREE from "https://unpkg.com/three@0.170.0/build/three.module.js";',
  "import x from './local.js';",
  'export * from "https://esm.sh/a";',
  'export { b } from "https://esm.sh/b";',
  'const m = await import("https://cdn.jsdelivr.net/npm/foo");',
  'const q = await import(url);',
].join('\n');

describe('rewrite-js', () => {
  it('finds static, re-export and literal dynamic imports', async () => {
    const specs = await findJsSpecifiers(SRC);
    expect(specs.map((s) => [s.specifier, s.quoted])).toEqual([
      ['https://unpkg.com/three@0.170.0/build/three.module.js', false],
      ['./local.js', false],
      ['https://esm.sh/a', false],
      ['https://esm.sh/b', false],
      ['https://cdn.jsdelivr.net/npm/foo', true],
    ]);
  });

  it('rewrites only the specifiers the callback maps', async () => {
    const specs = await findJsSpecifiers(SRC);
    const out = rewriteJs(SRC, specs, (s) => (s.startsWith('https://') ? `/v/${s.split('/').pop()}` : null));
    expect(out).toContain('import * as THREE from "/v/three.module.js";');
    expect(out).toContain("import x from './local.js';");
    expect(out).toContain('export * from "/v/a";');
    expect(out).toContain('export { b } from "/v/b";');
    expect(out).toContain('await import("/v/foo")');
    expect(out).toContain('await import(url)');
  });

  it('returns the code unchanged when nothing maps', async () => {
    expect(rewriteJs(SRC, await findJsSpecifiers(SRC), () => null)).toBe(SRC);
  });
});
