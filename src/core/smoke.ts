import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOAD_BACKSTOP_EXTRA_SECONDS, LOAD_TIMEOUT_DESCRIPTION, type DiagSummary } from '../shell/diagnostics.js';
import type { Ctx } from './context.js';
import { killTree, OUTPUT_BUFFER_CHARS, outputTail, releaseAfterExit, stopWithGameshipper } from './proc.js';
import { fail, GsFailure, gsError, ok, type GsError, type Result } from './result.js';

/** Per code, how many issues a smoke run lists before one more issue counts the rest. */
export const MAX_ISSUES_PER_CODE = 10;
/** How many diagnostic events a smoke result carries; the events log keeps every one. */
export const MAX_SUMMARY_EVENTS = 100;

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
}

/**
 * How long past the smoke duration a game may run before Gameshipper stops it. The shell ends a smoke
 * run itself by `seconds` + LOAD_BACKSTOP_EXTRA_SECONDS even when the page never loads, so this only
 * fires if the game hangs.
 */
export const SMOKE_TIMEOUT_GRACE_SECONDS = 45;
/** After the game exits, how long to wait for its helper processes to release its output. */
const CLOSE_GRACE_MS = 2000;

const IGNORED_MISSING = new Set(['favicon.ico']);
const shortUrl = (url: string) => url.replace(/^app:\/\/game\//, '');

function formatSeconds(ms: number): string {
  const n = Math.max(1, Math.round(ms / 1000));
  return `${n} second${n === 1 ? '' : 's'}`;
}

/** Compile-time check that every DiagEvent kind is handled. */
const unhandled = (_event: never): void => {};

/**
 * `seconds` is the smoke run's duration, used to say how long the page had to load. `eventsLog` is named in
 * the issue that counts what's left out: each code lists at most MAX_ISSUES_PER_CODE issues.
 */
export function summaryToIssues(
  summary: DiagSummary,
  opts: { seconds?: number; eventsLog?: string } = {},
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
  // The shell records a wrong-case request as both case-mismatch and missing-file (it 404s).
  const realName = new Map<string, string>();
  for (const e of summary.events) if (e.kind === 'case-mismatch') realName.set(e.url, e.actual);

  for (const e of summary.events) {
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
        add(
          warnings,
          gsError(
            'GAME_NAVIGATION_BLOCKED',
            `The game tried to leave its window for ${e.url} (${e.action === 'opened-externally' ? 'opens outside the game' : 'blocked'}).`,
            "Open external links with a normal link or window.open; they open in the player's browser. Navigating the game window itself isn't allowed.",
          ),
        );
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

/** Keeps the first MAX_SUMMARY_EVENTS events; the rest are only counted. */
export function truncateSummary(summary: DiagSummary): SmokeSummary {
  return {
    events: summary.events.slice(0, MAX_SUMMARY_EVENTS),
    droppedInfo: summary.droppedInfo,
    truncatedEvents: Math.max(0, summary.events.length - MAX_SUMMARY_EVENTS),
  };
}

export interface LaunchOptions {
  env: NodeJS.ProcessEnv;
  /** Stop the game, and everything it started, after this many milliseconds. */
  timeoutMs?: number;
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
    const detach = stopWithGameshipper(child);

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
        new GsFailure('LAUNCH_FAILED', `Couldn't start ${command}: ${error.message}`, 'Run `npm install` again so Electron downloads, or check the build exists.'),
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
  return env;
}

/** Creates this run's (empty) events log and returns its path, so the path in a result always exists. */
export function eventsLogPath(projectDir: string, now: Date = new Date()): string {
  const file = path.join(projectDir, '.gameshipper', 'logs', `events-${now.toISOString().replace(/[:.]/g, '-')}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
    if (parsed && Array.isArray(parsed.events)) return { events: parsed.events, droppedInfo: parsed.droppedInfo ?? 0 };
  } catch {
    // fall through
  }
  return 'unreadable';
}

export async function runSmoke(ctx: Ctx, opts: SmokeOptions): Promise<Result<SmokeData>> {
  const eventsLog = eventsLogPath(ctx.projectDir);
  const outFile = path.join(ctx.projectDir, '.gameshipper', 'smoke.json');
  fs.rmSync(outFile, { force: true });
  const env = { ...gameEnv(eventsLog, opts.userDataDir, opts.windowed), GAMESHIPPER_SMOKE_SECONDS: String(opts.seconds), GAMESHIPPER_SMOKE_OUT: outFile };
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
  const { errors, warnings } = summaryToIssues(summary, { seconds: opts.seconds, eventsLog });
  const all = [...errors, ...timeout];
  const data: SmokeData = { summary: truncateSummary(summary), eventsLog, exitCode: run.exitCode };
  return all.length ? fail(all, warnings, data) : ok(data, warnings);
}
