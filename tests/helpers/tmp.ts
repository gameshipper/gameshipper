import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The folders makeTmpDir made in this test file that haven't been removed yet. */
const created: string[] = [];

/** A new, empty folder in the OS temp folder. tests/setup.ts deletes it once the test file is done. */
export function makeTmpDir(prefix = 'gs-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** The folders makeTmpDir made that haven't been removed yet. */
export function tmpDirs(): readonly string[] {
  return created;
}

/** Deletes every folder makeTmpDir made so far. Returns the ones that couldn't be deleted (a file still open on Windows). */
export function removeTmpDirs(): string[] {
  const left: string[] = [];
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      left.push(dir);
    }
  }
  return left;
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
