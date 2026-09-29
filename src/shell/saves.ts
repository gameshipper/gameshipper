import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SaveStore {
  save(slot: string, data: unknown): Promise<void>;
  load(slot: string): Promise<unknown | null>;
  list(): Promise<string[]>;
  delete(slot: string): Promise<void>;
}

const SLOT = /^[A-Za-z0-9_-]{1,64}$/;

// Slots arrive from the game over IPC, so they are checked at runtime whatever their static type.
function checkSlot(slot: unknown): asserts slot is string {
  if (typeof slot !== 'string' || !SLOT.test(slot)) {
    throw new Error(`Invalid save slot name "${String(slot)}": use 1-64 letters, numbers, "-" or "_".`);
  }
}

let tmpCounter = 0;

/** Saves are plain JSON files so Steam Auto-Cloud can sync the folder. */
export function createSaveStore(dir: string): SaveStore {
  const file = (slot: string) => path.join(dir, `${slot}.json`);

  // Operations on one slot run one after another, in call order, so the last save wins
  // and a delete issued after a save is not undone by it.
  const queues = new Map<string, Promise<void>>();
  function inOrder<T>(slot: string, op: () => Promise<T>): Promise<T> {
    const result = (queues.get(slot) ?? Promise.resolve()).then(op);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(slot, tail);
    void tail.then(() => {
      if (queues.get(slot) === tail) queues.delete(slot);
    });
    return result;
  }

  return {
    async save(slot, data) {
      checkSlot(slot);
      const json = JSON.stringify(data);
      if (json === undefined) throw new Error('Save data must be JSON-serializable (got undefined).');
      return inOrder(slot, async () => {
        await fs.promises.mkdir(dir, { recursive: true });
        const tmp = `${file(slot)}.${process.pid}.${++tmpCounter}.tmp`;
        try {
          await fs.promises.writeFile(tmp, json);
          await fs.promises.rename(tmp, file(slot));
        } catch (e) {
          await fs.promises.rm(tmp, { force: true });
          throw e;
        }
      });
    },
    async load(slot) {
      checkSlot(slot);
      return inOrder(slot, async () => {
        try {
          return JSON.parse(await fs.promises.readFile(file(slot), 'utf8')) as unknown;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw e;
        }
      });
    },
    async list() {
      try {
        return (await fs.promises.readdir(dir, { withFileTypes: true }))
          .filter((d) => d.isFile() && d.name.endsWith('.json'))
          .map((d) => d.name.slice(0, -'.json'.length))
          .filter((slot) => SLOT.test(slot))
          .sort();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
    },
    async delete(slot) {
      checkSlot(slot);
      return inOrder(slot, () => fs.promises.rm(file(slot), { force: true }));
    },
  };
}
