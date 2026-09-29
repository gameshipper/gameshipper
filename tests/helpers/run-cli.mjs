// Runs the real CLI from its TypeScript sources in its own Node process, the way bin/gameshipper.js runs
// dist/cli/main.js. Usage: node run-cli.mjs <none|rejection|exception> <gameshipper args...>
// With rejection/exception, the process fails asynchronously once the game's build command has started
// (it writes pid.txt into --dir), outside anything the CLI awaits.
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

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
    if (url.includes('/src/shell/') && url.endsWith('.ts')) {
      return { format: 'module-typescript', source: readFileSync(new URL(url)), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const [failure, ...argv] = process.argv.slice(2);
if (failure !== 'none') {
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

const { main } = await import(new URL('../../src/cli/main.ts', import.meta.url).href);
process.exitCode = await main(argv);
