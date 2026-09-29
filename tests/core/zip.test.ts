import { describe, expect, it } from 'vitest';
import { readZipEntries, readZipEntry } from '../../src/core/steam/zip.js';
import { makeZip } from '../helpers/zip.js';

describe('zip reader', () => {
  it('lists and reads deflated and stored entries', () => {
    for (const method of [0, 8] as const) {
      const zip = makeZip({ 'sdk/Readme.txt': 'v1.65 23th July 2026', 'sdk/redistributable_bin/osx/libsteam_api.dylib': Buffer.alloc(5000, 7) }, method);
      const entries = readZipEntries(zip);
      expect(entries.map((e) => e.name)).toEqual(['sdk/Readme.txt', 'sdk/redistributable_bin/osx/libsteam_api.dylib']);
      expect(readZipEntry(zip, entries[0]).toString()).toBe('v1.65 23th July 2026');
      expect(readZipEntry(zip, entries[1])).toEqual(Buffer.alloc(5000, 7));
    }
  });

  it('keeps UTF-8 file names', () => {
    expect(readZipEntries(makeZip({ 'sdk/lisez-moi-é.txt': 'x' }))[0].name).toBe('sdk/lisez-moi-é.txt');
  });

  it('rejects files that are not zips, and damaged entries', () => {
    expect(() => readZipEntries(Buffer.from('definitely not a zip file, just some text'))).toThrow("it isn't a ZIP file");
    const zip = makeZip({ 'a.txt': 'hello hello hello' }, 0);
    const entry = readZipEntries(zip)[0];
    zip[30 + 'a.txt'.length] ^= 0xff;
    expect(() => readZipEntry(zip, entry)).toThrow('a.txt is damaged (checksum mismatch)');
  });
});
