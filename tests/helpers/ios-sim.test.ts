import { describe, expect, it } from 'vitest';
import { startUntilWarm } from './ios-sim.js';

const BRIDGE = 'gameshipper-bridge:{"ok":true}';
const MARKERS = [BRIDGE, 'mobile-probe:', 'gameshipper-frames:'];
/** What a start that reported everything printed, having drawn `frames` frames. */
const reported = (frames: number): string => `⚡️  [log] - ${BRIDGE}\n⚡️  [log] - mobile-probe:steam=undefined:size=852x393\n⚡️  [log] - gameshipper-frames:${frames}\n`;

/** Plays the given starts in order, on a clock that each start moves on by the seconds it takes. */
function simulator(runs: Array<{ out: string; seconds: number }>) {
  let clock = 1_000_000;
  const budgets: number[] = [];
  const start = async (budgetMs: number): Promise<string> => {
    const run = runs[budgets.length];
    if (!run) throw new Error('started more often than the test planned for');
    budgets.push(budgetMs);
    clock += run.seconds * 1000;
    return run.out;
  };
  const options = (minutes: number) => ({ markers: MARKERS, minFrames: 10, maxStarts: 3, startLimitMs: 3 * 60_000, deadline: 1_000_000 + minutes * 60_000, now: () => clock });
  return { start, options, budgets };
}

describe('startUntilWarm', () => {
  it('checks the first start when it drew its frames at speed', async () => {
    const sim = simulator([{ out: reported(88), seconds: 4 }]);
    const r = await startUntilWarm(sim.start, sim.options(10));
    expect(r).toEqual({ out: reported(88), frames: 88, starts: ['88 frames, reported after 4 s'] });
  });

  it('starts again after a start that reported everything but drew too few frames, as on a simulator still booting', async () => {
    const sim = simulator([
      { out: reported(1), seconds: 70 },
      { out: reported(90), seconds: 5 },
    ]);
    const r = await startUntilWarm(sim.start, sim.options(10));
    expect(r.frames).toBe(90);
    expect(r.out).toBe(reported(90));
    expect(r.starts).toEqual(['1 frames, reported after 70 s', '90 frames, reported after 5 s']);
  });

  it('never starts again after a start that did not report: a game that fails on its first launch stays failed', async () => {
    // Nothing at all within its three minutes; the second start, which would have passed, never happens.
    const silent = simulator([
      { out: '', seconds: 180 },
      { out: reported(90), seconds: 5 },
    ]);
    const r = await startUntilWarm(silent.start, silent.options(10));
    expect(r).toEqual({ out: '', frames: null, starts: [`gave up after 180 s without ${MARKERS.join(', ')}`] });
    expect(silent.budgets).toHaveLength(1);

    // The page loaded, but the game never got as far as counting its frames.
    const stuck = simulator([
      { out: reported(0).replace(/.*gameshipper-frames.*\n/, ''), seconds: 180 },
      { out: reported(90), seconds: 5 },
    ]);
    expect((await startUntilWarm(stuck.start, stuck.options(10))).starts).toEqual(['gave up after 180 s without gameshipper-frames:']);
    expect(stuck.budgets).toHaveLength(1);
  });

  it('never starts again after a start whose saves did not work, however few frames it drew', async () => {
    const noBridge = reported(1).replace(BRIDGE, 'gameshipper-bridge:{"ok":false}');
    const sim = simulator([
      { out: noBridge, seconds: 60 },
      { out: reported(90), seconds: 5 },
    ]);
    const r = await startUntilWarm(sim.start, sim.options(10));
    expect(r.out).toBe(noBridge);
    expect(r.frames).toBe(1);
    expect(r.starts).toEqual([`gave up after 60 s without ${BRIDGE}`]);
    expect(sim.budgets).toHaveLength(1);
  });

  it('stops after three starts, and hands back the last one', async () => {
    const sim = simulator([1, 2, 3, 90].map((frames) => ({ out: reported(frames), seconds: 60 })));
    const r = await startUntilWarm(sim.start, sim.options(30));
    expect(r.frames).toBe(3);
    expect(r.starts).toHaveLength(3);
  });

  it('never begins a start that could still be running at the deadline, so three slow starts fit in the time they were given', async () => {
    // Each start reports just before its three minutes are up. Eight minutes are left: room for two, not for a third.
    const sim = simulator([1, 2, 90].map((frames) => ({ out: reported(frames), seconds: 179 })));
    const r = await startUntilWarm(sim.start, sim.options(8));
    expect(r.frames).toBe(2);
    expect(r.starts).toEqual(['1 frames, reported after 179 s', '2 frames, reported after 179 s', 'no time left for another start']);
    // Every start was given its full three minutes, never more.
    expect(sim.budgets).toEqual([180_000, 180_000]);

    // With less than one start's time left, none begins.
    const late = simulator([{ out: reported(90), seconds: 5 }]);
    expect(await startUntilWarm(late.start, late.options(2))).toEqual({ out: '', frames: null, starts: ['no time left for another start'] });
    expect(late.budgets).toEqual([]);
  });
});
