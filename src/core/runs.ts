import * as fs from 'node:fs';
import * as path from 'node:path';
import { gsError, type GsError, type Result } from './result.js';

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

/**
 * Best-effort: a run that finished must not turn into a failure because its record couldn't be written.
 * Returns a LAST_RUN_NOT_SAVED warning for the result when saving fails, else null.
 */
export function saveLastRun(projectDir: string, command: string, result: Result<unknown>, now: Date = new Date()): GsError | null {
  const record: LastRun = {
    command,
    at: now.toISOString(),
    ok: result.ok,
    ...(result.logPath ? { logPath: result.logPath } : {}),
    errors: result.errors,
    warnings: result.warnings,
  };
  try {
    fs.mkdirSync(lastDir(projectDir), { recursive: true });
    fs.writeFileSync(path.join(lastDir(projectDir), `${command}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return null;
  } catch (e) {
    return gsError(
      'LAST_RUN_NOT_SAVED',
      `Couldn't record this ${command} for \`status\`: ${e instanceof Error ? e.message : String(e)}`,
      `Make sure ${lastDir(projectDir)} is a folder you can write to. Until then \`status\` shows an older result.`,
    );
  }
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
