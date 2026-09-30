import * as path from 'node:path';
import type { Ctx } from '../../context.js';
import { GsFailure } from '../../result.js';
import { installArchive, isInstalled, type ToolArchive } from '../../tools/download.js';
import { toolCommand, withoutSecrets, type ToolCommand } from '../../tools/run.js';

/** The pinned butler release; itch.io's broth service keeps every version. Re-checked 2026-09-29 (still the latest). */
export const BUTLER_VERSION = '15.31.0';

const broth = (channel: string) => `https://broth.itch.zone/butler/${channel}/${BUTLER_VERSION}/archive/default`;

/**
 * Keyed by `${process.platform}-${process.arch}`. To move to a newer butler, download each channel's archive/default
 * for that version, hash it, and change all five together.
 */
export const BUTLER_ARCHIVES: Record<string, ToolArchive> = {
  'darwin-arm64': { url: broth('darwin-arm64'), sha256: '5a5fcd3dc83de480748223388d9b5d6eab8df786bedb5d6730ffe59df87b2c5b', format: 'zip' },
  'darwin-x64': { url: broth('darwin-amd64'), sha256: '70a4b8543fddee7031052ea76f1846ba071913148e20cf7a2f18421702fc1929', format: 'zip' },
  'linux-x64': { url: broth('linux-amd64'), sha256: '4f2a3f22b12f870923504d4b6935535cad377b45859f5fe9419e3adc0611a48c', format: 'zip' },
  'linux-arm64': { url: broth('linux-arm64'), sha256: '2ffd4071dfa715024eedd2b4ac7406c1c7802452214d89a48496adb9c171b737', format: 'zip' },
  'win32-x64': { url: broth('windows-amd64'), sha256: '92e42f011db049128583ac88258d3309d00c69018d2a48b378c7eb5709d9efde', format: 'zip' },
};

export function butlerPaths(cacheDir: string, platform: NodeJS.Platform, arch: string): { installDir: string; program: string } {
  return {
    installDir: path.join(cacheDir, 'tools', 'butler', `${BUTLER_VERSION}-${platform}-${arch}`),
    program: platform === 'win32' ? 'butler.exe' : 'butler',
  };
}

export interface EnsureButlerOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replaces the pinned archive (tests). */
  archive?: ToolArchive;
}

/**
 * How to run butler, downloading it into the cache on first use. butler keeps its login where it always does
 * (~/Library/Application Support/itch/butler_creds on macOS, ~/.config/itch/butler_creds elsewhere) or reads
 * BUTLER_API_KEY, so an existing `butler login` is reused. It never gets the GitHub token or the Apple signing
 * variables. GAMESHIPPER_BUTLER=<path> runs that program instead.
 */
export async function ensureButler(ctx: Ctx, opts: EnsureButlerOptions): Promise<ToolCommand> {
  const env = withoutSecrets(opts.env, ['BUTLER_API_KEY']);
  const override = opts.env.GAMESHIPPER_BUTLER;
  if (override) return toolCommand(override, env);
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const archive = opts.archive ?? BUTLER_ARCHIVES[`${platform}-${arch}`];
  if (!archive) {
    throw new GsFailure('TOOL_UNSUPPORTED_HOST', `itch.io doesn't make butler for ${platform}/${arch}.`, 'Upload to itch.io from Windows (x64), macOS, or Linux (x64 or arm64).');
  }
  const { installDir, program } = butlerPaths(ctx.cacheDir, platform, arch);
  if (!isInstalled(installDir, archive, program)) await installArchive(ctx, 'butler', archive, installDir, program);
  return toolCommand(path.join(installDir, program), env);
}

/** One line of `butler --json` output. */
export interface ButlerMessage {
  type: string;
  level?: string;
  message?: string;
  value?: Record<string, unknown>;
}

/** butler's JSON lines, skipping anything else it printed (its "bailing out" text, a stack trace). */
export function parseButlerJson(output: string): ButlerMessage[] {
  const messages: ButlerMessage[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const m = JSON.parse(line) as ButlerMessage;
      if (typeof m.type === 'string') messages.push(m);
    } catch {
      // not one of its JSON lines
    }
  }
  return messages;
}

/** The `result` butler printed, if any. */
export function butlerResult(messages: ButlerMessage[]): Record<string, unknown> | null {
  return messages.find((m) => m.type === 'result')?.value ?? null;
}

/**
 * butler's errors when it couldn't reach itch.io, or itch.io failed itself: logging in again wouldn't fix them. Seen
 * from butler 15.31.0 on 2026-09-29, with itch.io's address pointed at a closed port, an unknown host, a server that
 * hung up, one that never answered (or answered 503, which butler retries until it gives up) and one that answered 500:
 *   Get "https://api.itch.io/wharf/status": dial tcp 127.0.0.1:1: connect: connection refused
 *   Get "http://api.x.invalid/wharf/status": dial tcp: lookup api.x.invalid: no such host
 *   Get "…": EOF
 *   Get "…": context deadline exceeded
 *   itch.io API error (500): /wharf/status: internal error
 * plus Go's other network errors (i/o timeout, TLS handshake timeout, connection reset by peer).
 */
const UNREACHABLE =
  /dial tcp|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|TLS handshake|context deadline exceeded|Client\.Timeout|\bEOF\b|API error \(5\d\d\)|\bHTTP 5\d\d\b|\b503\b|Service Unavailable|Bad Gateway/i;

/** True when butler's error says itch.io couldn't be reached or failed itself, rather than refusing the login. */
export function butlerUnreachable(reason: string): boolean {
  return UNREACHABLE.test(reason);
}

/** The first line of each error butler printed (the rest is a Go stack trace), or its last log line if none. */
export function butlerErrors(messages: ButlerMessage[]): string[] {
  const first = (m: ButlerMessage) => (m.message ?? '').split('\n')[0].trim();
  const errors = messages.filter((m) => m.type === 'error' && m.message).map(first);
  if (errors.length) return errors;
  const last = [...messages].reverse().find((m) => m.type === 'log' && m.message);
  return last ? [first(last)] : [];
}
