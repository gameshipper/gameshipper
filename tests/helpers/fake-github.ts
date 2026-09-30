import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
}

export interface FakeRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  html_url: string;
  upload_url: string;
  assets: FakeAsset[];
}

export interface FakeGithub {
  base: string;
  releases: FakeRelease[];
  /** "METHOD /path" of every request, in order. */
  requests: string[];
  /** The bytes uploaded under each asset name (the latest upload wins). */
  uploads: Record<string, Buffer>;
  /** Whether the token may write to the repository; tests may change it. */
  canPush: boolean;
  /** Uploads fail with a server error; tests may change it. */
  failUploads: boolean;
  close(): Promise<void>;
}

/**
 * A local stand-in for the parts of GitHub's REST API that publish uses: the repository, listing, creating and
 * updating releases, and uploading and deleting assets. Like GitHub it checks the Bearer token, refuses an asset
 * whose name is taken (422 already_exists), wants Content-Length on uploads, and serves upload_url itself (as
 * uploads.github.com does).
 */
export async function startFakeGithub(repo: string, token = 'test-token'): Promise<FakeGithub> {
  let nextId = 1;
  const state: Omit<FakeGithub, 'base' | 'close'> = { releases: [], requests: [], uploads: {}, canPush: true, failUploads: false };
  let base = '';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base);
      const method = req.method ?? 'GET';
      state.requests.push(`${method} ${url.pathname}`);
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
      const raw = Buffer.concat(chunks);
      const json = () => JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
      const repoPath = `/repos/${repo}`;
      const uploadPath = `/uploads/repos/${repo}/releases/`;

      if (url.pathname.startsWith(uploadPath) && method === 'POST') {
        const release = state.releases.find((r) => r.id === Number(url.pathname.slice(uploadPath.length).split('/')[0]));
        const name = url.searchParams.get('name') ?? '';
        if (!release) return send(404, { message: 'Not Found' });
        if (state.failUploads) return send(502, { message: 'Server Error' });
        if (!req.headers['content-type'] || req.headers['content-length'] !== String(raw.length)) {
          return send(400, { message: 'Content-Type and a correct Content-Length are required' });
        }
        if (release.assets.some((a) => a.name === name)) {
          return send(422, { message: 'Validation Failed', errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }] });
        }
        const asset: FakeAsset = { id: nextId++, name, size: raw.length, browser_download_url: `${base}/${repo}/releases/download/${release.tag_name}/${name}` };
        release.assets.push(asset);
        state.uploads[name] = raw;
        return send(201, asset);
      }
      if (!url.pathname.startsWith(repoPath)) return send(404, { message: 'Not Found' });
      const rest = url.pathname.slice(repoPath.length);
      if (rest === '' && method === 'GET') return send(200, { full_name: repo, permissions: { admin: false, push: state.canPush, pull: true } });
      if (rest === '/releases' && method === 'GET') {
        const perPage = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        const newestFirst = [...state.releases].sort((a, b) => b.id - a.id);
        return send(200, newestFirst.slice((page - 1) * perPage, page * perPage));
      }
      if (!state.canPush && method !== 'GET') return send(403, { message: 'Resource not accessible by personal access token' });
      if (rest === '/releases' && method === 'POST') {
        const body = json();
        const id = nextId++;
        const tag = String(body.tag_name);
        const draft = body.draft === true;
        const release: FakeRelease = {
          id,
          tag_name: tag,
          name: (body.name as string) ?? null,
          body: (body.body as string) ?? null,
          draft,
          html_url: draft ? `${base}/${repo}/releases/tag/untagged-${id}` : `${base}/${repo}/releases/tag/${tag}`,
          upload_url: `${base}${uploadPath}${id}/assets{?name,label}`,
          assets: [],
        };
        state.releases.push(release);
        return send(201, release);
      }
      const releaseMatch = /^\/releases\/(\d+)$/.exec(rest);
      if (releaseMatch && method === 'PATCH') {
        const release = state.releases.find((r) => r.id === Number(releaseMatch[1]));
        if (!release) return send(404, { message: 'Not Found' });
        if (json().draft === false) {
          release.draft = false;
          release.html_url = `${base}/${repo}/releases/tag/${release.tag_name}`;
        }
        return send(200, release);
      }
      const assetMatch = /^\/releases\/assets\/(\d+)$/.exec(rest);
      if (assetMatch && method === 'DELETE') {
        for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== Number(assetMatch[1]));
        return send(204);
      }
      return send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, {
    base,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
