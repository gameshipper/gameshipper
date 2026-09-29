import * as fs from 'node:fs';
import * as path from 'node:path';
import { isGameUrl } from './policy.js';

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

  // Operations run one after another, in call order: the last save to a slot wins, a delete
  // issued after a save is not undone by it, and list() sees every earlier save and delete.
  let queue: Promise<unknown> = Promise.resolve();
  function inOrder<T>(op: () => Promise<T>): Promise<T> {
    const result = queue.then(op);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    async save(slot, data) {
      checkSlot(slot);
      const json = JSON.stringify(data);
      if (json === undefined) throw new Error('Save data must be JSON-serializable (got undefined).');
      return inOrder(async () => {
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
      return inOrder(async () => {
        try {
          return JSON.parse(await fs.promises.readFile(file(slot), 'utf8')) as unknown;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw e;
        }
      });
    },
    async list() {
      return inOrder(async () => {
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
      });
    },
    async delete(slot) {
      checkSlot(slot);
      return inOrder(() => fs.promises.rm(file(slot), { force: true }));
    },
  };
}

/**
 * Runs one `window.gameshipper.saves` call arriving over IPC. Only the game's own pages may use
 * saves, so a web page the window somehow ends up showing can't read or write them. Slots are
 * passed through unconverted: the store rejects anything that isn't a valid slot name.
 */
export async function callSaveStore(
  store: SaveStore,
  senderUrl: string | null | undefined,
  op: unknown,
  slot?: unknown,
  data?: unknown,
): Promise<unknown> {
  if (!isGameUrl(senderUrl)) throw new Error('Saves are only available to the game (app://game/).');
  switch (op) {
    case 'save':
      return store.save(slot as string, data);
    case 'load':
      return store.load(slot as string);
    case 'list':
      return store.list();
    case 'delete':
      return store.delete(slot as string);
    default:
      throw new Error(`Unknown saves operation: ${String(op)}`);
  }
}
