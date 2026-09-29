import { describe, expect, it, vi } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import type { Prompter } from '../../src/cli/prompt.js';
import { detectProject } from '../../src/core/config/detect.js';
import { initProject } from '../../src/core/config/init.js';
import { makeTmpDir, readText, writeFiles } from '../helpers/tmp.js';

async function run(argv: string[], stdinIsTTY = false, prompter?: Prompter): Promise<{ code: number; out: string }> {
  let out = '';
  const io: CliIO = { write: (t) => void (out += t), stdinIsTTY, prompter };
  const code = await main(argv, io);
  return { code, out };
}

describe('store art in init', () => {
  it('detects key art and logo under their conventional names only', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'art/key-art.jpg': '', 'art/logo.png': '', 'logo.png': '' });
    expect(detectProject(dir)).toMatchObject({ keyArt: 'art/key-art.jpg', logo: 'art/logo.png' });
    const plain = makeTmpDir();
    writeFiles(plain, { 'index.html': '', 'logo.png': '' });
    expect(detectProject(plain)).toMatchObject({ keyArt: null, logo: null });
  });

  it('writes answers over detection, null meaning none', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'art/key-art.png': '', 'art/logo.png': '', 'promo/art.png': '' });
    const r = initProject(dir, { keyArt: 'promo/art.png', logo: null });
    expect(r.data!.config).toMatchObject({ keyArt: 'promo/art.png', logo: null });
    expect(JSON.parse(readText(dir, 'gameshipper.json'))).toMatchObject({ keyArt: 'promo/art.png', logo: null });
    const detected = makeTmpDir();
    writeFiles(detected, { 'index.html': '', 'art/key-art.png': '' });
    expect(initProject(detected).data!.config).toMatchObject({ keyArt: 'art/key-art.png', logo: null });
  });

  it('ASSET_MISSING for key art or a logo that does not exist', () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '' });
    const r = initProject(dir, { keyArt: 'nope.png', logo: 'gone.png' });
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([
      ['ASSET_MISSING', "keyArt: nope.png doesn't exist."],
      ['ASSET_MISSING', "logo: gone.png doesn't exist."],
    ]);
    expect(r.errors[0].fix).toBe('Pass --key-art with a path relative to your project folder, or --key-art none.');
  });

  it('init --key-art and --logo set the paths without prompting', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'k.png': '' });
    const r = await run(['init', '--yes', '--json', '--dir', dir, '--key-art', 'k.png', '--logo', 'none']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).data.config).toMatchObject({ keyArt: 'k.png', logo: null });
  });

  it('asks a person at a terminal, offering what was detected', async () => {
    const dir = makeTmpDir();
    writeFiles(dir, { 'index.html': '', 'art/key-art.png': '', 'promo/logo.png': '' });
    const ask = vi.fn(async (q: string, fallback: string) => (q.startsWith('Logo') ? 'promo/logo.png' : fallback));
    const r = await run(['init', '--dir', dir], true, { ask });
    expect(r.code).toBe(0);
    expect(ask.mock.calls.slice(3)).toEqual([
      ['Key art for the store images, PNG or JPEG, 3840x2160 ("none" to skip)', 'art/key-art.png'],
      ['Logo for the store images, PNG with a transparent background ("none" to skip)', 'none'],
    ]);
    expect(JSON.parse(readText(dir, 'gameshipper.json'))).toMatchObject({ keyArt: 'art/key-art.png', logo: 'promo/logo.png' });
    expect(r.out).toContain('  Store art: key art art/key-art.png, logo promo/logo.png');
  });
});
