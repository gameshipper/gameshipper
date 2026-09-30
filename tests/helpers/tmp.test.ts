import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTmpDir, removeTmpDirs, tmpDirs } from './tmp.js';

describe('test temp folders', () => {
  it('are remembered, then removed together with what is in them', () => {
    const a = makeTmpDir();
    const b = makeTmpDir('gs-other-');
    fs.mkdirSync(path.join(b, 'sub'));
    fs.writeFileSync(path.join(b, 'sub', 'file.txt'), 'x');
    expect(tmpDirs()).toEqual(expect.arrayContaining([a, b]));
    expect(removeTmpDirs()).toEqual([]);
    expect([fs.existsSync(a), fs.existsSync(b), tmpDirs()]).toEqual([false, false, []]);
  });
});
