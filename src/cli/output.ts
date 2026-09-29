import type { GsError, Result } from '../core/result.js';

/**
 * Codes that mean "fix your input or config" rather than "something failed while working" (exit 2).
 * Everything else, including a game that quit or misbehaved (GAME_*), is exit 1.
 */
const USAGE_CODES = new Set([
  'USAGE',
  'INPUT_REQUIRED',
  'DIR_MISSING',
  'CONFIG_MISSING',
  'CONFIG_INVALID',
  'CONFIG_EXISTS',
  'ENTRY_MISSING',
  'ASSET_MISSING',
  'TARGET_NOT_CONFIGURED',
  'LOCK_INVALID',
  'CDN_NOT_LOCKED',
  // An error only under --frozen-lock (otherwise a warning).
  'CDN_CHANGED',
  'BUNDLE_ID_REQUIRED',
  'ICON_TOO_SMALL',
  'ICON_INVALID',
  'GAME_DIR_MISSING',
  'GAME_DIR_INVALID',
]);

export function exitCodeFor(result: Result<unknown>): number {
  if (result.ok) return 0;
  return result.errors.some((e) => USAGE_CODES.has(e.code)) ? 2 : 1;
}

function formatIssue(symbol: string, issue: GsError): string {
  return `${symbol} ${issue.code}: ${issue.message}${issue.fix ? `\n    → ${issue.fix}` : ''}`;
}

export function renderHuman(result: Result<unknown>, summary: string[]): string {
  const lines = [...summary];
  for (const e of result.errors) lines.push(formatIssue('✗', e));
  for (const w of result.warnings) lines.push(formatIssue('!', w));
  if (result.logPath) lines.push(`Log: ${result.logPath}`);
  return lines.join('\n');
}

export function renderJson(result: Result<unknown>): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
