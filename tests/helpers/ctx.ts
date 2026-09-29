import { createCtx, type Ctx } from '../../src/core/context.js';
import { makeTmpDir } from './tmp.js';

/** A Ctx whose download cache lives outside the project, so staging never copies it. */
export function testCtx(projectDir: string, cacheDir = makeTmpDir('gs-cache-')): Ctx {
  return createCtx(projectDir, 'test', { cacheDir });
}
