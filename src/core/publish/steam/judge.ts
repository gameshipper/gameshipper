/**
 * Reads what SteamCMD printed; its exit code alone can't be trusted (a refused SetLive exits non-zero after a good
 * upload, and Windows' codes are unverified). Every pattern here was seen from SteamCMD 1788292693 on 2026-09-29
 * (runs on macOS) or in steamship's recorded logs of the same version:
 *   Successfully finished AppID 480 build preview.
 *   Successfully finished AppID 480 build (BuildID 12345678).
 *   Cached credentials not found.
 *   FAILED (No cached credentials and @NoPromptForPassword is set)
 *   Logging in user 'x' [U:1:0] to Steam Public...FAILED (Invalid Password)
 *   [2026-09-29 00:05:57]: ERROR! Failed to initialize build on server (Access Denied)
 *   ERROR! Failed to commit build ...   (SetLive refused; the build itself is uploaded)
 */

import { boundedReasons } from '../reasons.js';

export type SteamOutcome =
  | { kind: 'uploaded'; buildId: number; setLiveFailed: boolean }
  | { kind: 'previewed' }
  | { kind: 'login-required'; reason: string }
  | { kind: 'cant-run'; reason: string }
  | { kind: 'failed'; reasons: string[] };

export interface SteamRun {
  appId: number;
  preview: boolean;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
  /** What SteamCMD printed, then its app build log if there is one. */
  output: string;
}

/** What SteamCMD prints when it wants a person: a password, a Steam Guard code, or approval in the Steam app. */
export const STEAM_LOGIN_PROMPT = /password:|Steam Guard code:|Two-factor code:|confirm the login in the Steam Mobile app/i;
/** Refusals that logging in again wouldn't fix. */
const NOT_A_LOGIN_PROBLEM = /No Connection|Rate Limit Exceeded|Throttle|Service Unavailable|Timeout/i;
function refusal(line: string): string | null {
  return /(?:FAILED|ERROR) \(([^)]+)\)/.exec(line)?.[1] ?? null;
}

export function judgeSteamRun(run: SteamRun): SteamOutcome {
  if (run.spawnError) return { kind: 'cant-run', reason: run.spawnError };
  const lines = run.output.split(/\r?\n|\r/);
  const cantRun = lines.find((l) => /Bad CPU type in executable|error while loading shared libraries/i.test(l));
  if (cantRun) return { kind: 'cant-run', reason: cantRun.trim() };

  const finished = `Successfully finished AppID ${run.appId} build`;
  if (run.preview && lines.some((l) => l.includes(`${finished} preview.`))) return { kind: 'previewed' };
  const built = new RegExp(`${finished} \\(BuildID (\\d+)\\)`);
  const buildId = lines.map((l) => built.exec(l)?.[1]).find(Boolean);
  if (!run.preview && buildId && Number(buildId) > 0) {
    return { kind: 'uploaded', buildId: Number(buildId), setLiveFailed: lines.some((l) => l.includes('Failed to commit build')) };
  }

  for (const line of lines) {
    if (line.includes('Cached credentials not found')) return { kind: 'login-required', reason: line.trim() };
    const reason = refusal(line);
    if (reason && (line.includes('Logging in') || line.includes('No cached credentials')) && !NOT_A_LOGIN_PROBLEM.test(reason)) {
      return { kind: 'login-required', reason };
    }
    if (STEAM_LOGIN_PROMPT.test(line)) return { kind: 'login-required', reason: 'SteamCMD asked for a password, a Steam Guard code or approval in the Steam app.' };
  }

  const reasons: string[] = [];
  for (const line of lines) {
    const error = line.includes('ERROR!') ? line.slice(line.indexOf('ERROR!') + 'ERROR!'.length).trim() : null;
    const refused = refusal(line);
    const reason = error ?? (refused && line.includes('Logging in') ? `Steam login: ${refused}` : null);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }
  if (!reasons.length) {
    if (run.timedOut) reasons.push("SteamCMD didn't finish in time and was stopped.");
    else if (run.exitCode === 0) reasons.push("SteamCMD finished, but its output doesn't say the build succeeded.");
    else reasons.push(`SteamCMD exited with code ${run.exitCode} without saying why.`);
  }
  return { kind: 'failed', reasons: boundedReasons(reasons) };
}
