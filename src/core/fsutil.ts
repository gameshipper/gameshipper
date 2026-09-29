import * as fs from 'node:fs';
import * as path from 'node:path';

/** All files under root, as sorted posix-style relative paths. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
