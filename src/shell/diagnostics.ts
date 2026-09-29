// Imported by core (src/core/smoke.ts) as well as the shell: it must never import `electron`, which
// would load Electron into the CLI. Keep it to Node built-ins.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProbeReport } from './probe.js';

export type ConsoleLevel = 'info' | 'warning' | 'error' | 'debug';
/** How Steam started in this run (see shell/steam.ts). */
export type SteamState = 'ready' | 'not-running' | 'init-failed' | 'no-sdk' | 'restarting';
/** How the Steam overlay gets frames to draw on in this run (see shell/overlay.ts). */
export type OverlayMode = 'native' | 'repaint' | 'none';

export type DiagEvent =
  | { kind: 'console'; level: ConsoleLevel; message: string; source: string; line: number }
  | { kind: 'missing-file'; url: string }
  | { kind: 'case-mismatch'; url: string; actual: string }
  | { kind: 'remote-request'; url: string; status: number | null; error: string | null }
  | { kind: 'load-failed'; url: string; code: number; description: string }
  | { kind: 'crashed'; reason: string }
  /**
   * The game tried to leave its window. `action` is what normal play does with the URL:
   * open it in the system's browser, mail app or Steam, or just block it. Smoke runs never
   * open anything; they only record the attempt.
   */
  | { kind: 'blocked-navigation'; url: string; action: 'opened-externally' | 'blocked' }
  | { kind: 'steam'; state: SteamState; appId: number; overlay: OverlayMode; message: string | null }
  /**
   * Recorded when a smoke run ends: whether Steam says its overlay hooked the game. With a `reason` (and
   * enabled false), recorded as soon as the overlay helper (steam.overlay "native") couldn't start.
   */
  | { kind: 'steam-overlay'; enabled: boolean; reason?: string }
  /** A plugin's module failed to load in the game's main process. */
  | { kind: 'plugin-error'; plugin: string; message: string }
  /** `check` blocked a request that wasn't for the game's own files (capture.ts isAllowedOffline). */
  | { kind: 'blocked-request'; url: string }
  /** F12 or `play --screenshot` saved a store screenshot. */
  | { kind: 'screenshot'; file: string; width: number; height: number }
  | { kind: 'screenshot-failed'; error: string };

export interface DiagSummary {
  events: DiagEvent[];
  /** info/debug console messages beyond MAX_INFO_EVENTS (still in the JSONL log). */
  droppedInfo: number;
  /** What a `check` run measured at its end (capture.ts probeDir). */
  probe?: ProbeReport;
}

export interface Diagnostics {
  record(event: DiagEvent): void;
  summary(): DiagSummary;
}

export const MAX_INFO_EVENTS = 200;

/** A smoke run whose page hasn't loaded this many seconds past its duration ends with a load-failed event. */
export const LOAD_BACKSTOP_EXTRA_SECONDS = 30;
/** The load-failed `description` for that backstop; the smoke runner (core/smoke.ts) recognises it. */
export const LOAD_TIMEOUT_DESCRIPTION = 'The page never finished loading (timed out)';

export function createDiagnostics(logFile: string | null): Diagnostics {
  const events: DiagEvent[] = [];
  let infoCount = 0;
  let droppedInfo = 0;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {
      // Logging must never crash the game; appends below will fail quietly too.
    }
  }
  return {
    record(event) {
      if (logFile) {
        try {
          fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
        } catch {
          // Logging must never crash the game.
        }
      }
      const chatty = event.kind === 'console' && (event.level === 'info' || event.level === 'debug');
      if (chatty && ++infoCount > MAX_INFO_EVENTS) {
        droppedInfo++;
        return;
      }
      events.push(event);
    },
    summary() {
      return { events: [...events], droppedInfo };
    },
  };
}

/** Writes a smoke-run summary, creating its folder first. */
export function writeSummary(file: string, summary: DiagSummary): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
}

/** The `crashed` reason for an error thrown in the main process. Never throws itself. */
export function mainProcessErrorReason(error: unknown): string {
  try {
    return `main process error: ${error instanceof Error ? error.message : String(error)}`;
  } catch {
    return 'main process error (unprintable value)';
  }
}
