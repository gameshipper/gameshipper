import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Works from both src/core and dist/core, which are both two levels below the package root. */
export const GAMESHIPPER_VERSION: string = (require('../../package.json') as { version: string }).version;
