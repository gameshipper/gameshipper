import { describe, expect, it } from 'vitest';
import { parseRange, planFileResponse } from '../../src/shell/range.js';

describe('parseRange', () => {
  it('returns null when there is no Range header', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('', 100)).toBeNull();
  });

  it('parses start-end, open-ended and suffix ranges (end is inclusive)', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=99-99', 100)).toEqual({ start: 99, end: 99 });
    expect(parseRange('Bytes=0-0', 100)).toEqual({ start: 0, end: 0 });
  });

  it('clamps ends and suffixes that run past the file', () => {
    expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-200', 100)).toEqual({ start: 0, end: 99 });
  });

  it('reports ranges that select no bytes as unsatisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=100-200', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-5', 0)).toBe('unsatisfiable');
  });

  it('ignores headers it cannot use (other units, bad syntax, several ranges)', () => {
    for (const h of ['items=0-5', 'bytes=5-2', 'bytes=-', 'bytes=abc', 'bytes=1.5-2', 'bytes=0-1,5-6', 'bytes 0-5']) {
      expect(parseRange(h, 100)).toBeNull();
    }
  });
});

describe('planFileResponse', () => {
  const isolation = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' };

  it('serves the whole file with Accept-Ranges and cross-origin isolation headers', () => {
    expect(planFileResponse(100, null, 'video/mp4')).toEqual({
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '100', 'accept-ranges': 'bytes', ...isolation },
      body: 'whole',
    });
  });

  it('serves a single range as 206 Partial Content', () => {
    expect(planFileResponse(100, 'bytes=-10', 'video/mp4')).toEqual({
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-length': '10', 'accept-ranges': 'bytes', 'content-range': 'bytes 90-99/100', ...isolation },
      body: { start: 90, end: 99 },
    });
  });

  it('answers unsatisfiable ranges with 416 and the file size', () => {
    expect(planFileResponse(100, 'bytes=500-', 'video/mp4')).toEqual({
      status: 416,
      headers: { 'content-length': '0', 'accept-ranges': 'bytes', 'content-range': 'bytes */100' },
      body: null,
    });
  });

  it('falls back to the whole file for a Range header it ignores', () => {
    expect(planFileResponse(100, 'bytes=0-1,5-6', 'text/plain').status).toBe(200);
  });
});
