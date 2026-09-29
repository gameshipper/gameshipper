import { describe, expect, it } from 'vitest';
import { summaryToIssues } from '../../src/core/smoke.js';
import type { DiagEvent } from '../../src/shell/diagnostics.js';

describe('summaryToIssues for capture events', () => {
  it('a failed screenshot is a warning; saved screenshots and blocked requests are not issues', () => {
    const events: DiagEvent[] = [
      { kind: 'screenshot', file: '/p/out/store/screenshots/a.png', width: 1920, height: 1080 },
      { kind: 'screenshot-failed', error: 'taking the screenshot timed out after 5 s' },
      { kind: 'blocked-request', url: 'wss://example.com/live' },
    ];
    const { errors, warnings } = summaryToIssues({ droppedInfo: 0, events });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      {
        code: 'SCREENSHOT_FAILED',
        message: "A screenshot couldn't be saved: taking the screenshot timed out after 5 s",
        fix: 'Try again. If it keeps failing, run with --verbose and report the run log.',
      },
    ]);
  });
});
