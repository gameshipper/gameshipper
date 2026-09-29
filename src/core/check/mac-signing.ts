import { runTool, type ToolRunner } from '../proc.js';

export type { ToolRunner };

export interface MacSigning {
  kind: 'developer-id' | 'adhoc' | 'unsigned' | 'other';
  /** The signing certificate, e.g. "Developer ID Application: Valve Corporation (MXGJJ98X76)". */
  authority: string | null;
  /** `codesign --verify --deep --strict` passed. */
  valid: boolean;
  /** A notarization ticket is stapled (`xcrun stapler validate`); null when that couldn't be checked. */
  stapled: boolean | null;
  /** Tool output for the report when something is wrong. */
  detail: string;
}

/** Reads `codesign -dv --verbose=2` output (codesign prints it to stderr). */
export function parseCodesignDisplay(output: string): Pick<MacSigning, 'kind' | 'authority'> {
  if (/not signed at all/.test(output)) return { kind: 'unsigned', authority: null };
  if (/^Signature=adhoc$/m.test(output)) return { kind: 'adhoc', authority: null };
  const authority = /^Authority=(.+)$/m.exec(output)?.[1] ?? null;
  if (authority?.startsWith('Developer ID Application:')) return { kind: 'developer-id', authority };
  return { kind: authority ? 'other' : 'unsigned', authority };
}

/** How the .app bundle is signed and whether it is notarized. macOS only. */
export async function inspectMacSigning(appPath: string, run: ToolRunner = runTool): Promise<MacSigning> {
  const display = await run('codesign', ['-dv', '--verbose=2', appPath]);
  const verify = await run('codesign', ['--verify', '--deep', '--strict', appPath]);
  // Without Apple's command-line tools, running xcrun makes macOS pop up a dialog offering to install them.
  const tools = await run('xcode-select', ['-p']);
  const staple = tools.code === 0 ? await run('xcrun', ['stapler', 'validate', appPath]) : null;
  const { kind, authority } = parseCodesignDisplay(display.output);
  // stapler starts with a "Processing: <path>" line that says nothing about the problem.
  const stapleOutput = staple ? staple.output.split('\n').filter((l) => !/^Processing:/.test(l)).join('\n').trim() : '';
  const problems = [verify.code === 0 ? '' : verify.output, staple && staple.code !== 0 ? stapleOutput : ''];
  return {
    kind,
    authority,
    valid: verify.code === 0,
    stapled: staple ? staple.code === 0 : null,
    detail: problems.filter(Boolean).join('\n'),
  };
}
