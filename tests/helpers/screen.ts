import { spawnSync } from 'node:child_process';

export type ScreenLock = 'locked' | 'unlocked' | 'unknown';

/**
 * Whether this Mac's screen is locked. On a locked screen nothing is drawn, so Steam's overlay can't hook a game.
 *
 * How it's read: `ioreg -n Root -d1` prints the IORegistry root, whose IOConsoleUsers property holds one dictionary
 * per console session. While the screen is locked the window server sets "CGSSessionScreenIsLocked"=Yes in it; the
 * key is absent otherwise. 'unknown' when ioreg fails or lists no console session (not a Mac, or no one logged in).
 * `raw` is the matching text, for reports.
 */
export function screenLock(): { state: ScreenLock; raw: string } {
  const r = spawnSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' });
  const out = r.stdout ?? '';
  if (r.status !== 0 || !out.includes('"IOConsoleUsers"')) return { state: 'unknown', raw: `ioreg ${r.error ? `failed: ${r.error.message}` : 'listed no console session'}` };
  const flag = /"CGSSessionScreenIsLocked"=(\w+)/.exec(out);
  return flag?.[1] === 'Yes' ? { state: 'locked', raw: flag[0] } : { state: 'unlocked', raw: flag ? flag[0] : 'CGSSessionScreenIsLocked absent' };
}
