import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunLog {
  path: string;
  write(line: string): void;
}

/** How many run logs of each command .gameshipper/logs keeps: the newest ones. */
export const KEPT_RUN_LOGS = 50;

/** Deletes all but the newest `keep` run logs of `command` in `dir`. Their names sort by time. */
function pruneRunLogs(dir: string, command: string, keep: number): void {
  const pattern = new RegExp(`^${command}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.log$`);
  const logs = fs.readdirSync(dir).filter((name) => pattern.test(name)).sort();
  for (const name of logs.slice(0, Math.max(0, logs.length - keep))) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Still open somewhere (Windows); the next run tries again.
    }
  }
}

/** Creates this run's log in .gameshipper/logs, first deleting the command's oldest logs beyond KEPT_RUN_LOGS. */
export function createRunLog(projectDir: string, command: string, now: Date = new Date()): RunLog {
  const dir = path.join(projectDir, '.gameshipper', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  pruneRunLogs(dir, command, KEPT_RUN_LOGS - 1);
  const file = path.join(dir, `${command}-${now.toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(file, '');
  return {
    path: file,
    write(line) {
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
    },
  };
}
