import * as fs from 'node:fs';
import * as path from 'node:path';
import { DESKTOP_TARGETS, type Config, type DesktopTarget } from '../config/schema.js';
import { slugify } from '../names.js';
import { fail, gsError, ok, type Result } from '../result.js';
import { GAMESHIPPER_VERSION } from '../version.js';
import { githubWorkflow, WORKFLOW_PATH } from './workflow.js';

export interface CiData {
  /** The workflow file written. */
  path: string;
  /** The desktop targets it builds. */
  targets: DesktopTarget[];
}

/** `ci init`: writes .github/workflows/gameshipper.yml for the config's desktop targets. */
export function initCi(projectDir: string, config: Config, opts: { force?: boolean; version?: string } = {}): Result<CiData> {
  const targets = DESKTOP_TARGETS.filter((t) => config.targets.includes(t));
  if (!targets.length) {
    return fail(
      gsError(
        'CI_NO_DESKTOP_TARGETS',
        'gameshipper.json has no desktop targets, so there is nothing for CI to build.',
        'Add "windows", "mac" or "linux" to "targets" in gameshipper.json. iOS and Android projects are built in Xcode and Android Studio.',
      ),
    );
  }
  const file = path.join(projectDir, ...WORKFLOW_PATH.split('/'));
  if (fs.existsSync(file) && !opts.force) {
    return fail(gsError('CI_WORKFLOW_EXISTS', `${WORKFLOW_PATH} already exists.`, 'Pass --force to replace it, or edit it by hand.'));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, githubWorkflow({ version: opts.version ?? GAMESHIPPER_VERSION, targets, artifactPrefix: slugify(config.name) }));
  return ok({ path: file, targets });
}
