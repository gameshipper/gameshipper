import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { outputTail } from '../proc.js';
import { readZipEntries, readZipEntry } from '../steam/zip.js';
import { runExternal, toolCommand } from './run.js';

const LOCAL_HEADER = 0x04034b50;
const DIRECTORY_ENTRY = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
/** Plain zip (no ZIP64): sizes and offsets under 4 GiB, at most 65,535 entries. */
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;
/** "Version made by": 3 = Unix, so unzip tools read file types and modes from the external attributes; 20 = zip 2.0. */
const MADE_BY_UNIX = (3 << 8) | 20;
/** General purpose flag bit 11: names are UTF-8. */
const UTF8_NAMES = 0x0800;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
/** Zipping a large game can take a while; this only stops a ditto that hangs. */
const ZIP_TIMEOUT_MS = 60 * 60 * 1000;
/** Apple's ditto, by its full path: whatever else is called ditto on PATH isn't run. */
export const DITTO = '/usr/bin/ditto';

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Windows has no executable bit, so a Linux build made there has none either: an ELF binary or a script is marked
 * executable (0755), everything else 0644. Elsewhere a file keeps its own permissions.
 */
function fileMode(stat: fs.Stats, data: Buffer, platform: NodeJS.Platform): number {
  if (platform !== 'win32') return stat.mode & 0o777;
  const elf = data.length >= 4 && data[0] === 0x7f && data.toString('latin1', 1, 4) === 'ELF';
  const script = data.length >= 2 && data[0] === 0x23 && data[1] === 0x21;
  return elf || script ? 0o755 : 0o644;
}

/**
 * Zips the contents of `srcDir` (not the folder itself) into `zipFile` with plain Node: symlinks stay symlinks (a Mac
 * app's frameworks need them) and files keep their modes. Throws an Error with the reason, including for a build too
 * large for a plain zip (4 GiB or 65,535 entries).
 */
export function writeZip(srcDir: string, zipFile: string, opts: { platform?: NodeJS.Platform } = {}): { entries: number } {
  const platform = opts.platform ?? process.platform;
  fs.mkdirSync(path.dirname(zipFile), { recursive: true });
  const fd = fs.openSync(zipFile, 'w');
  const directory: Buffer[] = [];
  let offset = 0;
  let entries = 0;
  const write = (buf: Buffer): void => {
    for (let done = 0; done < buf.length; ) done += fs.writeSync(fd, buf, done, buf.length - done);
    offset += buf.length;
  };
  const add = (name: string, data: Buffer, type: number, mode: number, mtime: Date): void => {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = type === S_IFREG && data.length ? zlib.deflateRawSync(data) : null;
    const method = deflated && deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated! : data;
    if (offset + 30 + nameBuf.length + body.length > MAX_32 || entries >= MAX_ENTRIES) {
      throw new Error(`the build is too large for a zip (more than 4 GiB or ${MAX_ENTRIES} files)`);
    }
    const crc = zlib.crc32(data);
    const { time, date } = dosDateTime(mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const at = offset;
    write(local);
    write(nameBuf);
    write(body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(DIRECTORY_ENTRY, 0);
    entry.writeUInt16LE(MADE_BY_UNIX, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8_NAMES, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    // Unix type and mode in the high half; the MS-DOS directory bit for Windows' own unzip.
    entry.writeUInt32LE((((type | mode) << 16) | (type === S_IFDIR ? 0x10 : 0)) >>> 0, 38);
    entry.writeUInt32LE(at, 42);
    directory.push(entry, nameBuf);
    entries++;
  };
  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = `${prefix}${name}`;
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        add(rel, Buffer.from(fs.readlinkSync(abs), 'utf8'), S_IFLNK, 0o755, stat.mtime);
      } else if (stat.isDirectory()) {
        add(`${rel}/`, Buffer.alloc(0), S_IFDIR, platform === 'win32' ? 0o755 : stat.mode & 0o777, stat.mtime);
        walk(abs, `${rel}/`);
      } else if (stat.isFile()) {
        const data = fs.readFileSync(abs);
        add(rel, data, S_IFREG, fileMode(stat, data, platform), stat.mtime);
      }
    }
  };
  try {
    walk(srcDir, '');
    const dirBuf = Buffer.concat(directory);
    if (offset + dirBuf.length > MAX_32) throw new Error('the build is too large for a zip (more than 4 GiB)');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_DIRECTORY, 0);
    end.writeUInt16LE(entries, 8);
    end.writeUInt16LE(entries, 10);
    end.writeUInt32LE(dirBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    write(dirBuf);
    write(end);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(zipFile, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  return { entries };
}

/**
 * Zips the contents of a build folder for a release, so it unzips (Windows' Extract All, macOS's Archive Utility) into
 * a folder named after the zip. On a Mac, Apple's ditto, without extended attributes, resource forks or ACLs: plain
 * `ditto -c -k` stores those as ._ files next to every file, and a Mac app unzipped with `unzip` then fails its
 * signature check ("a sealed resource is missing or invalid"). A signed Mac app doesn't need them (its signature is
 * in the bundle). ditto is stopped with Gameshipper (Ctrl+C, SIGTERM, an MCP cancel). Elsewhere, writeZip. Throws an
 * Error with the reason. `ditto` replaces Apple's (tests).
 */
export async function zipFolder(srcDir: string, zipFile: string, opts: { platform?: NodeJS.Platform; ditto?: string } = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  fs.rmSync(zipFile, { force: true });
  fs.mkdirSync(path.dirname(zipFile), { recursive: true });
  if (platform !== 'darwin') {
    writeZip(srcDir, zipFile, { platform });
    return;
  }
  const args = ['-c', '-k', '--norsrc', '--noextattr', '--noacl', srcDir, zipFile];
  const r = await runExternal(toolCommand(opts.ditto ?? DITTO, { ...process.env }), args, { timeoutMs: ZIP_TIMEOUT_MS });
  if (r.exitCode === 0) return;
  fs.rmSync(zipFile, { force: true });
  const why =
    r.spawnError ??
    (r.timedOut ? `it didn't finish in ${ZIP_TIMEOUT_MS / 60_000} minutes` : outputTail(r.output) || (r.exitCode === null ? 'it was stopped' : `it exited with code ${r.exitCode}`));
  throw new Error(`ditto failed: ${why}`);
}

/**
 * Unpacks a zip (butler's, SteamCMD's for Windows) into destDir, keeping file modes. Refuses entries that would land
 * outside destDir, and symbolic links (neither tool has any). Throws an Error with the reason.
 */
export function unzipTo(zip: Buffer, destDir: string): void {
  const root = path.resolve(destDir);
  for (const entry of readZipEntries(zip)) {
    const target = path.resolve(root, entry.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`${entry.name} would land outside the folder`);
    if (entry.unixMode !== null && (entry.unixMode & 0o170000) === S_IFLNK) throw new Error(`${entry.name} is a symbolic link`);
    if (entry.name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = entry.unixMode !== null ? entry.unixMode & 0o777 : 0;
    fs.writeFileSync(target, readZipEntry(zip, entry), { mode: mode || 0o644 });
    // writeFileSync's mode only applies to a new file, and the umask trims it.
    if (mode && process.platform !== 'win32') fs.chmodSync(target, mode);
  }
}
