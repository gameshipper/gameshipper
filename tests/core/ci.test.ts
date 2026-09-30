import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { initCi } from '../../src/core/ci/init.js';
import { githubWorkflow, WORKFLOW_PATH } from '../../src/core/ci/workflow.js';
import { parseConfig } from '../../src/core/config/load.js';
import { makeTmpDir } from '../helpers/tmp.js';

const config = (extra: object = {}) => parseConfig({ name: 'Moon Game', version: '1.0.0', ...extra }).data!;
const hasActionlint = spawnSync('actionlint', ['-version'], { stdio: 'ignore' }).status === 0;

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: { build: { 'runs-on': string; strategy: { matrix: { include: unknown[] } }; env: Record<string, string>; steps: Step[] } };
}

describe('githubWorkflow', () => {
  const yaml = githubWorkflow({ version: '1.2.3', targets: ['windows', 'mac', 'linux'], artifactPrefix: 'moon-game' });
  const wf = parse(yaml) as Workflow;
  const steps = wf.jobs.build.steps;
  const runs = steps.map((s) => s.run ?? '').join('\n');

  it('builds each target on its own OS, with read-only access to the repo', () => {
    expect(wf.jobs.build['runs-on']).toBe('${{ matrix.os }}');
    expect(wf.jobs.build.strategy.matrix.include).toEqual([
      { target: 'windows', os: 'windows-latest' },
      { target: 'mac', os: 'macos-latest' },
      { target: 'linux', os: 'ubuntu-latest' },
    ]);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(wf.on)).toEqual(['push', 'pull_request', 'workflow_dispatch']);
  });

  it('pins the Gameshipper version, builds with --frozen-lock and smoke-tests the packaged build (under xvfb on Linux)', () => {
    expect(runs).toContain('npx --yes gameshipper@1.2.3 build --target ${{ matrix.target }} --frozen-lock');
    expect(runs).toContain('xvfb-run --auto-servernum npx --yes gameshipper@1.2.3 play --packaged --smoke');
    expect(steps.filter((s) => s.run?.includes('play --packaged --smoke')).map((s) => s.if)).toEqual(["runner.os == 'Linux'", "runner.os != 'Linux'"]);
    expect(wf.jobs.build.env.GAMESHIPPER_SOFTWARE_GL).toBe('1');
  });

  it('uploads a tarball, so file permissions and the Mac app bundle survive', () => {
    expect(runs).toContain('tar -czf moon-game-${{ matrix.target }}.tar.gz -C out ${{ matrix.target }}');
    const upload = steps.find((s) => s.uses === 'actions/upload-artifact@v7' && s.with?.archive === false);
    expect(upload?.with?.path).toBe('moon-game-${{ matrix.target }}.tar.gz');
  });

  it("never hands the repository's token or secrets to the build: pull requests run the game's code", () => {
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with).toEqual({ 'persist-credentials': false });
    expect(yaml).not.toContain('secrets.');
    expect(yaml).not.toContain('pull_request_target');
    // Signing is for the human to add: the comments say to keep those secrets away from pull requests.
    expect(yaml).toContain("github.event_name == 'push'");
    expect(yaml).toContain('protected environment');
  });

  it('keeps the run logs of a failed run', () => {
    const logs = steps.find((s) => s.with?.path === '.gameshipper/logs/');
    expect(logs).toMatchObject({ if: 'failure()', uses: 'actions/upload-artifact@v7', with: { 'include-hidden-files': true } });
  });

  it('only includes the targets it is given', () => {
    const only = parse(githubWorkflow({ version: '1.2.3', targets: ['linux'], artifactPrefix: 'x' })) as Workflow;
    expect(only.jobs.build.strategy.matrix.include).toEqual([{ target: 'linux', os: 'ubuntu-latest' }]);
  });

  it.skipIf(!hasActionlint)('passes actionlint (and shellcheck, when installed)', () => {
    const file = path.join(makeTmpDir(), 'gameshipper.yml');
    fs.writeFileSync(file, yaml);
    const r = spawnSync('actionlint', [file], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('initCi', () => {
  it('writes .github/workflows/gameshipper.yml for the desktop targets', () => {
    const dir = makeTmpDir();
    const r = initCi(dir, config({ targets: ['windows', 'linux', 'ios'] }), { version: '1.2.3' });
    expect(r.errors).toEqual([]);
    expect(r.data).toEqual({ path: path.join(dir, ...WORKFLOW_PATH.split('/')), targets: ['windows', 'linux'] });
    expect(fs.readFileSync(r.data!.path, 'utf8')).toContain('gameshipper@1.2.3');
  });

  it('CI_WORKFLOW_EXISTS unless forced', () => {
    const dir = makeTmpDir();
    expect(initCi(dir, config()).ok).toBe(true);
    const again = initCi(dir, config());
    expect(again.errors.map((e) => [e.code, e.fix])).toEqual([['CI_WORKFLOW_EXISTS', 'Pass --force to replace it, or edit it by hand.']]);
    expect(initCi(dir, config(), { force: true }).ok).toBe(true);
  });

  it('CI_NO_DESKTOP_TARGETS for a mobile-only config', () => {
    const r = initCi(makeTmpDir(), config({ targets: ['ios'], mobile: { bundleId: 'com.moon.game' } }));
    expect(r.errors[0].code).toBe('CI_NO_DESKTOP_TARGETS');
  });
});
