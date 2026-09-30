/** The most reasons a failure quotes from SteamCMD or butler: enough to act on, few enough for an agent to read. */
export const MAX_REASONS = 10;
/** The most of each reason quoted. The run log has the tool's whole output. */
export const MAX_REASON_CHARS = 300;

/**
 * A tool's reasons, bounded: each one's first line, cut to MAX_REASON_CHARS (then "…"), at most `max` of them, then
 * "…and N more" when there were more.
 */
export function boundedReasons(reasons: string[], max = MAX_REASONS): string[] {
  const short = (reason: string) => {
    const line = reason.trim().split(/\r?\n|\r/)[0].trim();
    return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS)}…` : line;
  };
  const shown = reasons.slice(0, max).map(short);
  return reasons.length > max ? [...shown, `…and ${reasons.length - max} more`] : shown;
}
