import { cacheRoot } from './cache.js';
import { createRunLog } from './log.js';

export interface Ctx {
  projectDir: string;
  cacheDir: string;
  logPath: string;
  log(line: string): void;
}

export function createCtx(
  projectDir: string,
  command: string,
  opts: { verbose?: boolean; cacheDir?: string } = {},
): Ctx {
  const runLog = createRunLog(projectDir, command);
  return {
    projectDir,
    cacheDir: opts.cacheDir ?? cacheRoot(),
    logPath: runLog.path,
    log(line) {
      runLog.write(line);
      if (opts.verbose) process.stderr.write(`${line}\n`);
    },
  };
}
