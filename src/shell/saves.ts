import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SaveStore {
  save(slot: string, data: unknown): Promise<void>;
  load(slot: string): Promise<unknown | null>;
  list(): Promise<string[]>;
  delete(slot: string): Promise<void>;
}

const SLOT = /^[A-Za-z0-9_-]{1,64}$/;

function checkSlot(slot: string): void {
  if (!SLOT.test(slot)) {
    throw new Error(`Invalid save slot name "${slot}": use 1-64 letters, numbers, "-" or "_".`);
  }
}

/** Saves are plain JSON files so Steam Auto-Cloud can sync the folder. */
export function createSaveStore(dir: string): SaveStore {
  const file = (slot: string) => path.join(dir, `${slot}.json`);
  return {
    async save(slot, data) {
      checkSlot(slot);
      const json = JSON.stringify(data);
      if (json === undefined) throw new Error('Save data must be JSON-serializable (got undefined).');
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${file(slot)}.tmp`;
      await fs.promises.writeFile(tmp, json);
      await fs.promises.rename(tmp, file(slot));
    },
    async load(slot) {
      checkSlot(slot);
      try {
        return JSON.parse(await fs.promises.readFile(file(slot), 'utf8')) as unknown;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async list() {
      try {
        return (await fs.promises.readdir(dir))
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, -'.json'.length))
          .sort();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
    },
    async delete(slot) {
      checkSlot(slot);
      await fs.promises.rm(file(slot), { force: true });
    },
  };
}
