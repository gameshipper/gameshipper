import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_ENV_NAMES, captureEnv, noticesIn, type CaptureSettings } from '../shell/capture.js';
import { LOAD_BACKSTOP_EXTRA_SECONDS, LOAD_TIMEOUT_DESCRIPTION, type DiagEvent, type DiagSummary } from '../shell/diagnostics.js';
import type { Ctx } from './context.js';
import { killTree, OUTPUT_BUFFER_CHARS, outputTail, releaseAfterExit, stopWithGameshipper } from './proc.js';
import { fail, GsFailure, gsError, ok, type GsError, type Result } from './result.js';

/** Per code, how many issues a smoke run lists before one more issue counts the rest. */
export const MAX_ISSUES_PER_CODE = 10;
/** How many diagnostic events a smoke result carries; the events log keeps every one. */
export const MAX_SUMMARY_EVENTS = 100;
/** Longest message or URL a smoke result shows in full; the events log keeps every character. */
export const MAX_TEXT_CHARS = 2000;

/** The shell's summary, cut to its first MAX_SUMMARY_EVENTS events so a noisy game's result stays small. */
export interface SmokeSummary extends DiagSummary {
  /** Events left out of `events`; all of them are in the events log. */
  truncatedEvents: number;
}

export interface SmokeData {
  summary: SmokeSummary;
  /** Every diagnostic event as JSON lines, including chatty console output. */
  eventsLog: string;
  /** null when the game was stopped by a signal, including Gameshipper's own timeout. */
  exitCode: number | null;
}

export interface SmokeOptions {
  command: string;
  args: string[];
  seconds: number;
  userDataDir: string;
  windowed: boolean;
  /** Stop the game if it's still running this long after launch. Default: `seconds` + 45 s. */
  timeoutMs?: number;
  /**
   * Extra environment variables for the game (a test emulating how Steam launches a game, say). They can't
   * change Gameshipper's own GAMESHIPPER_* variables or set ELECTRON_RUN_AS_NODE, which would stop the game
   * from starting as an app.
   */
  env?: NodeJS.ProcessEnv;
  /** What the shell captures during the run (`play --screenshot`, `check`); passed as its GAMESHIPPER_* variables. */
  capture?: CaptureSettings;
  /** File names of the key art and logo (stage.ts storeArtNames), which builds leave out unless the game names them. */
  storeArt?: string[];
}

/**
 * How long past the smoke duration a game may run before Gameshipper stops it. The shell ends a smoke
 * run itself by `seconds` + LOAD_BACKSTOP_EXTRA_SECONDS even when the page never loads, so this only
 * fires if the game hangs. Defined from the backstop so it always comes after it.
 */
export const SMOKE_TIMEOUT_GRACE_SECONDS = LOAD_BACKSTOP_EXTRA_SECONDS + 15;
/** After the game exits, how long to wait for its helper processes to release its output. */
const CLOSE_GRACE_MS = 2000;

const IGNORED_MISSING = new Set(['favicon.ico']);
const shortUrl = (url: string) => url.replace(/^app:\/\/game\//, '');

/** The file name a URL asks for: no query or fragment, URL-decoded. */
function requestedName(url: string): string {
  const name = url.replace(/[?#].*$/, '').split('/').pop() ?? '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const STORE_ART_FIX =
  "This file was left out of the build because it's your store art; if the game shows it, mention its name in the game's code or set it apart from keyArt/logo.";

function formatSeconds(ms: number): string {
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? '' : 's'}`;
}

/** The issue standing for the rest of a code's issues: "…and 19990 more like this (see the events log)". */
const MORE_LIKE_THIS = /^…and (\d+) more like this /;

/** How many problems `issues` stand for: an "…and N more like this" issue counts as N. */
export function problemCount(issues: GsError[]): number {
  return issues.reduce((n, issue) => n + (Number(MORE_LIKE_THIS.exec(issue.message)?.[1]) || 1), 0);
}

/** Compile-time check that every DiagEvent kind is handled. */
const unhandled = (_event: never): void => {};
/** Compile-time check that every SteamState is handled; a newer shell's unknown state is skipped. */
const unhandledState = (_state: never): void => {};

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}… (${text.length - MAX_TEXT_CHARS} more characters; see the events log)`;
}

/** The event with every text field (message, url, …) cut to MAX_TEXT_CHARS; the same object if none is longer. */
function capEvent(event: DiagEvent): DiagEvent {
  let capped: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === 'string' && value.length > MAX_TEXT_CHARS) (capped ??= { ...event })[key] = capText(value);
  }
  return (capped ?? event) as DiagEvent;
}

/**
 * `seconds` is the smoke run's duration, used to say how long the page had to load. `eventsLog` is named in
 * the issue that counts what's left out: each code lists at most MAX_ISSUES_PER_CODE issues.
 */
export function summaryToIssues(
  summary: DiagSummary,
  opts: { seconds?: number; eventsLog?: string; storeArt?: string[] } = {},
): { errors: GsError[]; warnings: GsError[] } {
  const errors: GsError[] = [];
  const warnings: GsError[] = [];
  const seen = new Set<string>();
  const perCode = new Map<string, { list: GsError[]; shown: number; more: number }>();
  const add = (list: GsError[], issue: GsError): void => {
    const key = `${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const count = perCode.get(issue.code) ?? { list, shown: 0, more: 0 };
    perCode.set(issue.code, count);
    if (count.shown < MAX_ISSUES_PER_CODE) {
      count.shown++;
      list.push(issue);
    } else {
      count.more++;
    }
  };
  // A game can log a whole file as one message: issues show at most MAX_TEXT_CHARS of any text.
  const events = summary.events.map(capEvent);
  // The shell records a wrong-case request as both case-mismatch and missing-file (it 404s).
  const realName = new Map<string, string>();
  for (const e of events) if (e.kind === 'case-mismatch') realName.set(e.url, e.actual);

  for (const e of events) {
    switch (e.kind) {
      case 'console': {
        if (e.level !== 'error' && e.level !== 'warning') break;
        const where = e.source ? ` (${shortUrl(e.source)}:${e.line})` : '';
        if (e.level === 'error') {
          add(errors, gsError('GAME_CONSOLE_ERROR', `${e.message}${where}`, 'Fix this error in your game code, then run `npx gameshipper play --smoke` again.'));
        } else {
          add(warnings, gsError('GAME_CONSOLE_WARNING', `${e.message}${where}`, 'Usually harmless; check it if the game misbehaves.'));
        }
        break;
      }
      case 'missing-file': {
        if (IGNORED_MISSING.has(shortUrl(e.url))) break;
        const actual = realName.get(e.url);
        add(
          errors,
          gsError(
            'GAME_FILE_MISSING',
            `The game requested ${shortUrl(e.url)}, which isn't in the build.`,
            actual
              ? `The file is named ${actual}: use exactly that letter case in your code.`
              : opts.storeArt?.includes(requestedName(e.url))
                ? STORE_ART_FIX
                : "Check the path's spelling and letter case, and that the file is inside your game folder.",
          ),
        );
        break;
      }
      case 'case-mismatch':
        add(
          warnings,
          gsError(
            'GAME_PATH_CASE',
            `The game requested ${shortUrl(e.url)} but the file is named ${e.actual}.`,
            'Change the path in your code to match the file name exactly. Packaged games treat upper and lower case as different files on every OS (Windows, macOS, Linux and Steam Deck), so this file fails to load in every build.',
          ),
        );
        break;
      case 'remote-request':
        add(
          warnings,
          gsError(
            'GAME_USES_INTERNET',
            `The game loaded ${e.url} from the internet${e.error ? ` (failed: ${e.error})` : ''}; it won't work offline.`,
            'Download the file into your game folder, or load it with a <script>/<link> tag or import map so Gameshipper bundles it.',
          ),
        );
        break;
      case 'load-failed':
        if (e.code === 0 && e.description === LOAD_TIMEOUT_DESCRIPTION) {
          // The shell's backstop: the page started loading but never finished.
          const within = opts.seconds === undefined ? '' : ` within ${formatSeconds((opts.seconds + LOAD_BACKSTOP_EXTRA_SECONDS) * 1000)}`;
          add(
            errors,
            gsError(
              'GAME_LOAD_FAILED',
              `The game's page never finished loading${within}.`,
              'Something the page waits for never arrived: check the events log for requests that never completed, or a script that never returns.',
            ),
          );
          break;
        }
        add(
          errors,
          gsError(
            'GAME_LOAD_FAILED',
            `The page failed to load: ${e.description} (${e.code}) at ${shortUrl(e.url)}.`,
            'Check game.entry in gameshipper.json points at your HTML file.',
          ),
        );
        break;
      case 'crashed':
        add(
          errors,
          gsError('GAME_CRASHED', `The game process crashed (${e.reason}).`, 'Run `npx gameshipper play` to watch it; the events log shows the last messages before the crash.'),
        );
        break;
      case 'blocked-navigation':
        // A web, mail or Steam link the game opened in the player's browser or app is working as intended:
        // only the events log keeps it.
        if (e.action === 'opened-externally') break;
        add(
          warnings,
          gsError(
            'GAME_NAVIGATION_BLOCKED',
            `The game tried to leave its window for ${e.url} (blocked).`,
            "The game window only shows the game's own pages. Web, mailto: and steam: links the game itself opens go to the player's browser or app; other URLs, and links from embedded sites, are blocked. While the page has an embedded frame from another site, or one that failed to load, even the game's own window.open() and target=\"_blank\" links are blocked: Electron can't tell which frame opened a window.",
          ),
        );
        break;
      case 'steam':
        switch (e.state) {
          case 'not-running':
            add(
              warnings,
              gsError(
                'STEAM_NOT_RUNNING',
                `Steam isn't running, so Steam features were off in this run (App ID ${e.appId}).`,
                'Start Steam and sign in, then run again. The game still works without Steam: window.steam.isAvailable() resolves false.',
              ),
            );
            break;
          case 'init-failed':
            add(
              errors,
              gsError(
                'STEAM_INIT_FAILED',
                `Steam is running but didn't start for App ID ${e.appId}: ${e.message ?? 'no reason given'}`,
                `Check that the signed-in Steam account owns App ID ${e.appId} (Valve's test app 480 works for everyone) and that steam.appId in gameshipper.json is right. If the message says the Steam bridge couldn't load, the build's Steam files are missing or broken: build again (and report it if that keeps happening). The events log has Steam's own messages.`,
              ),
            );
            break;
          // Not problems: a build without the SDK already carries a STEAM_SDK_MISSING warning from build or play,
          // and a restarting game is being relaunched by Steam.
          case 'ready':
          case 'no-sdk':
          case 'restarting':
            break;
          default:
            unhandledState(e.state);
        }
        break;
      case 'steam-overlay':
        // Whether Steam hooked the game only goes to the events log: Steam hooks its overlay only into games it
        // launched. A helper that couldn't start means no overlay even then.
        if (e.reason) {
          add(
            warnings,
            gsError(
              'STEAM_OVERLAY_FAILED',
              `Steam's overlay (Shift+Tab) couldn't be set up: ${e.reason}`,
              'The game runs without the overlay. Try steam.overlay "repaint" in gameshipper.json (or "off" to stop trying); the run log has steamworks-ffi-node\'s own messages.',
            ),
          );
        }
        break;
      case 'plugin-error':
        add(errors, gsError('PLUGIN_LOAD_FAILED', `Plugin ${e.plugin} failed to load in the game: ${e.message}`, 'Fix the plugin, then run `npx gameshipper play --smoke` again.'));
        break;
      case 'blocked-request':
        // Only `check` blocks the network. Its offline.requests check reads every one from the events log; the
        // http(s) ones also arrive as remote-request events (failed with net::ERR_BLOCKED_BY_CLIENT).
        break;
      case 'screenshot':
        // A saved screenshot is a result, not a problem: `play` lists them from the events log.
        break;
      case 'window-closed':
        // A game may quit by itself; `check` reads this event to report how long the game really ran.
        break;
      case 'screenshot-failed':
        add(warnings, gsError('SCREENSHOT_FAILED', `A screenshot couldn't be saved: ${e.error}`, 'Try again. If it keeps failing, run with --verbose and report the run log.'));
        break;
      default:
        // A summary from a newer shell may hold kinds this version doesn't know; they're skipped.
        unhandled(e);
    }
  }
  for (const [code, { list, more }] of perCode) {
    if (!more) continue;
    const where = opts.eventsLog ? `Every one is listed in ${opts.eventsLog}.` : 'Every one is listed in the events log.';
    // Right after the last issue with this code, so the count reads as part of that group.
    const last = list.findLastIndex((i) => i.code === code);
    list.splice(last + 1, 0, gsError(code, `…and ${more} more like this (see the events log)`, where));
  }
  return { errors, warnings };
}

/** Keeps the first MAX_SUMMARY_EVENTS events, with long texts cut; the rest are only counted. */
export function truncateSummary(summary: DiagSummary): SmokeSummary {
  return {
    events: summary.events.slice(0, MAX_SUMMARY_EVENTS).map(capEvent),
    droppedInfo: summary.droppedInfo,
    truncatedEvents: Math.max(0, summary.events.length - MAX_SUMMARY_EVENTS),
    // A `check` run's measurements; the shell keeps them small (probe.ts cleanLayout).
    ...(summary.probe ? { probe: summary.probe } : {}),
  };
}

export interface LaunchOptions {
  env: NodeJS.ProcessEnv;
  /** Stop the game, and everything it started, after this many milliseconds. */
  timeoutMs?: number;
  /**
   * When Gameshipper is stopped (Ctrl+C), ask the game to quit and give it this long to finish (saves in
   * flight) before stopping its tree. Without it, the tree is stopped at once, as smoke runs want.
   */
  quitGraceMs?: number;
  /** Called with each notice the shell prints for the person playing (capture.ts noticeLine). */
  onNotice?: (message: string) => void;
}

export interface LaunchResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Gameshipper stopped the game because it ran past `timeoutMs`. */
  timedOut: boolean;
  /** The last lines the game printed (stdout and stderr), for error messages. */
  outputTail: string;
}

/**
 * Runs a game until it exits, logging its output to the run log. On POSIX the game leads its own
 * process group, so it and its helper processes (Electron's GPU and renderer processes) are stopped
 * together: on timeout, when Gameshipper stops, or when helpers outlive the game.
 * Rejects with LAUNCH_FAILED when the game can't start.
 */
export function launch(ctx: Ctx, command: string, args: string[], opts: LaunchOptions): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let output = '';
    const onData = (text: string): void => {
      ctx.log(`[game] ${text.trimEnd()}`);
      output = (output + text).slice(-OUTPUT_BUFFER_CHARS);
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    if (opts.onNotice) {
      // Each stream on its own, so a line split across chunks is put back together.
      child.stdout.on('data', noticesIn(opts.onNotice));
      child.stderr.on('data', noticesIn(opts.onNotice));
    }
    const detach = stopWithGameshipper(child, { quitGraceMs: opts.quitGraceMs });

    let settled = false;
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    let graceTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      detach();
      if (!error) {
        resolve({ exitCode: exit.code, signal: exit.signal, timedOut, outputTail: outputTail(output) });
        return;
      }
      reject(
        new GsFailure('LAUNCH_FAILED', `Couldn't start ${command}: ${error.message}`, 'Reinstall Gameshipper (e.g. `npx gameshipper@latest`), or check the build exists.'),
      );
    };
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            ctx.log(`game still running after ${formatSeconds(opts.timeoutMs ?? 0)}; stopping it`);
            stop();
            settle();
          }, opts.timeoutMs);
    child.on('error', (e) => {
      // Also emitted when a kill fails; only a game that never started is a launch failure.
      if (child.pid === undefined) settle(e);
      else ctx.log(`game process error: ${e.message}`);
    });
    // A helper process can keep the game's output open (and 'close' from firing) after the game exits.
    child.on('exit', (code, signal) => {
      // After a timeout the run has already settled; the kill's own exit needs no grace period.
      if (settled) return;
      ctx.log(signal ? `game stopped by ${signal}` : `game exited with code ${code}`);
      exit = { code, signal };
      graceTimer = setTimeout(() => {
        releaseAfterExit(child);
        settle();
      }, CLOSE_GRACE_MS);
    });
    child.on('close', () => settle());
  });
}

export function gameEnv(eventsLog: string, userDataDir: string, windowed: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GAMESHIPPER_LOG: eventsLog, GAMESHIPPER_USER_DATA: userDataDir, GAMESHIPPER_WINDOWED: windowed ? '1' : '' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GAMESHIPPER_SMOKE_SECONDS;
  delete env.GAMESHIPPER_SMOKE_OUT;
  // Capture settings only ever come from the command that runs the game (captureEnv), never from the environment.
  for (const name of CAPTURE_ENV_NAMES) delete env[name];
  return env;
}

/** A file-name-safe timestamp, e.g. 2026-09-29T15-50-38-836Z. */
const fileStamp = (now: Date): string => now.toISOString().replace(/[:.]/g, '-');

/** How many events logs, and how many smoke summaries, .gameshipper/logs keeps: the newest ones. */
export const KEPT_RUN_FILES = 20;
const RUN_FILES = [/^events-.+\.jsonl$/, /^smoke-.+\.json$/];

/** Deletes all but the newest `keep` of each kind of run file in `logs`. Their names sort by time. */
function pruneRunFiles(logs: string, keep: number): void {
  const names = fs.readdirSync(logs).sort();
  for (const kind of RUN_FILES) {
    const old = names.filter((n) => kind.test(n)).slice(0, -keep);
    for (const name of old) {
      try {
        fs.rmSync(path.join(logs, name), { force: true });
      } catch {
        // Still open somewhere (Windows); the next run tries again.
      }
    }
  }
}

/**
 * Creates this run's (empty) events log and returns its path, so the path in a result always exists.
 * First deletes the oldest events logs and smoke summaries, leaving room for this run's within KEPT_RUN_FILES.
 */
export function eventsLogPath(projectDir: string, now: Date = new Date()): string {
  const logs = path.join(projectDir, '.gameshipper', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  pruneRunFiles(logs, KEPT_RUN_FILES - 1);
  const file = path.join(logs, `events-${fileStamp(now)}.jsonl`);
  fs.writeFileSync(file, '', { flag: 'a' });
  return file;
}

/** The summary the shell wrote, 'missing', or 'unreadable' (e.g. cut off mid-write). */
function readSummary(file: string): DiagSummary | 'missing' | 'unreadable' {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    const parsed = JSON.parse(text) as Partial<DiagSummary> | null;
    if (parsed && Array.isArray(parsed.events)) {
      const summary: DiagSummary = { events: parsed.events, droppedInfo: parsed.droppedInfo ?? 0 };
      if (parsed.probe && typeof parsed.probe === 'object') summary.probe = parsed.probe;
      return summary;
    }
  } catch {
    // fall through
  }
  return 'unreadable';
}

export async function runSmoke(ctx: Ctx, opts: SmokeOptions): Promise<Result<SmokeData>> {
  const started = new Date();
  const eventsLog = eventsLogPath(ctx.projectDir, started);
  // Each run gets its own summary next to its events log, so runs never read each other's.
  const outFile = path.join(path.dirname(eventsLog), `smoke-${fileStamp(started)}.json`);
  const extra = Object.entries(opts.env ?? {}).filter(([name]) => !name.startsWith('GAMESHIPPER_') && name !== 'ELECTRON_RUN_AS_NODE');
  const env = {
    ...gameEnv(eventsLog, opts.userDataDir, opts.windowed),
    ...Object.fromEntries(extra),
    GAMESHIPPER_SMOKE_SECONDS: String(opts.seconds),
    GAMESHIPPER_SMOKE_OUT: outFile,
    ...captureEnv(opts.capture ?? {}),
  };
  const timeoutMs = opts.timeoutMs ?? (opts.seconds + SMOKE_TIMEOUT_GRACE_SECONDS) * 1000;
  ctx.log(`smoke run: ${opts.command} ${opts.args.join(' ')} for ${opts.seconds}s`);
  const run = await launch(ctx, opts.command, opts.args, { env, timeoutMs });

  const details = `Details: ${eventsLog} and ${ctx.logPath}.`;
  const timeout = run.timedOut
    ? [
        gsError(
          'SMOKE_TIMEOUT',
          `The game was still running ${formatSeconds(timeoutMs)} after it started, so Gameshipper stopped it.`,
          `The game froze or didn't close when the smoke test ended. Run \`npx gameshipper play\` to watch it. ${details}`,
        ),
      ]
    : [];
  const summary = readSummary(outFile);
  if (typeof summary === 'string') {
    const ended = run.timedOut
      ? `it was stopped after ${formatSeconds(timeoutMs)}`
      : run.signal
        ? `it was stopped by ${run.signal}`
        : `exit code ${run.exitCode}`;
    const message =
      summary === 'missing' ? `The game didn't report back (${ended}).` : `The game's report ${outFile} couldn't be read (${ended}).`;
    return fail([gsError('SMOKE_NO_RESULT', message, `Run \`npx gameshipper play\` to watch it start. ${details}`), ...timeout]);
  }
  const { errors, warnings } = summaryToIssues(summary, { seconds: opts.seconds, eventsLog, storeArt: opts.storeArt });
  const all = [...errors, ...timeout];
  const data: SmokeData = { summary: truncateSummary(summary), eventsLog, exitCode: run.exitCode };
  return all.length ? fail(all, warnings, data) : ok(data, warnings);
}

/**
 * Every event of the given kinds in an events log (JSON lines), in order. A smoke result's summary keeps only the
 * first MAX_SUMMARY_EVENTS events; the log has them all. Lines that aren't JSON (a run cut short mid-write) are
 * skipped, and so is a log that can't be read.
 */
export function readLoggedEvents<K extends DiagEvent['kind']>(eventsLog: string, kinds: readonly K[]): Array<Extract<DiagEvent, { kind: K }>> {
  return loggedEvents(eventsLog, kinds) ?? [];
}

/** Like readLoggedEvents, but null when the events log can't be read. */
export function loggedEvents<K extends DiagEvent['kind']>(eventsLog: string, kinds: readonly K[]): Array<Extract<DiagEvent, { kind: K }>> | null {
  let text: string;
  try {
    text = fs.readFileSync(eventsLog, 'utf8');
  } catch {
    return null;
  }
  const wanted = new Set<string>(kinds);
  const found: Array<Extract<DiagEvent, { kind: K }>> = [];
  for (const line of text.split('\n')) {
    // Most lines are console messages: only parse lines that can be one of the wanted kinds.
    if (!kinds.some((kind) => line.includes(`"kind":"${kind}"`))) continue;
    try {
      const event = JSON.parse(line) as DiagEvent;
      if (wanted.has(event.kind)) found.push(event as Extract<DiagEvent, { kind: K }>);
    } catch {
      // A line cut short when the game stopped.
    }
  }
  return found;
}
