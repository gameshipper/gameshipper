import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSaveStore } from '../../src/shell/saves.js';
import { makeTmpDir } from '../helpers/tmp.js';

describe('createSaveStore', () => {
  it('saves, loads, lists and deletes JSON slots', async () => {
    const dir = path.join(makeTmpDir(), 'saves');
    const store = createSaveStore(dir);
    await store.save('slot1', { level: 3, name: 'Ana' });
    await store.save('auto_save-2', [1, 2]);
    expect(await store.load('slot1')).toEqual({ level: 3, name: 'Ana' });
    expect(await store.list()).toEqual(['auto_save-2', 'slot1']);
    expect(fs.readFileSync(path.join(dir, 'slot1.json'), 'utf8')).toBe('{"level":3,"name":"Ana"}');
    await store.delete('slot1');
    expect(await store.load('slot1')).toBeNull();
    expect(await store.list()).toEqual(['auto_save-2']);
  });

  it('returns an empty list before anything is saved', async () => {
    expect(await createSaveStore(path.join(makeTmpDir(), 'none')).list()).toEqual([]);
  });

  it('rejects slot names that could escape the folder', async () => {
    const store = createSaveStore(makeTmpDir());
    await expect(store.save('../evil', 1)).rejects.toThrow(/save slot/i);
    await expect(store.load('a/b')).rejects.toThrow(/save slot/i);
  });

  it('rejects data that is not JSON-serializable', async () => {
    await expect(createSaveStore(makeTmpDir()).save('s', undefined)).rejects.toThrow(/JSON/);
  });
});
