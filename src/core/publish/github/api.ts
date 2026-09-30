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

const TOKEN_FIX =
  "Use a token that can write to the repository (a fine-grained token with Contents: Read and write on it, or a classic token with the repo scope) in GITHUB_TOKEN or GH_TOKEN. Gameshipper doesn't use the gh CLI's login.";

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
      throw new GsFailure('GITHUB_API_FAILED', `Couldn't reach GitHub (${method} ${where}): ${(e as Error).message}${code}.`, 'Check your internet connection, then publish again.');
    }
    this.opts.log(`github: ${method} ${where} → ${res.status}`);
    if (res.ok) return res.status === 204 ? null : ((await res.json()) as T);
    if (res.status === 404 && init.allow404) return null;
    const text = await res.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // not JSON
    }
    const repo = this.opts.repo;
    if (res.status === 401) throw new GsFailure('GITHUB_AUTH_FAILED', `GitHub refused the token (401: ${message}).`, TOKEN_FIX);
    if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'))) {
      throw new GsFailure('GITHUB_API_FAILED', `GitHub's API rate limit is used up (${message}).`, 'Wait until it resets (an hour at most), then publish again.');
    }
    if (res.status === 403) throw new GsFailure('GITHUB_AUTH_FAILED', `The token isn't allowed to do this on ${repo} (403: ${message}).`, TOKEN_FIX);
    if (res.status === 404) {
      throw new GsFailure(
        'GITHUB_REPO_NOT_FOUND',
        `GitHub can't find ${repo}, or the token can't see it.`,
        'Check github.repo in gameshipper.json (or --repo): it must be the owner/name of a repository that exists and that the token can access.',
      );
    }
    throw new GsFailure('GITHUB_API_FAILED', `GitHub ${method} ${where} failed (HTTP ${res.status}: ${message}).`, 'Publish again in a minute. If it keeps failing, check https://www.githubstatus.com.');
  }

  private api(path: string): string {
    return `${this.opts.apiBase.replace(/\/$/, '')}/repos/${this.opts.repo}${path}`;
  }

  /** Fails early when the repository is missing or the token can't write to it. */
  async checkRepo(): Promise<void> {
    const repo = await this.call<{ permissions?: { push?: boolean } }>('GET', this.api(''));
    if (repo?.permissions?.push === false) {
      throw new GsFailure('GITHUB_AUTH_FAILED', `The token can read ${this.opts.repo} but can't write to it.`, TOKEN_FIX);
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
