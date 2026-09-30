import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { GsFailure } from '../../result.js';

export interface GithubAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
}

export interface GithubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  html_url: string;
  /** e.g. https://uploads.github.com/repos/o/r/releases/1/assets{?name,label} */
  upload_url: string;
  assets: GithubAsset[];
}

export interface GithubClientOptions {
  /** https://api.github.com, or GAMESHIPPER_GITHUB_API (GitHub Enterprise, tests). */
  apiBase: string;
  token: string;
  /** owner/name */
  repo: string;
  userAgent: string;
  /** Gets one line per request: method, path and status. Never the token. */
  log: (line: string) => void;
}

/** Every call but an upload gets this long. */
const API_TIMEOUT_MS = 60_000;
/** The most of GitHub's reason a message quotes: an error page can be megabytes. */
const MAX_REASON_CHARS = 300;

/**
 * What to do about a missing or refused token. Agents do what a fix says, so it says the human makes the token and
 * sets it where Gameshipper runs: nobody pastes it into a chat, where an agent would see it.
 */
export function tokenFix(repo: string): string {
  return `The human creates a fine-grained token limited to ${repo} (Contents: Read and write) and sets GITHUB_TOKEN to it themselves where Gameshipper runs (their shell, or the MCP server's environment), never pasting it into a chat or a command line. Gameshipper doesn't use the gh CLI's login.`;
}

/** What GitHub said, short: its JSON message (and its first error), or else the first line of the body. */
function reasonFrom(text: string): string {
  let reason: string | undefined;
  try {
    const body = JSON.parse(text) as { message?: unknown; errors?: unknown } | null;
    if (typeof body?.message === 'string') {
      const first = (Array.isArray(body.errors) ? body.errors[0] : undefined) as { message?: unknown; code?: unknown } | undefined;
      const detail = typeof first?.message === 'string' ? first.message : typeof first?.code === 'string' ? first.code : undefined;
      reason = detail ? `${body.message}: ${detail}` : body.message;
    }
  } catch {
    // not JSON: an error page
  }
  reason ??= text.trim().split(/\r?\n/)[0] || 'no reason given';
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}

interface CallOptions {
  json?: unknown;
  /** A file to send as the body, streamed from disk. */
  file?: string;
  contentType?: string;
  allow404?: boolean;
}

/** The few GitHub REST calls releases need. Methods throw GsFailure with a fix. */
export class GithubClient {
  private readonly opts: GithubClientOptions;

  constructor(opts: GithubClientOptions) {
    this.opts = opts;
  }

  /** `text` with the token taken out (as it is, and as JSON would quote it), in case an error quotes it. */
  private redact(text: string): string {
    const token = this.opts.token;
    if (!token) return text;
    let out = text;
    for (const form of new Set([token, JSON.stringify(token).slice(1, -1)])) out = out.split(form).join('***');
    return out;
  }

  /** A GsFailure whose message never holds the token (a message quoting GitHub's reason already had it taken out). */
  private failure(code: string, message: string, fix: string): GsFailure {
    return new GsFailure(code, this.redact(message), fix);
  }

  private async call<T>(method: string, url: string, init: CallOptions = {}): Promise<T | null> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.opts.userAgent,
    };
    let body: string | ReadableStream | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.file) {
      headers['content-type'] = init.contentType ?? 'application/octet-stream';
      headers['content-length'] = String(fs.statSync(init.file).size);
      body = Readable.toWeb(fs.createReadStream(init.file)) as ReadableStream;
    }
    const where = new URL(url).pathname;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        // A stream body needs half duplex; an upload of a large game takes as long as it takes.
        ...(init.file ? { duplex: 'half' } : { signal: AbortSignal.timeout(API_TIMEOUT_MS) }),
      } as RequestInit);
    } catch (e) {
      const cause = (e as { cause?: { code?: unknown } }).cause;
      const code = typeof cause?.code === 'string' ? ` (${cause.code})` : '';
      throw this.failure('GITHUB_API_FAILED', `Couldn't reach GitHub (${method} ${where}): ${(e as Error).message}${code}.`, 'Check your internet connection, then publish again.');
    }
    this.opts.log(`github: ${method} ${where} → ${res.status}`);
    if (res.ok) return res.status === 204 ? null : ((await res.json()) as T);
    if (res.status === 404 && init.allow404) return null;
    // The token comes out of what GitHub sent before the reason is cut, so no part of it is left where the cut falls.
    const message = reasonFrom(this.redact(await res.text()));
    const repo = this.opts.repo;
    if (res.status === 401) throw this.failure('GITHUB_AUTH_FAILED', `GitHub refused the token (401: ${message}).`, tokenFix(repo));
    if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'))) {
      throw this.failure('GITHUB_API_FAILED', `GitHub's API rate limit is used up (${message}).`, 'Wait until it resets (an hour at most), then publish again.');
    }
    if (res.status === 403) throw this.failure('GITHUB_AUTH_FAILED', `The token isn't allowed to do this on ${repo} (403: ${message}).`, tokenFix(repo));
    if (res.status === 404) {
      throw this.failure(
        'GITHUB_REPO_NOT_FOUND',
        `GitHub can't find ${repo}, or the token can't see it.`,
        'Check github.repo in gameshipper.json (or --repo): it must be the owner/name of a repository that exists and that the token can access.',
      );
    }
    throw this.failure('GITHUB_API_FAILED', `GitHub ${method} ${where} failed (HTTP ${res.status}: ${message}).`, 'Publish again in a minute. If it keeps failing, check https://www.githubstatus.com.');
  }

  private api(path: string): string {
    return `${this.opts.apiBase.replace(/\/$/, '')}/repos/${this.opts.repo}${path}`;
  }

  /** Fails early when the repository is missing or the token can't write to it. */
  async checkRepo(): Promise<void> {
    const repo = await this.call<{ permissions?: { push?: boolean } }>('GET', this.api(''));
    if (repo?.permissions?.push === false) {
      throw this.failure('GITHUB_AUTH_FAILED', `The token can read ${this.opts.repo} but can't write to it.`, tokenFix(this.opts.repo));
    }
  }

  /** A release by tag, drafts included: GitHub's release-by-tag lookup skips drafts, so this lists releases. */
  async findRelease(tag: string): Promise<GithubRelease | null> {
    for (let page = 1; page <= 10; page++) {
      const list = (await this.call<GithubRelease[]>('GET', this.api(`/releases?per_page=100&page=${page}`))) ?? [];
      const found = list.find((r) => r.tag_name === tag);
      if (found) return found;
      if (list.length < 100) return null;
    }
    return null;
  }

  async createDraft(input: { tag: string; name: string; body: string }): Promise<GithubRelease> {
    return (await this.call<GithubRelease>('POST', this.api('/releases'), { json: { tag_name: input.tag, name: input.name, body: input.body, draft: true } }))!;
  }

  async deleteAsset(id: number): Promise<void> {
    await this.call('DELETE', this.api(`/releases/assets/${id}`), { allow404: true });
  }

  async uploadAsset(release: GithubRelease, name: string, file: string): Promise<GithubAsset> {
    const url = `${release.upload_url.replace(/\{[^}]*\}$/, '')}?name=${encodeURIComponent(name)}`;
    return (await this.call<GithubAsset>('POST', url, { file, contentType: 'application/zip' }))!;
  }

  async publish(id: number): Promise<GithubRelease> {
    return (await this.call<GithubRelease>('PATCH', this.api(`/releases/${id}`), { json: { draft: false } }))!;
  }
}
