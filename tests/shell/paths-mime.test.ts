import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mimeType } from '../../src/shell/mime.js';
import { caseMismatch, requestParts, resolveGamePath, userDataDir } from '../../src/shell/paths.js';

describe('requestParts / resolveGamePath', () => {
  it('maps app:// URLs to files under the game root', () => {
    expect(requestParts('app://game/js/main.js')).toEqual(['js', 'main.js']);
    expect(requestParts('app://game/')).toEqual(['index.html']);
    expect(requestParts('app://game/levels/')).toEqual(['levels', 'index.html']);
    expect(requestParts('app://game/My%20Level.json')).toEqual(['My Level.json']);
    expect(resolveGamePath('/g', 'app://game/a/b.png')).toBe(path.join('/g', 'a', 'b.png'));
  });

  it('refuses to escape the game root', () => {
    // The URL parser itself collapses ".." and "%2e%2e" segments, so those stay inside the root:
    expect(requestParts('app://game/%2e%2e/secret')).toEqual(['secret']);
    // Encoded slashes and backslashes survive parsing and must be rejected after decoding:
    expect(requestParts('app://game/a%2f..%2f..%2fsecret')).toBeNull();
    expect(requestParts('app://game/a%5c..%5csecret')).toBeNull();
    expect(resolveGamePath('/g', 'app://game/x%2f..%2f..%2fetc%2fpasswd')).toBeNull();
  });
});

describe('caseMismatch', () => {
  const tree: Record<string, string[]> = { '/g': ['Assets', 'index.html'], [path.join('/g', 'Assets')]: ['Player.png'] };
  const listDir = (dir: string) => {
    if (!tree[dir]) throw new Error('ENOENT');
    return tree[dir];
  };

  it('returns null when the case matches exactly', () => {
    expect(caseMismatch('/g', ['Assets', 'Player.png'], listDir)).toBeNull();
  });
  it('returns the real path when only the case differs', () => {
    expect(caseMismatch('/g', ['assets', 'player.png'], listDir)).toBe('Assets/Player.png');
  });
  it('returns null when the file does not exist in any case', () => {
    expect(caseMismatch('/g', ['assets', 'enemy.png'], listDir)).toBeNull();
  });
});

describe('mimeType', () => {
  it('knows the types browsers are strict about', () => {
    expect(mimeType('a/main.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeType('a/m.MJS')).toBe('text/javascript; charset=utf-8');
    expect(mimeType('x.wasm')).toBe('application/wasm');
    expect(mimeType('x.html')).toBe('text/html; charset=utf-8');
    expect(mimeType('x.glb')).toBe('model/gltf-binary');
    expect(mimeType('x.unknown')).toBe('application/octet-stream');
  });
});

describe('userDataDir', () => {
  it('uses GAMESHIPPER_USER_DATA when set (play runs keep saves in the project)', () => {
    expect(userDataDir({ GAMESHIPPER_USER_DATA: '/p/.gameshipper/play-data' }, '/appdata', 'Moon- Rising')).toBe('/p/.gameshipper/play-data');
  });

  it("otherwise names the folder after the file-safe productName, under the OS's app data folder", () => {
    expect(userDataDir({}, '/appdata', 'Moon- Rising')).toBe(path.join('/appdata', 'Moon- Rising'));
    expect(userDataDir({ GAMESHIPPER_USER_DATA: '' }, '/appdata', 'Moon- Rising')).toBe(path.join('/appdata', 'Moon- Rising'));
  });
});
