import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A fake `xcrun` that answers `notarytool` and `stapler` like Apple's tools and passes every
 * other call to the real /usr/bin/xcrun. Put its folder first on PATH.
 * Behaviour comes from environment variables read at call time:
 *   FAKE_NOTARY_RESULT=Accepted|Invalid|AuthError (AuthError: notarytool's plain-text answer to a bad login)
 *   FAKE_STAPLE_FAIL=1 (every staple fails)   FAKE_STAPLE_FAILURES=<n> (the first n staples fail)
 *   FAKE_XCRUN_LOG=<file to append argv to>
 */
export const FAKE_XCRUN = `#!/bin/sh
printf '%s\\n' "$*" >> "\${FAKE_XCRUN_LOG:-/dev/null}"
case "$1" in
  --find)
    if [ "$2" = "notarytool" ]; then echo "/fake/notarytool"; exit 0; fi ;;
  notarytool)
    case "$2" in
      submit)
        if [ "$FAKE_NOTARY_RESULT" = "AuthError" ]; then
          echo 'Conducting pre-submission checks for Mini.zip and initiating connection to the Apple notary service...' >&2
          echo 'Error: HTTP status code: 401. Unable to authenticate. Invalid Session.' >&2; exit 69
        fi
        if [ "\${FAKE_NOTARY_RESULT:-Accepted}" = "Accepted" ]; then
          echo '{"id":"fake-submission-1","status":"Accepted","message":"Processing complete"}'; exit 0
        fi
        echo '{"id":"fake-submission-1","status":"Invalid","message":"Processing complete"}'; exit 1 ;;
      log)
        echo '{"jobId":"fake-submission-1","issues":[{"severity":"error","message":"The signature does not include a secure timestamp."}]}'; exit 0 ;;
    esac ;;
  stapler)
    if [ -n "$FAKE_STAPLE_FAILURES" ]; then
      n=$(cat "$FAKE_XCRUN_LOG.staples" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_XCRUN_LOG.staples"
      if [ "$n" -le "$FAKE_STAPLE_FAILURES" ]; then echo 'CloudKit query failed due to "Record not found".'; exit 65; fi
    fi
    if [ "$FAKE_STAPLE_FAIL" = "1" ]; then echo 'CloudKit query failed due to "Record not found".'; exit 65; fi
    echo "The staple and validate action worked!"; exit 0 ;;
esac
exec /usr/bin/xcrun "$@"
`;

export function installFakeXcrun(dir: string): { binDir: string; logFile: string } {
  const binDir = path.join(dir, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'xcrun'), FAKE_XCRUN, { mode: 0o755 });
  return { binDir, logFile: path.join(dir, 'xcrun-calls.log') };
}

/** Runs fn with extra environment variables set, restoring the old values afterwards. */
export async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
