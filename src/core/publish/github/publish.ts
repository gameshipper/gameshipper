import * as fs from 'node:fs';
import * as path from 'node:path';
import { GITHUB_REPO_PATTERN, type Config, type DesktopTarget } from '../../config/schema.js';
import type { Ctx } from '../../context.js';
import { slugify } from '../../names.js';
import { GsFailure, gsError } from '../../result.js';
import { zipFolder } from '../../tools/zip.js';
import { GAMESHIPPER_VERSION } from '../../version.js';
import type { DesktopBuild } from '../builds.js';
import { failedDestination, type DestinationResult, type PublishEnv } from '../types.js';
import { GithubClient, type GithubRelease } from './api.js';

export interface GithubDetails {
  repo: string;
  tag: string;
  /** create = a new draft; update = the existing draft, its files replaced. */
  action: 'create' | 'update';
  draft: boolean;
  url: string | null;
  assets: Array<{ target: DesktopTarget; name: string; size: number | null; url: string | null }>;
}

export interface GithubOptions extends PublishEnv {
  /** --repo; else github.repo in gameshipper.json. */
  repo: string | null;
  /** --live: publish the release instead of leaving a draft. */
  live: boolean;
}

const OS_LABEL: Record<DesktopTarget, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };

/**
 * Zips each desktop build and attaches it to the release v<version>: a draft, published last and only with --live, so
 * a failed run never leaves a public release with files missing. Publishing again reuses the draft and replaces its
 * files; a published release is never changed. The token comes only from GITHUB_TOKEN or GH_TOKEN.
 */
export async function publishGithub(ctx: Ctx, config: Config, builds: DesktopBuild[], opts: GithubOptions): Promise<DestinationResult<GithubDetails>> {
  const repo = opts.repo ?? config.github.repo;
  if (!repo) {
    return failedDestination<GithubDetails>('github', gsError('INPUT_REQUIRED', 'GitHub Releases needs a repository.', 'Pass --repo owner/name or set github.repo in gameshipper.json.'));
  }
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    return failedDestination<GithubDetails>('github', gsError('USAGE', `"${repo}" isn't a GitHub repository.`, 'Give it as owner/name, e.g. --repo moonstudio/moon-game.'));
  }
  const token = opts.env.GITHUB_TOKEN || opts.env.GH_TOKEN;
  if (!token) {
    return failedDestination<GithubDetails>(
      'github',
      gsError(
        'GITHUB_TOKEN_MISSING',
        'GitHub Releases needs a token in the GITHUB_TOKEN (or GH_TOKEN) environment variable.',
        `Ask the human for a token that can write to ${repo} (a fine-grained token with Contents: Read and write on it, or a classic token with the repo scope) set as GITHUB_TOKEN where Gameshipper runs. Gameshipper doesn't use the gh CLI's login.`,
      ),
    );
  }
  const api = new GithubClient({
    apiBase: opts.env.GAMESHIPPER_GITHUB_API || 'https://api.github.com',
    token,
    repo,
    userAgent: `gameshipper/${GAMESHIPPER_VERSION}`,
    log: (line) => ctx.log(line),
  });
  const tag = `v${config.version}`;
  const planned = builds.map((build) => ({ build, name: `${slugify(config.name)}-${config.version}-${build.target}.zip` }));

  await api.checkRepo();
  const existing = await api.findRelease(tag);
  if (existing && !existing.draft) {
    return failedDestination<GithubDetails>(
      'github',
      gsError(
        'GITHUB_RELEASE_PUBLISHED',
        `Release ${tag} is already published on ${repo}: ${existing.html_url}`,
        'Raise "version" in gameshipper.json and build again for a new release. To replace this release\'s files, turn it back into a draft on GitHub first.',
      ),
    );
  }
  const details: GithubDetails = {
    repo,
    tag,
    action: existing ? 'update' : 'create',
    draft: true,
    url: existing?.html_url ?? null,
    assets: planned.map((p) => ({ target: p.build.target, name: p.name, size: null, url: null })),
  };
  if (opts.dryRun) return { to: 'github', status: 'previewed', details, errors: [], warnings: [] };

  const releaseDir = path.join(ctx.projectDir, '.gameshipper', 'release');
  try {
    const zips: string[] = [];
    for (const p of planned) {
      const file = path.join(releaseDir, p.name);
      try {
        await zipFolder(p.build.dir, file, { platform: opts.platform });
      } catch (e) {
        const error = gsError(
          'ZIP_FAILED',
          `Couldn't zip ${p.build.dir}: ${e instanceof Error ? e.message : String(e)}`,
          'Check there is free disk space and that nothing else is changing out/, then publish again.',
        );
        return failedDestination('github', error, [], details);
      }
      ctx.log(`github: zipped ${p.build.target} → ${file}`);
      zips.push(file);
    }
    let release: GithubRelease =
      existing ??
      (await api.createDraft({
        tag,
        name: `${config.name} ${config.version}`,
        body: [`${config.name} ${config.version}`, '', ...planned.map((p) => `- ${OS_LABEL[p.build.target]}: ${p.name}`), ''].join('\n'),
      }));
    details.url = release.html_url;
    try {
      for (const [i, p] of planned.entries()) {
        const old = release.assets.find((a) => a.name === p.name);
        if (old) await api.deleteAsset(old.id);
        const asset = await api.uploadAsset(release, p.name, zips[i]);
        details.assets[i].size = asset.size;
        details.assets[i].url = asset.browser_download_url;
      }
      if (opts.live) release = await api.publish(release.id);
    } catch (e) {
      // The draft is there: say where, so the human can look at it or publish again.
      if (e instanceof GsFailure) return failedDestination('github', e.error, [], details);
      throw e;
    }
    details.draft = release.draft;
    details.url = release.html_url;
    return { to: 'github', status: 'uploaded', details, errors: [], warnings: [] };
  } finally {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
}
