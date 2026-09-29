import { describe, expect, it } from 'vitest';
import { capture, fail, GsFailure, gsError, internalError, ok } from '../../src/core/result.js';

describe('result', () => {
  it('ok wraps data with no errors', () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 }, errors: [], warnings: [] });
  });

  it('fail accepts one error or many', () => {
    const e = gsError('X', 'broke', 'fix it');
    expect(fail(e).errors).toEqual([e]);
    expect(fail([e, e]).errors).toHaveLength(2);
    expect(fail(e).ok).toBe(false);
  });

  it('gsError omits fix when not given', () => {
    expect(gsError('X', 'm')).toEqual({ code: 'X', message: 'm' });
  });

  it('capture converts GsFailure into a failed Result', async () => {
    const r = await capture(async () => {
      throw new GsFailure('CDN_FETCH_FAILED', 'nope', 'check network');
    });
    expect(r).toEqual({ ok: false, data: undefined, warnings: [], errors: [{ code: 'CDN_FETCH_FAILED', message: 'nope', fix: 'check network' }] });
  });

  it('capture converts unknown errors into INTERNAL_ERROR', async () => {
    const r = await capture(async () => {
      throw new Error('boom');
    });
    expect(r.errors[0].code).toBe('INTERNAL_ERROR');
    expect(r.errors[0].message).toContain('boom');
  });

  it('capture passes through a returned Result', async () => {
    expect(await capture(async () => ok(5))).toEqual(ok(5));
  });

  it('capture hands the stack of an unexpected error to the log, so "report the log" helps', async () => {
    const lines: string[] = [];
    const r = await capture(async () => {
      throw new Error('boom');
    }, (line) => lines.push(line));
    expect(r.errors[0].code).toBe('INTERNAL_ERROR');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Error: boom\n\s+at /);
  });

  it('capture does not log expected failures', async () => {
    const lines: string[] = [];
    await capture(async () => {
      throw new GsFailure('X', 'y');
    }, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('internalError describes anything thrown', () => {
    expect(internalError('text')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error: text',
      fix: 'This is a Gameshipper bug. Re-run with --verbose and report the log.',
    });
  });
});
