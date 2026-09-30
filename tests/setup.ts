import { afterAll, type RunnerTask } from 'vitest';
import { removeTmpDirs, tmpDirs } from './helpers/tmp.js';

/**
 * Runs in every test file (vitest.config.ts and vitest.int.config.ts list it in setupFiles). Once a file's tests are
 * done, the temp folders they made with makeTmpDir are deleted. To look at what a failing test left behind, run
 * with GAMESHIPPER_KEEP_TMP=1: a file with a failure then keeps its folders and lists them on stderr.
 */

const failed = (task: Readonly<RunnerTask>): boolean => task.result?.state === 'fail' || ('tasks' in task && task.tasks.some(failed));

// Registered before the file's own hooks, so it runs after them (afterAll hooks run in reverse order).
afterAll(({}, file) => {
  if (process.env.GAMESHIPPER_KEEP_TMP === '1' && failed(file) && tmpDirs().length) {
    process.stderr.write(`GAMESHIPPER_KEEP_TMP: kept the temp folders of ${file.name}:\n${tmpDirs().map((dir) => `  ${dir}\n`).join('')}`);
    return;
  }
  const left = removeTmpDirs();
  if (left.length) process.stderr.write(`Couldn't delete these temp folders of ${file.name}:\n${left.map((dir) => `  ${dir}\n`).join('')}`);
});
