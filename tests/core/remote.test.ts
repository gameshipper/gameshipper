import { describe, expect, it } from 'vitest';
import {
  extForContentType,
  isRelative,
  isRemote,
  normalizeRemote,
  resolveBare,
  vendorPathFor,
  vendorPrefixFor,
} from '../../src/core/prepare/remote.js';

describe('remote helpers', () => {
  it('classifies specifiers', () => {
    expect(isRemote('https://unpkg.com/three')).toBe(true);
    expect(isRemote('http://127.0.0.1:8080/a.js')).toBe(true);
    expect(isRemote('//cdn.x/a.js')).toBe(true);
    expect(isRemote('three')).toBe(false);
    expect(isRelative('./a.js')).toBe(true);
    expect(isRelative('../a.js')).toBe(true);
    expect(isRelative('/a.js')).toBe(true);
    expect(isRelative('three')).toBe(false);
    expect(normalizeRemote('//cdn.x/a.js')).toBe('https://cdn.x/a.js');
  });

  it('maps content types to extensions', () => {
    expect(extForContentType('text/javascript; charset=utf-8')).toBe('.js');
    expect(extForContentType('application/javascript')).toBe('.js');
    expect(extForContentType('text/css')).toBe('.css');
    expect(extForContentType('font/woff2')).toBe('.woff2');
    expect(extForContentType(null)).toBe('');
  });

  it('maps image, audio and font content types to extensions', () => {
    const cases: Array<[string, string]> = [
      ['image/jpeg', '.jpg'],
      ['image/gif', '.gif'],
      ['image/webp', '.webp'],
      ['image/avif', '.avif'],
      ['audio/mpeg', '.mp3'],
      ['audio/ogg', '.ogg'],
      ['audio/wav', '.wav'],
      ['audio/x-wav', '.wav'],
      ['audio/wave', '.wav'],
      ['font/otf', '.otf'],
    ];
    for (const [type, ext] of cases) expect(extForContentType(type), type).toBe(ext);
  });

  it('does not double a known extension that has a content-type mapping', () => {
    expect(vendorPathFor('https://x/img.avif', 'image/avif')).toBe('_gameshipper/cdn/x/img.avif');
    expect(vendorPathFor('https://x/img', 'image/avif')).toBe('_gameshipper/cdn/x/img.avif');
  });

  it('falls back to the raw path when a percent-escape is malformed', () => {
    expect(vendorPathFor('https://x/a%ZZ.js', null)).toBe('_gameshipper/cdn/x/a_ZZ.js');
    expect(vendorPrefixFor('https://x/b%E4/')).toBe('_gameshipper/cdn/x/b_E4/');
  });

  it('keeps known extensions and the URL path', () => {
    expect(vendorPathFor('https://unpkg.com/three@0.170.0/build/three.module.js', 'text/javascript')).toBe(
      '_gameshipper/cdn/unpkg.com/three@0.170.0/build/three.module.js',
    );
  });

  it('adds an extension from the content type when the URL has none', () => {
    expect(vendorPathFor('https://cdn.jsdelivr.net/npm/three@0.170.0/+esm', 'application/javascript')).toBe(
      '_gameshipper/cdn/cdn.jsdelivr.net/npm/three@0.170.0/+esm.js',
    );
  });

  it('encodes query strings and ports into the file name', () => {
    const p = vendorPathFor('http://127.0.0.1:5000/lib?module', 'text/javascript');
    expect(p).toMatch(/^_gameshipper\/cdn\/127\.0\.0\.1_5000\/lib__q[0-9a-f]{10}\.js$/);
    expect(vendorPathFor('http://127.0.0.1:5000/lib?module', 'text/javascript')).toBe(p);
  });

  it('prefix paths line up with file paths beneath them', () => {
    const prefix = vendorPrefixFor('https://unpkg.com/three@0.170.0/examples/jsm/');
    expect(prefix).toBe('_gameshipper/cdn/unpkg.com/three@0.170.0/examples/jsm/');
    expect(vendorPathFor('https://unpkg.com/three@0.170.0/examples/jsm/controls/OrbitControls.js', null).startsWith(prefix)).toBe(true);
  });

  it('resolves bare specifiers with an import map', () => {
    const map = { three: 'https://x/three.js', 'three/addons/': 'https://x/jsm/' };
    expect(resolveBare('three', map)).toBe('https://x/three.js');
    expect(resolveBare('three/addons/controls/Orbit.js', map)).toBe('https://x/jsm/controls/Orbit.js');
    expect(resolveBare('lodash', map)).toBeNull();
  });

  it('ignores inherited properties when resolving bare specifiers', () => {
    expect(resolveBare('constructor', {})).toBeNull();
    expect(resolveBare('toString', { 'three/': 'https://x/three/' })).toBeNull();
    expect(resolveBare('__proto__', {})).toBeNull();
  });
});
