import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function makeTmpDir(prefix = 'gs-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

export function readText(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}
