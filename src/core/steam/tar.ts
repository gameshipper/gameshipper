import * as zlib from 'node:zlib';

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.toString('utf8', 0, end === -1 ? raw.length : end);
}

/** Long path names in PAX extended headers ("<len> path=<value>\n" records). */
function paxPath(body: Buffer): string | null {
  const m = body.toString('utf8').match(/(?:^|\n)\d+ path=([^\n]*)\n/);
  return m ? m[1] : null;
}

/** Regular files in a .tgz (like the npm registry's package tarballs), keyed by path. */
export function readTgz(tgz: Buffer): Map<string, Buffer> {
  const tar = zlib.gunzipSync(tgz);
  const files = new Map<string, Buffer>();
  let nextName: string | null = null;
  for (let p = 0; p + 512 <= tar.length; ) {
    const header = tar.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(header, 345, 155);
    const name = nextName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const body = tar.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      nextName = paxPath(body);
      continue;
    }
    if (type === 'L') {
      nextName = field(body, 0, body.length);
      continue;
    }
    nextName = null;
    if (type === '0' || type === '7') files.set(name, Buffer.from(body));
  }
  return files;
}
