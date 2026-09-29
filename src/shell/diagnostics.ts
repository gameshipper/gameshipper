import * as fs from 'node:fs';
import * as path from 'node:path';

export type ConsoleLevel = 'info' | 'warning' | 'error' | 'debug';

export type DiagEvent =
  | { kind: 'console'; level: ConsoleLevel; message: string; source: string; line: number }
  | { kind: 'missing-file'; url: string }
  | { kind: 'case-mismatch'; url: string; actual: string }
  | { kind: 'remote-request'; url: string; status: number | null; error: string | null }
  | { kind: 'load-failed'; url: string; code: number; description: string }
  | { kind: 'crashed'; reason: string }
  | { kind: 'blocked-navigation'; url: string };

export interface DiagSummary {
  events: DiagEvent[];
  /** info/debug console messages beyond MAX_INFO_EVENTS (still in the JSONL log). */
  droppedInfo: number;
}

export interface Diagnostics {
  record(event: DiagEvent): void;
  summary(): DiagSummary;
}

export const MAX_INFO_EVENTS = 200;

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
