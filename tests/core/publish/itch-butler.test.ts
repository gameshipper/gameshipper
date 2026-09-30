import { describe, expect, it } from 'vitest';
import { BUTLER_ARCHIVES, butlerErrors, butlerResult, butlerPaths, ensureButler, parseButlerJson } from '../../../src/core/publish/itch/butler.js';
import { testCtx } from '../../helpers/ctx.js';
import { makeTmpDir } from '../../helpers/tmp.js';

// Captured from butler 15.31.0 with --json on 2026-09-29.
const DRY_RUN = [
  '{"level":"info","message":"\\u003e Dry run, listing files we would push...","time":1790734889,"type":"log"}',
  '{"level":"info","message":"-rw-r--r--        3 B game.txt","time":1790734889,"type":"log"}',
  '{"level":"info","message":"\\u003c Would push 3 B (1 files, 0 dirs, 0 symlinks)","time":1790734889,"type":"log"}',
  '{"time":1790734889,"type":"result","value":{"buildId":0,"channel":"linux","dryRun":true,"reason":"dry-run","skipped":false}}',
].join('\n');
const NO_CREDENTIALS = [
  '{"level":"info","message":"Please set BUTLER_API_KEY to your API key, see https://itch.io/docs/butler/login.html for more info.","time":1790734889,"type":"log"}',
  '{"message":"No credentials and stdin is not a terminal - terminating.","time":1790734889,"type":"error"}',
  'bailing out: No credentials and stdin is not a terminal - terminating.',
].join('\n');
// With BUTLER_API_KEY=not-a-real-key: the error carries a Go stack trace after its first line.
const INVALID_KEY = [
  '{"message":"itch.io API error (403): /wharf/status: invalid key\\ngithub.com/itchio/go-itchio.(*Client).GetResponse\\n\\t/Users/runner/go/pkg/mod/github.com/itchio/go-itchio/http_helpers.go:130\\nvalidating credentials","time":1790734889,"type":"error"}',
  'bailing out: itch.io API error (403): /wharf/status: invalid key',
  'github.com/itchio/go-itchio.(*Client).GetResponse',
].join('\n');

describe('butler output', () => {
  it('reads the result and the errors from its JSON lines', () => {
    expect(butlerResult(parseButlerJson(DRY_RUN))).toEqual({ buildId: 0, channel: 'linux', dryRun: true, reason: 'dry-run', skipped: false });
    const failed = parseButlerJson(NO_CREDENTIALS);
    expect(butlerResult(failed)).toBeNull();
    expect(butlerErrors(failed)).toEqual(['No credentials and stdin is not a terminal - terminating.']);
  });

  it("keeps only the first line of an error, not butler's stack trace", () => {
    expect(butlerErrors(parseButlerJson(INVALID_KEY))).toEqual(['itch.io API error (403): /wharf/status: invalid key']);
  });
});

describe('butler in the cache', () => {
  it('is pinned for every OS and CPU itch.io builds it for', () => {
    expect(Object.keys(BUTLER_ARCHIVES).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
    for (const a of Object.values(BUTLER_ARCHIVES)) {
      expect(a.url).toMatch(/^https:\/\/broth\.itch\.zone\/butler\/[a-z0-9-]+\/15\.31\.0\/archive\/default$/);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(butlerPaths('/c', 'win32', 'x64')).toEqual({ installDir: expect.stringContaining('15.31.0-win32-x64'), program: 'butler.exe' });
  });

  it('GAMESHIPPER_BUTLER runs another program instead', async () => {
    const tool = await ensureButler(testCtx(makeTmpDir()), { env: { GAMESHIPPER_BUTLER: '/fakes/butler.mjs' } });
    expect([tool.command, tool.args]).toEqual([process.execPath, ['/fakes/butler.mjs']]);
  });

  it("TOOL_UNSUPPORTED_HOST where itch.io doesn't make butler", async () => {
    await expect(ensureButler(testCtx(makeTmpDir()), { env: {}, platform: 'win32', arch: 'arm64' })).rejects.toMatchObject({
      error: { code: 'TOOL_UNSUPPORTED_HOST' },
    });
  });
});
