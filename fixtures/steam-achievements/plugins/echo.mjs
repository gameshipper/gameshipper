import * as fs from 'node:fs';
import * as path from 'node:path';

// An example plugin (spec §7.6): one function the game can call, and both build hooks.
export default {
  name: 'echo',
  main: {
    async shout(text) {
      return String(text).toUpperCase();
    },
  },
  beforePackage(ctx) {
    fs.writeFileSync(path.join(ctx.projectDir, '.gameshipper', 'before-package.txt'), ctx.targets.join(','));
  },
  afterPackage(ctx) {
    fs.appendFileSync(path.join(ctx.projectDir, '.gameshipper', 'after-package.txt'), `${ctx.target}\n`);
  },
};
