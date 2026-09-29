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
});
