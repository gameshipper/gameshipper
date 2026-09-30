import { describe, expect, it } from 'vitest';
import { boundedReasons, MAX_REASON_CHARS, MAX_REASONS } from '../../../src/core/publish/reasons.js';

describe('boundedReasons', () => {
  it('keeps short reasons as they are', () => {
    expect(boundedReasons(['Access Denied', 'Build for depot 482 failed : Failure'])).toEqual(['Access Denied', 'Build for depot 482 failed : Failure']);
    expect(boundedReasons([])).toEqual([]);
  });

  it("keeps each reason's first line, cut to 300 characters", () => {
    expect(boundedReasons(['  invalid key\ngithub.com/itchio/go-itchio.(*Client).GetResponse\n\tfile.go:130'])).toEqual(['invalid key']);
    const [cut] = boundedReasons([`${'x'.repeat(1000)}\nmore`]);
    expect([cut.length, cut.endsWith('x…')]).toEqual([MAX_REASON_CHARS + 1, true]);
    expect(boundedReasons(['y'.repeat(MAX_REASON_CHARS)])).toEqual(['y'.repeat(MAX_REASON_CHARS)]);
  });

  it('keeps at most 10, then counts the rest', () => {
    const reasons = Array.from({ length: 60 }, (_, i) => `problem ${i + 1}`);
    expect(boundedReasons(reasons)).toEqual([...reasons.slice(0, MAX_REASONS), '…and 50 more']);
    expect(boundedReasons(reasons.slice(0, 10))).toEqual(reasons.slice(0, 10));
    expect(boundedReasons(reasons, 1)).toEqual(['problem 1', '…and 59 more']);
  });
});
