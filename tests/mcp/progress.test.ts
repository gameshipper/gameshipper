import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgress, type ProgressUpdate } from '../../src/mcp/progress.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createProgress', () => {
  it('counts every line but sends at most one update per interval', () => {
    const sent: ProgressUpdate[] = [];
    let t = 0;
    const p = createProgress(async (u) => void sent.push(u), { minIntervalMs: 100, now: () => t });
    p.line('staging');
    t = 50;
    p.line('bundling');
    t = 150;
    p.line('packaging windows');
    p.stop();
    expect(sent).toEqual([
      { progress: 1, message: 'staging' },
      { progress: 3, message: 'packaging windows' },
    ]);
  });

  it('shortens long lines and ignores send failures', () => {
    const sent: ProgressUpdate[] = [];
    const p = createProgress(async (u) => {
      sent.push(u);
      throw new Error('client gone');
    });
    p.line('x'.repeat(1000));
    p.stop();
    expect(sent[0].message).toHaveLength(301);
  });

  it('says the call is waiting for another command on the same folder, until its command starts', () => {
    vi.useFakeTimers();
    const sent: ProgressUpdate[] = [];
    const p = createProgress(async (u) => void sent.push(u), { heartbeatMs: 3000 });
    p.waiting();
    vi.advanceTimersByTime(3100);
    p.running();
    vi.advanceTimersByTime(3000);
    p.stop();
    expect(sent.map((u) => u.message)).toEqual([
      'Waiting for another Gameshipper command on this folder to finish…',
      'Waiting for another Gameshipper command on this folder (3 s)…',
      'Still running (6 s)…',
    ]);
    expect(sent.map((u) => u.progress)).toEqual([1, 2, 3]);
  });

  it('keeps sending while nothing is logged, so a long download does not time the call out', () => {
    vi.useFakeTimers();
    const sent: ProgressUpdate[] = [];
    const p = createProgress(async (u) => void sent.push(u), { heartbeatMs: 3000 });
    vi.advanceTimersByTime(2900);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(3100);
    expect(sent.map((u) => u.message)).toEqual(['Still running (3 s)…', 'Still running (6 s)…']);
    expect(sent.map((u) => u.progress)).toEqual([1, 2]);
    p.stop();
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(2);
  });
});
