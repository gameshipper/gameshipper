import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GsError, Result } from './result.js';

/** What the last run of a command reported, kept in .gameshipper/last/<command>.json for `status`. */
export interface LastRun {
  command: string;
  at: string;
  ok: boolean;
  logPath?: string;
  errors: GsError[];
  warnings: GsError[];
}

const lastDir = (projectDir: string) => path.join(projectDir, '.gameshipper', 'last');

export function saveLastRun(projectDir: string, command: string, result: Result<unknown>, now: Date = new Date()): void {
  const record: LastRun = {
    command,
    at: now.toISOString(),
    ok: result.ok,
    ...(result.logPath ? { logPath: result.logPath } : {}),
    errors: result.errors,
    warnings: result.warnings,
  };
  fs.mkdirSync(lastDir(projectDir), { recursive: true });
  fs.writeFileSync(path.join(lastDir(projectDir), `${command}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

/** Last runs by command. Damaged records are skipped: `status` must always answer. */
export function readLastRuns(projectDir: string): Record<string, LastRun> {
  const dir = lastDir(projectDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return {};
  }
  const runs: Record<string, LastRun> = {};
  for (const file of files) {
    let run: Partial<LastRun> | null;
    try {
      run = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Partial<LastRun> | null;
    } catch {
      continue;
    }
    if (run && typeof run.command === 'string') runs[run.command] = run as LastRun;
  }
  return runs;
}
