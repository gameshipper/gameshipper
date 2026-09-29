import * as zlib from 'node:zlib';

/** One file in a ZIP archive, from its central directory. */
export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** Offset of the entry's local header. */
  offset: number;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/**
 * Lists a ZIP archive's files. Enough for Valve's Steamworks SDK zips: stored or deflated
 * entries, no ZIP64, no encryption. Throws an Error with a plain-English reason otherwise.
 */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("it isn't a ZIP file");
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== DIRECTORY_ENTRY) throw new Error('its file list is damaged');
    const utf8 = (zip.readUInt16LE(p + 8) & 0x800) !== 0;
    const nameLength = zip.readUInt16LE(p + 28);
    entries.push({
      name: zip.toString(utf8 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength),
      method: zip.readUInt16LE(p + 10),
      crc32: zip.readUInt32LE(p + 16),
      compressedSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      offset: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}

/** The uncompressed contents of one entry, checked against its CRC-32. */
export function readZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const p = entry.offset;
  if (p + 30 > zip.length || zip.readUInt32LE(p) !== LOCAL_HEADER) throw new Error(`${entry.name} is damaged`);
  const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
  const packed = zip.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(packed);
  else if (entry.method === 8) data = zlib.inflateRawSync(packed);
  else throw new Error(`${entry.name} uses an unsupported compression method (${entry.method})`);
  if (data.length !== entry.size || zlib.crc32(data) !== entry.crc32) throw new Error(`${entry.name} is damaged (checksum mismatch)`);
  return data;
}
