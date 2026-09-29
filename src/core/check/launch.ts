import { DECK_SIZE, QUIT_TIMEOUT_EXIT_CODE, QUIT_TIMEOUT_MS } from '../../shell/capture.js';
import type { FrameInfo } from '../assets/inspect.js';
import type { DesktopTarget } from '../config/schema.js';
import type { GsError, Result } from '../result.js';
import { problemCount, type SmokeData } from '../smoke.js';
import { SCAN_HEURISTIC, type CodeScan } from './scan.js';
import { capDetails, type CheckResult } from './types.js';

export interface LaunchEvidence {
  /** This computer's desktop target, or null on an OS Gameshipper doesn't build for. */
  host: DesktopTarget | null;
  hostTargeted: boolean;
  /** The host build that was launched (a relative path, for messages), or null. */
  launched: string | null;
  seconds: number;
  /** The smoke run's result, when the game started and reported back. */
  smoke: Result<SmokeData> | null;
  /** Why the game couldn't be run (LAUNCH_FAILED, SMOKE_NO_RESULT). */
  launchError: GsError | null;
  /** Every address the network block stopped, from the run's events log. */
  blocked: string[];
  frame: FrameInfo | null;
  scan: CodeScan | null;
  /** Desktop targets built but not launched here. */
  otherBuilt: DesktopTarget[];
  /**
   * Set when the game's window closed before Gameshipper closed it: `seconds` after its page loaded (null if it
   * hadn't). null for a run that lasted its full length.
   */
  closed: { seconds: number | null } | null;
}

/** Problems from the smoke run that belong in launch.errors. Crashes and load failures fail launch.run instead. */
const RUNTIME_ISSUES = new Set(['GAME_CONSOLE_ERROR', 'GAME_FILE_MISSING', 'GAME_PATH_CASE', 'PLUGIN_LOAD_FAILED', 'STEAM_INIT_FAILED']);
const STOPPED_ISSUES = new Set(['GAME_CRASHED', 'GAME_LOAD_FAILED']);
const DECK = `${DECK_SIZE.width}x${DECK_SIZE.height}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Longest blocked address a check shows: a game can request a URL of megabytes. */
const MAX_URL_CHARS = 300;
const shortUrl = (url: string) => (url.length > MAX_URL_CHARS ? `${url.slice(0, MAX_URL_CHARS)}…` : url);
/** "after 2.4 s", or "before its page loaded". */
const closedWhen = (closed: { seconds: number | null }) => (closed.seconds === null ? 'before its page loaded' : `after ${closed.seconds} s`);

function notRun(ev: LaunchEvidence): { run: CheckResult; reason: string } {
  const base = { id: 'launch.run', group: 'launch', title: 'The build starts and runs' } as const;
  if (!ev.host) {
    return { run: { ...base, status: 'skip', message: "Builds can't be launched on this operating system." }, reason: 'not launched on this OS' };
  }
  if (!ev.hostTargeted) {
    return {
      run: {
        ...base,
        status: 'warn',
        code: 'CHECK_NOT_LAUNCHED',
        message: `${ev.host} isn't in targets, so no build was launched on this computer.`,
        fix: 'Run `npx gameshipper check` on a computer that matches one of your targets (or in CI) to test the running game.',
      },
      reason: `no ${ev.host} target`,
    };
  }
  if (ev.launchError) {
    return {
      run: {
        ...base,
        status: 'fail',
        code: 'CHECK_LAUNCH_FAILED',
        message: `The ${ev.host} build didn't run: ${ev.launchError.message}`,
        fix: ev.launchError.fix ?? 'Run `npx gameshipper play` to watch it start.',
      },
      reason: 'the game did not run',
    };
  }
  return {
    run: {
      ...base,
      status: 'fail',
      code: 'CHECK_NOT_LAUNCHED',
      message: `There's no ${ev.host} build to launch.`,
      fix: `Run \`npx gameshipper build --target ${ev.host}\`, then check again.`,
    },
    reason: `no ${ev.host} build`,
  };
}

/** Offline, launch and Steam Deck checks (spec §9), from one run of the build for this computer. */
export function launchChecks(ev: LaunchEvidence): CheckResult[] {
  const otherOs: CheckResult = {
    id: 'launch.other-os',
    group: 'launch',
    title: 'Builds for other operating systems',
    status: 'info',
    message: ev.otherBuilt.length
      ? `${ev.otherBuilt.join(', ')}: built, not launched on this computer. Run check on those systems (or in CI) to launch them.`
      : 'No other desktop builds.',
  };
  const data = ev.smoke?.data;
  if (!ev.smoke || !data) {
    const { run, reason } = notRun(ev);
    const skip = (id: string, group: CheckResult['group'], title: string): CheckResult => ({ id, group, title, status: 'skip', message: `Not checked: ${reason}.` });
    return [
      skip('offline.requests', 'offline', 'Runs without internet'),
      run,
      skip('launch.errors', 'launch', 'No errors while running'),
      skip('launch.frame', 'launch', 'Draws a picture'),
      skip('launch.exit', 'launch', 'Quits cleanly when closed'),
      otherOs,
      skip('deck.layout', 'deck', `Fits the Steam Deck screen (${DECK})`),
      skip('deck.gamepad', 'deck', 'Reads a gamepad'),
      skip('deck.text-input', 'deck', 'Text fields'),
    ];
  }

  const issues = [...ev.smoke.errors, ...ev.smoke.warnings];
  const probe = data.summary.probe ?? null;
  const checks: CheckResult[] = [];
  /** How long the game really ran: less than asked when it closed its own window. */
  const ran = ev.closed ? (ev.closed.seconds ?? 0) : ev.seconds;

  const blocked = [...new Set(ev.blocked.map(shortUrl))];
  checks.push(
    blocked.length
      ? {
          id: 'offline.requests',
          group: 'offline',
          title: 'Runs without internet',
          status: 'fail',
          code: 'CHECK_OFFLINE',
          message: `With the network blocked, the game tried to load ${blocked.length} internet address${blocked.length === 1 ? '' : 'es'}, starting with ${blocked[0]}.`,
          fix: 'Put these files in your game folder and load them by relative path, or load them with a <script>, <link> or import map entry so `npx gameshipper build` bundles them. Online features must leave the game playable offline.',
          details: capDetails(blocked),
        }
      : { id: 'offline.requests', group: 'offline', title: 'Runs without internet', status: 'pass', message: `No internet requests in ${ran} s with the network blocked.` },
  );

  const stopped = issues.find((i) => STOPPED_ISSUES.has(i.code));
  checks.push(
    stopped
      ? {
          id: 'launch.run',
          group: 'launch',
          title: 'The build starts and runs',
          status: 'fail',
          code: 'CHECK_LAUNCH_FAILED',
          message: stopped.message,
          fix: stopped.fix ?? 'Run `npx gameshipper play --smoke --json` for details; the events log shows the last messages before it stopped.',
        }
      : {
          id: 'launch.run',
          group: 'launch',
          title: 'The build starts and runs',
          status: 'pass',
          message: ev.closed ? `Launched ${ev.launched}; it closed its own window ${closedWhen(ev.closed)}.` : `Launched ${ev.launched} and ran it for ${ev.seconds} s.`,
        },
  );

  const runtime = issues.filter((i) => RUNTIME_ISSUES.has(i.code));
  checks.push(
    runtime.length
      ? {
          id: 'launch.errors',
          group: 'launch',
          title: 'No errors while running',
          status: 'warn',
          code: 'CHECK_GAME_ERRORS',
          // Each code lists a few problems, then one issue counting the rest.
          message: `${plural(problemCount(runtime), 'problem')} while the game ran, starting with: ${runtime[0].message}`,
          fix: 'Run `npx gameshipper play --smoke --json` to see each one with its fix, then rebuild and check again.',
          details: capDetails(runtime.map((i) => `${i.code}: ${i.message}`)),
        }
      : { id: 'launch.errors', group: 'launch', title: 'No errors while running', status: 'pass', message: 'No console errors, missing files or wrong-case paths.' },
  );

  const frameBase = { id: 'launch.frame', group: 'launch', title: 'Draws a picture' } as const;
  if (!ev.frame) {
    const why = ev.closed
      ? `: the game closed its window ${closedWhen(ev.closed)}`
      : probe?.errors.length
        ? ` (${probe.errors.join('; ')})`
        : '';
    checks.push({
      ...frameBase,
      status: 'fail',
      code: 'CHECK_BLANK_FRAME',
      message: `Couldn't capture the game's window${why}.`,
      fix: ev.closed
        ? 'A game must keep its window open until the player quits. Run `npx gameshipper play` to see what closes it (launch.errors may say).'
        : 'Run `npx gameshipper play` to watch it; a window that never paints usually means the game froze while starting.',
    });
  } else if (ev.frame.blank) {
    checks.push({
      ...frameBase,
      status: 'fail',
      code: 'CHECK_BLANK_FRAME',
      message: `After ${ev.seconds} s the window was one flat colour (${ev.frame.color}): the game drew nothing.`,
      fix: 'Run `npx gameshipper play` to watch it start. A blank window usually means an error before the first frame (see launch.errors).',
    });
  } else if (ev.frame.plain) {
    checks.push({
      ...frameBase,
      status: 'warn',
      code: 'CHECK_MOSTLY_BLANK_FRAME',
      message: `The frame is mostly one colour (${Math.round(ev.frame.main.share * 100)}% ${ev.frame.main.color}); check the game isn't stuck on a loading screen.`,
      fix: `Look at ${probe?.frame ?? 'the Deck-size frame'}. A game that waits for a click or key on its title screen is fine; otherwise make sure it gets past loading within ${ev.seconds} s (see launch.errors), or check with a longer --seconds.`,
    });
  } else {
    checks.push({ ...frameBase, status: 'pass', message: `The game drew a non-uniform frame (${ev.frame.width}x${ev.frame.height} frame saved).` });
  }

  const exitBase = { id: 'launch.exit', group: 'launch', title: 'Quits cleanly when closed' } as const;
  const exitFix =
    'Steam shows a game as running until it exits. Remove beforeunload handlers that return a value (they keep the window open), and anything that keeps the app running after its window closes.';
  const waited = `${QUIT_TIMEOUT_MS / 1000} s`;
  // Without a probe the run ended before the shell closed the window (a crash, or the game closed it itself).
  if (ev.closed) {
    const code = data.exitCode === null ? 'stopped by a signal' : `exit code ${data.exitCode}`;
    checks.push({
      ...exitBase,
      status: 'skip',
      message: `Not checked: the game closed its own window ${closedWhen(ev.closed)} (${code}), before Gameshipper could close it like a player.`,
    });
  } else if (!probe) checks.push({ ...exitBase, status: 'skip', message: 'Not checked: the run ended before Gameshipper closed the window (see launch.run).' });
  else if (data.exitCode === 0) checks.push({ ...exitBase, status: 'pass', message: 'Exited with code 0 when its window closed.' });
  else {
    checks.push({
      ...exitBase,
      status: 'fail',
      code: 'CHECK_EXIT_CODE',
      message:
        data.exitCode === QUIT_TIMEOUT_EXIT_CODE
          ? `The game was still running ${waited} after its window was closed.`
          : data.exitCode === null
            ? 'The game had to be killed instead of exiting when its window closed.'
            : `Exited with code ${data.exitCode} when its window closed.`,
      fix: exitFix,
    });
  }

  checks.push(otherOs);

  const layout = probe?.layout ?? null;
  const layoutBase = { id: 'deck.layout', group: 'deck', title: `Fits the Steam Deck screen (${DECK})` } as const;
  const probeErrors = probe?.errors.length ? probe.errors.join('; ') : '';
  if (!layout) {
    checks.push({ ...layoutBase, status: 'skip', message: `Couldn't measure the page${probeErrors ? `: ${probeErrors}` : '.'}` });
  } else if (layout.viewport.width !== DECK_SIZE.width || layout.viewport.height !== DECK_SIZE.height) {
    // Measured at another size, the page says nothing about the Deck's screen.
    const size = `${layout.viewport.width}x${layout.viewport.height}`;
    checks.push({ ...layoutBase, status: 'skip', message: `Not checked: the page size couldn't be fixed (it was ${size}${probeErrors ? `; ${probeErrors}` : ''}).` });
  } else {
    const { viewport: v, scroll: s } = layout;
    const scrolls = (s.width > v.width + 2 && !layout.overflowHidden.x) || (s.height > v.height + 2 && !layout.overflowHidden.y);
    const texts = layout.offscreen.filter((o) => o.cut === 'text');
    const boxes = layout.offscreen.filter((o) => o.cut !== 'text');
    const problems: string[] = [];
    if (scrolls) problems.push(`the page is ${s.width}x${s.height}, so it scrolls and shows scrollbars`);
    if (texts.length) problems.push(`text in ${plural(texts.length, 'element')} runs past the screen edge`);
    if (boxes.length) problems.push(`${plural(boxes.length, 'element')} ${boxes.length === 1 ? 'is' : 'are'} cut off at the screen edge`);
    const sizing =
      'Size the game to the window (canvas = window.innerWidth x innerHeight, updated on resize), add `html, body { margin: 0; overflow: hidden }` and `canvas { display: block }`';
    const fix = texts.length
      ? `Keep text inside the screen: make each HUD text box wide enough for its longest text at ${DECK} (or let the text wrap, or make it smaller), so none runs past the edge.${scrolls || boxes.length ? ` ${sizing}.` : ''}`
      : `${sizing}, and keep HUD text inside the screen.`;
    const where = (o: { rect: [number, number, number, number] }) => `x ${o.rect[0]}..${o.rect[2]}, y ${o.rect[1]}..${o.rect[3]}`;
    checks.push(
      problems.length
        ? {
            ...layoutBase,
            status: 'warn',
            code: 'CHECK_DECK_LAYOUT',
            message: `At ${DECK}, ${problems.join(' and ')}.`,
            fix: `${fix}${probe?.frame ? ` Look at ${probe.frame}.` : ''}`,
            details: [
              ...(scrolls ? [`page ${s.width}x${s.height} in a ${v.width}x${v.height} screen`] : []),
              ...layout.offscreen.map((o) =>
                o.cut === 'text'
                  ? `${o.element}${o.text ? ` "${o.text}"` : ''}: its text spans ${where(o)}`
                  : `${o.element}${o.text ? ` "${o.text}"` : ''} spans ${where(o)}`,
              ),
            ],
          }
        : { ...layoutBase, status: 'pass', message: `No clipping or scrollbars at ${DECK}.` },
    );
  }

  const counters = probe?.counters ?? null;
  const gamepadBase = { id: 'deck.gamepad', group: 'deck', title: 'Reads a gamepad' } as const;
  const calls = counters ? counters.getGamepads + counters.gamepadListeners : 0;
  const inCode = ev.scan?.gamepad ?? [];
  const skipped = ev.scan?.skipped ?? [];
  // What the code scan left out, so a warning or a pass from the code can be judged.
  const scanDetails = ev.scan
    ? [SCAN_HEURISTIC, ...(skipped.length ? [`Skipped: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}`] : [])]
    : [];
  if (!counters && !ev.scan) checks.push({ ...gamepadBase, status: 'skip', message: "Couldn't watch the game's input or read its code." });
  else if (calls > 0) checks.push({ ...gamepadBase, status: 'pass', message: `The game used the gamepad API ${plural(calls, 'time')} while running.` });
  else if (inCode.length) {
    checks.push({
      ...gamepadBase,
      status: 'pass',
      message: `Gamepad code found in ${inCode.slice(0, 5).join(', ')} (not used during the check run).`,
      details: scanDetails,
    });
  } else {
    checks.push({
      ...gamepadBase,
      status: 'warn',
      code: 'CHECK_NO_GAMEPAD',
      message: "No gamepad support found: the game never called navigator.getGamepads() and its code doesn't mention it.",
      fix: 'Read controls with navigator.getGamepads() (or your engine\'s gamepad support) so the game plays with Steam Deck\'s controls. Without it the best Deck rating is "Playable", not "Verified".',
      ...(scanDetails.length ? { details: scanDetails } : {}),
    });
  }

  const onScreen = layout?.textInputs ?? 0;
  const textFiles = ev.scan?.textInputs ?? [];
  const found = [...(onScreen ? [`${onScreen} on screen`] : []), ...(textFiles.length ? [`in ${textFiles.slice(0, 5).join(', ')}`] : [])];
  checks.push({
    id: 'deck.text-input',
    group: 'deck',
    title: 'Text fields',
    status: 'pass',
    message: found.length
      ? `Text fields found (${found.join('; ')}). On Steam Deck the shell opens Steam's on-screen keyboard when one gets focus.`
      : 'No text fields found.',
  });
  return checks;
}
