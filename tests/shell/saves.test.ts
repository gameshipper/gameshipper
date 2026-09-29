import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callSaveStore, createSaveStore } from '../../src/shell/saves.js';
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

  it('rejects slot names that are not strings', async () => {
    const store = createSaveStore(makeTmpDir());
    for (const bad of [undefined, null, 5]) {
      const slot = bad as unknown as string;
      await expect(store.save(slot, 1)).rejects.toThrow(/Invalid save slot name/);
      await expect(store.load(slot)).rejects.toThrow(/Invalid save slot name/);
      await expect(store.delete(slot)).rejects.toThrow(/Invalid save slot name/);
    }
    expect(await store.list()).toEqual([]);
  });

  it('survives many concurrent saves to one slot', async () => {
    const dir = makeTmpDir();
    const store = createSaveStore(dir);
    const values = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    await expect(Promise.all(values.map((v) => store.save('auto', v)))).resolves.toHaveLength(20);
    expect(values).toContainEqual(await store.load('auto'));
    expect(fs.readdirSync(dir)).toEqual(['auto.json']);
  });

  it('keeps the last of several unawaited saves, and a delete queued after them wins', async () => {
    const store = createSaveStore(makeTmpDir());
    void store.save('slot', 1);
    void store.save('slot', 2);
    await store.save('slot', 3);
    expect(await store.load('slot')).toBe(3);
    void store.save('slot', 4);
    await store.delete('slot');
    expect(await store.load('slot')).toBeNull();
  });

  it('lists in call order with pending saves and deletes', async () => {
    const store = createSaveStore(makeTmpDir());
    void store.save('a', 1);
    expect(await store.list()).toEqual(['a']);
    const listed = store.list();
    const deleted = store.delete('a');
    expect(await listed).toEqual(['a']);
    await deleted;
    expect(await store.list()).toEqual([]);
  });

  it('lists only valid slot names that are regular files', async () => {
    const dir = makeTmpDir();
    const store = createSaveStore(dir);
    await store.save('good', 1);
    fs.writeFileSync(path.join(dir, 'has space.json'), '1');
    fs.writeFileSync(path.join(dir, '.json'), '1');
    fs.writeFileSync(path.join(dir, 'good.json.tmp'), '1');
    fs.writeFileSync(path.join(dir, 'good.json.123.4.tmp'), '1');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '1');
    fs.mkdirSync(path.join(dir, 'x.json'));
    expect(await store.list()).toEqual(['good']);
  });
});

describe('callSaveStore', () => {
  const game = 'app://game/index.html';

  it('runs save, load, list and delete for the game page', async () => {
    const store = createSaveStore(makeTmpDir());
    await callSaveStore(store, game, 'save', 'slot1', { hp: 3 });
    expect(await callSaveStore(store, game, 'load', 'slot1')).toEqual({ hp: 3 });
    expect(await callSaveStore(store, game, 'list')).toEqual(['slot1']);
    await callSaveStore(store, game, 'delete', 'slot1');
    expect(await callSaveStore(store, game, 'list')).toEqual([]);
  });

  it('refuses callers that are not game pages', async () => {
    const store = createSaveStore(makeTmpDir());
    for (const sender of ['https://evil.example/', 'app://other/index.html', null, undefined]) {
      await expect(callSaveStore(store, sender, 'save', 'pwn', 1)).rejects.toThrow(/only available to the game/);
    }
    expect(await store.list()).toEqual([]);
  });

  it('passes slots through unconverted and rejects unknown operations', async () => {
    const store = createSaveStore(makeTmpDir());
    await expect(callSaveStore(store, game, 'save', undefined, 1)).rejects.toThrow(/Invalid save slot name/);
    await expect(callSaveStore(store, game, 'format')).rejects.toThrow(/Unknown saves operation: format/);
  });
});
