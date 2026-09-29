import * as nodeModule from 'node:module';

/**
 * Subprocess tests run Gameshipper's TypeScript sources in a plain Node process, which needs
 * module.registerHooks (for the .js -> .ts resolve hook) and built-in type stripping.
 */
export const canRunTs = typeof nodeModule.registerHooks === 'function' && Boolean(process.features.typescript);

/** Says when `what` is skipped for this Node version, so a green run doesn't hide untested behaviour. */
export function noteIfTsTestsSkipped(what: string): void {
  if (process.platform === 'win32' || canRunTs) return;
  console.warn(
    `Skipping ${what}: Node ${process.version} lacks module.registerHooks or TypeScript type stripping (Node 22.18+ has both).`,
  );
}
