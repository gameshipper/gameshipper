import type { DesktopTarget } from '../config/schema.js';

/** Where `ci init` writes the workflow, relative to the game folder. */
export const WORKFLOW_PATH = '.github/workflows/gameshipper.yml';

/** The GitHub-hosted runner for each target: every build is made and run on its own OS. */
export const RUNNERS: Record<DesktopTarget, string> = {
  windows: 'windows-latest',
  mac: 'macos-latest',
  linux: 'ubuntu-latest',
};

export interface WorkflowOptions {
  /** The Gameshipper version the workflow runs, pinned so CI builds what this computer builds. */
  version: string;
  targets: readonly DesktopTarget[];
  /** Artifacts are named <artifactPrefix>-<target>.tar.gz. */
  artifactPrefix: string;
}

/** `${{ expr }}` for GitHub Actions, written without tripping over JavaScript's template syntax. */
const gh = (expr: string): string => '${{ ' + expr + ' }}';

/**
 * A GitHub Actions workflow for a game repository: on every push to main or master and every pull request, each
 * desktop target is built on its own OS, run for a few seconds (`play --packaged --smoke`) and uploaded as a tarball.
 */
export function githubWorkflow(o: WorkflowOptions): string {
  const cli = `npx --yes gameshipper@${o.version}`;
  const target = gh('matrix.target');
  const archive = `${o.artifactPrefix}-${target}.tar.gz`;
  const lines = [
    `# Written by \`npx gameshipper ci init\` (Gameshipper ${o.version}). Regenerate it with \`npx gameshipper ci init --force\`.`,
    '# Builds the game on each desktop OS, runs each build for a few seconds to catch errors,',
    '# and uploads the builds as workflow artifacts (.tar.gz, which keeps file permissions and the Mac app intact).',
    '#',
    '# - Commit gameshipper.lock if your game has one: builds use --frozen-lock, so CDN files must be recorded in it.',
    "# - Builds have Steam features only with your Steamworks SDK. Valve's license doesn't allow committing it to a",
    '#   public repository: download it in a step of your own and set GAMESHIPPER_STEAM_SDK to its path.',
    '# - Mac builds are ad-hoc signed here. To sign and notarize, import your Developer ID certificate into a keychain',
    '#   on the runner and set GAMESHIPPER_MAC_IDENTITY, GAMESHIPPER_NOTARY_KEY (the path of your .p8 key file),',
    '#   GAMESHIPPER_NOTARY_KEY_ID and GAMESHIPPER_NOTARY_ISSUER from repository secrets (`npx gameshipper help --json`).',
    "#   Pull requests run their own code here, so only hand those secrets to steps with `if: github.event_name == 'push'`,",
    '#   or to a job in a protected environment that requires a reviewer.',
    'name: Gameshipper',
    '',
    'on:',
    '  push:',
    '    branches: [main, master]',
    '  pull_request:',
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    `  group: gameshipper-${gh('github.ref')}`,
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  build:',
    `    name: Build ${target}`,
    `    runs-on: ${gh('matrix.os')}`,
    '    timeout-minutes: 30',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        include:',
    ...o.targets.flatMap((t) => [`          - target: ${t}`, `            os: ${RUNNERS[t]}`]),
    '    defaults:',
    '      run:',
    '        shell: bash',
    '    env:',
    '      # Hosted runners have no GPU: let WebGL fall back to software rendering.',
    "      GAMESHIPPER_SOFTWARE_GL: '1'",
    '    steps:',
    '      - uses: actions/checkout@v7',
    '        with:',
    '          persist-credentials: false',
    '',
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 24',
    '',
    "      - name: Install the game's dependencies",
    "        if: hashFiles('package-lock.json') != ''",
    '        run: npm ci',
    '',
    "      - name: Install the game's dependencies (no package-lock.json)",
    "        if: hashFiles('package-lock.json') == '' && hashFiles('package.json') != ''",
    '        run: npm install',
    '',
    '      - name: Build',
    `        run: ${cli} build --target ${target} --frozen-lock`,
    '',
    '      - name: Get a virtual display',
    "        if: runner.os == 'Linux'",
    '        run: command -v xvfb-run || (sudo apt-get update && sudo apt-get install -y xvfb)',
    '',
    '      - name: Run the build for a few seconds',
    "        if: runner.os == 'Linux'",
    `        run: xvfb-run --auto-servernum ${cli} play --packaged --smoke`,
    '',
    '      - name: Run the build for a few seconds',
    "        if: runner.os != 'Linux'",
    `        run: ${cli} play --packaged --smoke`,
    '',
    '      - name: Pack the build',
    `        run: tar -czf ${archive} -C out ${target}`,
    '',
    '      - uses: actions/upload-artifact@v7',
    '        with:',
    `          path: ${archive}`,
    '          archive: false',
    '          if-no-files-found: error',
    '',
    '      - name: Keep the run logs',
    '        if: failure()',
    '        uses: actions/upload-artifact@v7',
    '        with:',
    `          name: gameshipper-logs-${target}`,
    '          path: .gameshipper/logs/',
    '          include-hidden-files: true',
    '          if-no-files-found: ignore',
  ];
  return `${lines.join('\n')}\n`;
}
