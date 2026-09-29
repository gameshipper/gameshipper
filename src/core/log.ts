import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunLog {
  path: string;
  write(line: string): void;
}

export function createRunLog(projectDir: string, command: string, now: Date = new Date()): RunLog {
  const dir = path.join(projectDir, '.gameshipper', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${command}-${now.toISOString().replace(/[:.]/g, '-')}.log`);
  fs.writeFileSync(file, '');
  return {
    path: file,
    write(line) {
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
    },
  };
}
