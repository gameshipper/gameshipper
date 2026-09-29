import type { DesktopTarget } from '../config/schema.js';
import { gsError, type GsError } from '../result.js';

/** pass/warn/fail as in spec §9; info = a reminder only; skip = couldn't run here (the message says why). */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'skip';
export type CheckGroup = 'offline' | 'launch' | 'deck' | 'review' | 'store' | 'ai';

interface CheckBase {
  /** Stable id such as "offline.requests". Part of the JSON contract: never rename. */
  id: string;
  group: CheckGroup;
  title: string;
  message: string;
  /** Specifics: URLs, files, elements. At most MAX_DETAILS, then one line counting the rest. */
  details?: string[];
}

/** warn and fail always carry a stable code and a fix; the other statuses may carry a fix as advice. */
export type CheckResult =
  | (CheckBase & { status: 'warn' | 'fail'; code: string; fix: string })
  | (CheckBase & { status: 'pass' | 'info' | 'skip'; code?: undefined; fix?: string });

export interface LaunchInfo {
  target: DesktopTarget;
  executable: string;
  seconds: number;
  /** null when the game was stopped by a signal. */
  exitCode: number | null;
  eventsLog: string | null;
}

export interface CheckReport {
  /** The desktop target matching this computer, or null on other OSes. */
  host: DesktopTarget | null;
  /** The build that was launched, or null if none could be. */
  launched: LaunchInfo | null;
  checks: CheckResult[];
  counts: Record<CheckStatus, number>;
  /** The game's last frame at Steam Deck size (1280x800), for a person or an agent to look at. */
  deckScreenshot: string | null;
  /** This report as JSON: .gameshipper/check/report.json */
  reportFile: string;
}

/** Keeps a check's `details` short enough for an agent to read. */
export const MAX_DETAILS = 10;
const MAX_DETAIL_CHARS = 500;

/** At most MAX_DETAILS lines of at most MAX_DETAIL_CHARS, then one line counting the rest. */
export function capDetails(lines: string[]): string[] {
  const shown = lines.slice(0, MAX_DETAILS).map((l) => (l.length > MAX_DETAIL_CHARS ? `${l.slice(0, MAX_DETAIL_CHARS)}…` : l));
  return lines.length > MAX_DETAILS ? [...shown, `…and ${lines.length - MAX_DETAILS} more`] : shown;
}

export function countStatuses(checks: CheckResult[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, info: 0, skip: 0 };
  for (const c of checks) counts[c.status]++;
  return counts;
}

/** The errors (fail) or warnings (warn) an agent sees in the Result: one per check, with its code and fix. */
export function checkIssues(checks: CheckResult[], status: 'warn' | 'fail'): GsError[] {
  return checks.flatMap((c) => ((c.status === 'warn' || c.status === 'fail') && c.status === status ? [gsError(c.code, c.message, c.fix)] : []));
}
