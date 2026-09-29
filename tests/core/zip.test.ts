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

  it('never inflates an entry past its recorded size', () => {
    const zip = makeZip({ 'big.bin': Buffer.alloc(1_000_000) });
    const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, central + 24);
    const entry = readZipEntries(zip)[0];
    expect(entry.size).toBe(10);
    expect(() => readZipEntry(zip, entry)).toThrow('big.bin is damaged (it holds more than its recorded 10 bytes)');
  });

  it('rejects encrypted entries', () => {
    const zip = makeZip({ 'secret.dll': 'x' });
    const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 1, central + 8);
    const entry = readZipEntries(zip)[0];
    expect(entry.encrypted).toBe(true);
    expect(() => readZipEntry(zip, entry)).toThrow("secret.dll is encrypted (password-protected zips aren't supported)");
  });
});
