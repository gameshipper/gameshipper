// Runs the real CLI from its TypeScript sources in its own Node process, the way bin/gameshipper.js runs
// dist/cli/main.js. Usage: node run-cli.mjs <none|rejection|exception|slow-load|busy-load> <gameshipper args...>
// With rejection/exception, the process fails asynchronously once the game's build command has started
// (it writes pid.txt into --dir), outside anything the CLI awaits. With slow-load, it writes "loading" to
// stderr and waits 3 s before loading the CLI. With busy-load, it loads the CLI, writes "loading", then
// blocks for 1.5 s, as synchronous module loading does: a signal then waits until the CLI takes over.
// GS_TEST_ELECTRON replaces the Electron binary `play` runs.
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { start } from '../../bin/start.js';

registerHooks({
  // The sources import each other as .js, as compiled output does.
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // not a source file
      }
    }
    return nextResolve(specifier, context);
  },
  // src/shell compiles to CommonJS (its package.json says so), but its sources are ES modules.
  load(url, context, nextLoad) {
    if (process.env.GS_TEST_ELECTRON && url.endsWith('/src/core/electron.ts')) {
      const source = `export const ELECTRON_VERSION = 'test'; export const electronBinary = () => process.env.GS_TEST_ELECTRON;`;
      return { format: 'module', source, shortCircuit: true };
    }
    if (url.includes('/src/shell/') && url.endsWith('.ts')) {
      return { format: 'module-typescript', source: readFileSync(new URL(url)), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const [failure, ...argv] = process.argv.slice(2);
if (failure === 'rejection' || failure === 'exception') {
  const dir = argv[argv.indexOf('--dir') + 1];
  const timer = setInterval(() => {
    if (!existsSync(`${dir}/pid.txt`)) return;
    clearInterval(timer);
    if (failure === 'rejection') void Promise.reject(new Error('async boom'));
    else
      setTimeout(() => {
        throw new Error('async boom');
      });
  }, 50);
}

// Started the way bin/gameshipper.js starts the CLI, so signals are covered while it loads.
process.exitCode = await start(argv, async () => {
  if (failure === 'slow-load') {
    process.stderr.write('loading\n');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const cli = await import(new URL('../../src/cli/main.ts', import.meta.url).href);
  if (failure === 'busy-load') {
    writeSync(2, 'loading\n');
    for (const end = Date.now() + 1500; Date.now() < end; );
  }
  return cli;
});
