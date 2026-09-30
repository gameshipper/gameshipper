import { describe, expect, it } from 'vitest';
import { judgeSteamRun, type SteamRun } from '../../../src/core/publish/steam/judge.js';

// Captured from SteamCMD 1788292693 on macOS, 2026-09-29.
const BANNER = [
  '[  0%] Checking for available updates...',
  '[----] Verifying installation...',
  'Steam Console Client (c) Valve Corporation - version 1788292693',
  "-- type 'quit' to exit --",
  'Loading Steam API...OK',
  '"@ShutdownOnFailedCommand" = "1"',
  '"@NoPromptForPassword" = "1"',
].join('\n');

const NO_SESSION = `${BANNER}\nCached credentials not found.\nFAILED (No cached credentials and @NoPromptForPassword is set)\nUnloading Steam API...OK\n`;

const ACCESS_DENIED = `${BANNER}

Connecting anonymously to Steam Public...OK
Waiting for client config...OK
Waiting for user info...OK
[2026-09-29 00:05:57]: Starting AppID 480 build (flags 0x2).
[2026-09-29 00:05:57]: Building depot 482...

Building file mapping...
Scanning content
[2026-09-29 00:05:57]: ERROR! Failed to initialize build on server (Access Denied)

[2026-09-29 00:05:57]: ERROR! Build for depot 482 failed : Failure

Unloading Steam API...OK
`;

const LOGGED_IN = `${BANNER}\nLogging in using cached credentials.\nLogging in user 'builder' [U:1:0] to Steam Public...OK\nWaiting for client config...OK\nWaiting for user info...OK\n`;

const run = (output: string, extra: Partial<SteamRun> = {}): SteamRun => ({
  appId: 480,
  preview: false,
  exitCode: 0,
  timedOut: false,
  spawnError: null,
  output,
  ...extra,
});

describe('judgeSteamRun', () => {
  it('an upload reports its BuildID', () => {
    const out = `${LOGGED_IN}[2026-09-29 10:00:00]: Successfully finished AppID 480 build (BuildID 12345678).\n`;
    expect(judgeSteamRun(run(out))).toEqual({ kind: 'uploaded', buildId: 12345678, setLiveFailed: false });
  });

  it('a preview succeeds without a BuildID', () => {
    const out = `${LOGGED_IN}[2026-09-29 10:00:00]: Successfully finished AppID 480 build preview.\n`;
    expect(judgeSteamRun(run(out, { preview: true }))).toEqual({ kind: 'previewed' });
  });

  it("another app's success line doesn't count", () => {
    expect(judgeSteamRun(run(`${LOGGED_IN}Successfully finished AppID 4800 build (BuildID 1).\n`)).kind).toBe('failed');
  });

  it('a refused SetLive still means the build was uploaded', () => {
    const out = `${LOGGED_IN}Successfully finished AppID 480 build (BuildID 77).\nERROR! Failed to commit build for AppID 480 : Failure\n`;
    expect(judgeSteamRun(run(out, { exitCode: 6 }))).toEqual({ kind: 'uploaded', buildId: 77, setLiveFailed: true });
  });

  it('no saved login → login-required (real output)', () => {
    expect(judgeSteamRun(run(NO_SESSION, { exitCode: 5 }))).toEqual({ kind: 'login-required', reason: 'Cached credentials not found.' });
  });

  it('an expired or refused saved login → login-required', () => {
    const out = `${BANNER}\nLogging in user 'builder' [U:1:0] to Steam Public...FAILED (Expired Login Auth Code)\n`;
    expect(judgeSteamRun(run(out, { exitCode: 5 }))).toEqual({ kind: 'login-required', reason: 'Expired Login Auth Code' });
  });

  it('a password, Steam Guard or mobile-app prompt → login-required', () => {
    for (const prompt of ['password: ', 'Steam Guard code:', 'Please confirm the login in the Steam Mobile app on your phone.']) {
      expect(judgeSteamRun(run(`${BANNER}\n${prompt}`, { exitCode: null })).kind, prompt).toBe('login-required');
    }
  });

  it('no connection or a rate limit is a failure, not a login problem', () => {
    const out = `${BANNER}\nLogging in user 'builder' [U:1:0] to Steam Public...FAILED (No Connection)\n`;
    expect(judgeSteamRun(run(out, { exitCode: 5 }))).toEqual({ kind: 'failed', reasons: ['Steam login: No Connection'] });
    const limited = `${BANNER}\nLogging in user 'builder' [U:1:0] to Steam Public...FAILED (Rate Limit Exceeded)\n`;
    expect(judgeSteamRun(run(limited, { exitCode: 5 })).kind).toBe('failed');
  });

  it('collects each ERROR! reason once (real output)', () => {
    expect(judgeSteamRun(run(ACCESS_DENIED, { exitCode: 6, preview: true }))).toEqual({
      kind: 'failed',
      reasons: ['Failed to initialize build on server (Access Denied)', 'Build for depot 482 failed : Failure'],
    });
  });

  it('keeps the reasons short enough for an agent', () => {
    const noisy = Array.from({ length: 30 }, (_, i) => `ERROR! problem ${i} ${'x'.repeat(1000)}`).join('\n');
    const r = judgeSteamRun(run(noisy, { exitCode: 6 }));
    expect(r.kind === 'failed' && [r.reasons.length, r.reasons[0].length, r.reasons.at(-1)]).toEqual([11, 301, '…and 20 more']);
  });

  it('explains silent failures', () => {
    expect(judgeSteamRun(run(BANNER, { exitCode: 3 }))).toEqual({ kind: 'failed', reasons: ['SteamCMD exited with code 3 without saying why.'] });
    expect(judgeSteamRun(run(BANNER, { exitCode: null, timedOut: true }))).toEqual({ kind: 'failed', reasons: ["SteamCMD didn't finish in time and was stopped."] });
  });

  it('SteamCMD that cannot run on this computer', () => {
    expect(judgeSteamRun(run('./steamcmd.sh: line 37: /c/steamcmd: Bad CPU type in executable\n', { exitCode: 126 })).kind).toBe('cant-run');
    const libs = 'linux32/steamcmd: error while loading shared libraries: libstdc++.so.6: cannot open shared object file\n';
    expect(judgeSteamRun(run(libs, { exitCode: 127 })).kind).toBe('cant-run');
    expect(judgeSteamRun(run('', { exitCode: null, spawnError: 'spawn EACCES' }))).toEqual({ kind: 'cant-run', reason: 'spawn EACCES' });
  });
});
