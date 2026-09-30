import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, stopAllRuns } from '../../src/mcp/run-cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

const RESULT = { ok: true, data: { n: 1 }, errors: [], warnings: [] };
const INTERRUPTED = { ok: false, errors: [{ code: 'INTERRUPTED', message: 'Stopped by SIGTERM before finishing.' }], warnings: [] };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A stand-in for bin/gameshipper.js: an ES module that runs `body`, with the CLI's arguments in `args`. */
function fakeCli(body: string): string {
  const file = path.join(makeTmpDir(), 'fake-cli.mjs');
  fs.writeFileSync(file, `const args = process.argv.slice(2);\n${body}\n`);
  return file;
}

/**
 * A CLI that runs until it's stopped, and on SIGTERM prints INTERRUPTED like the real one. It exits by letting its event
 * loop run out, never with process.exit(): with NODE_USE_SYSTEM_CA=1 Node 24.7 can crash exiting while it still reads
 * the system certificates, and the real CLI waits for that read (exitProcess).
 */
const SLOW = `
  const running = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => { process.stdout.write(JSON.stringify(${JSON.stringify(INTERRUPTED)}, null, 2) + '\\n'); process.exitCode = 143; clearInterval(running); });
  process.stderr.write('started\\n');
`;

describe('runCli', () => {
  it('runs the CLI with the arguments in the given folder, with no terminal to prompt on, and returns its Result', async () => {
    const cwd = makeTmpDir();
    const bin = fakeCli(
      `console.log(JSON.stringify({ ok: true, data: { args, cwd: process.cwd(), tty: Boolean(process.stdin.isTTY) }, errors: [], warnings: [] }, null, 2));`,
    );
    const r = await runCli(['status', '--json'], { bin, cwd });
    expect(r).toEqual({ ok: true, data: { args: ['status', '--json'], cwd: fs.realpathSync(cwd), tty: false }, errors: [], warnings: [] });
  });

  it('streams the lines the CLI writes to stderr', async () => {
    const bin = fakeCli(`process.stderr.write('staging\\npackaging windows\\npart'); process.stderr.write('ial line\\n'); console.log(JSON.stringify(${JSON.stringify(RESULT)}));`);
    const lines: string[] = [];
    await runCli(['build'], { bin, onLine: (l) => lines.push(l) });
    expect(lines).toEqual(['staging', 'packaging windows', 'partial line']);
  });

  it('MCP_CLI_OUTPUT_INVALID, with what it printed, when the CLI ends without a Result', async () => {
    const bin = fakeCli(`console.log('not json'); process.stderr.write('boom\\n'); process.exitCode = 3;`);
    const r = await runCli(['build', '--json'], { bin });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('MCP_CLI_OUTPUT_INVALID');
    expect(r.errors[0].message).toContain('printed something besides its result');
    expect(r.errors[0].message).toContain('exit code 3');
    expect(r.errors[0].message).toContain('not json');
    expect(r.errors[0].message).toContain('boom');
    expect(r.errors[0].fix).toContain('npx gameshipper build --json');
    const silent = await runCli(['build', '--json'], { bin: fakeCli('process.exitCode = 3;') });
    expect(silent.errors[0].message).toContain('without printing a result (exit code 3)');
  });

  it('finds the Result after anything a plugin printed to stdout before it', async () => {
    const pretty = JSON.stringify(RESULT, null, 2);
    for (const junk of ['plugin says hi\n', 'progress {1/3}\n{"step": 2}\n', 'no newline {', '[{"a": 1}]']) {
      const bin = fakeCli(`process.stdout.write(${JSON.stringify(junk)}); console.log(${JSON.stringify(pretty)});`);
      expect(await runCli(['build'], { bin }), junk).toEqual(RESULT);
    }
  });

  it('keeps at most the last 5 MB of stdout, which still holds the Result, and shows how the output began', async () => {
    const noisy = fakeCli(`process.stdout.write('first line\\n' + 'x'.repeat(12 * 1024 * 1024) + '\\n'); console.log(JSON.stringify(${JSON.stringify(RESULT)}, null, 2));`);
    expect(await runCli(['build'], { bin: noisy })).toEqual(RESULT);
    const junkOnly = fakeCli(`process.stdout.write('first line\\n' + 'x'.repeat(12 * 1024 * 1024));`);
    const r = await runCli(['build'], { bin: junkOnly });
    expect(r.errors[0].message).toContain('first line');
    expect(r.errors[0].message.length).toBeLessThan(5000);
  });

  it('MCP_CLI_FAILED when the CLI cannot be started', async () => {
    const r = await runCli(['status'], { bin: fakeCli(''), cwd: path.join(makeTmpDir(), 'missing') });
    expect(r.errors[0].code).toBe('MCP_CLI_FAILED');
  });

  // Windows has no SIGTERM to catch: the command's process tree is ended at once there.
  it.skipIf(process.platform === 'win32')('a cancelled call stops the command, which reports INTERRUPTED', async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    const pending = runCli(['build'], { bin: fakeCli(SLOW), signal: controller.signal, onLine: (l) => lines.push(l) });
    for (let i = 0; i < 100 && !lines.includes('started'); i++) await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await pending;
    expect(r.errors.map((e) => e.code)).toEqual(['INTERRUPTED']);
  });

  it.skipIf(process.platform === 'win32')(
    "a cancelled command stuck in a blocking call (Electron's first download) is killed with everything it started",
    async () => {
      const dir = makeTmpDir();
      const pidFile = path.join(dir, 'installer.pid');
      // Like electron.ts's old spawnSync of Electron's installer: the CLI can't handle SIGTERM until the installer ends.
      const installer = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const bin = fakeCli(`
        process.on('SIGTERM', () => { process.exitCode = 143; });
        (await import('node:child_process')).spawnSync(process.execPath, ['-e', ${JSON.stringify(installer)}], { stdio: 'ignore' });
      `);
      const controller = new AbortController();
      const pending = runCli(['play'], { bin, signal: controller.signal, stopGraceMs: 300 });
      let pid = 0;
      for (let i = 0; i < 100 && !pid; i++, await new Promise((r) => setTimeout(r, 50))) pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
      expect(pid).toBeGreaterThan(0);
      controller.abort();
      const r = await pending;
      expect(r.errors.map((e) => e.code)).toEqual(['INTERRUPTED']);
      expect(r.errors[0].message).toContain('killed');
      let gone = false;
      for (let i = 0; i < 100 && !gone; i++, await new Promise((r) => setTimeout(r, 50))) gone = !alive(pid);
      expect(gone).toBe(true);
    },
  );

  it('a call cancelled before it starts runs nothing', async () => {
    const marker = path.join(makeTmpDir(), 'ran');
    const r = await runCli(['build'], { bin: fakeCli(`(await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, '')`), signal: AbortSignal.abort() });
    expect(r.errors[0].code).toBe('INTERRUPTED');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('stopAllRuns stops every running command and waits for it', async () => {
    const lines: string[] = [];
    const pending = runCli(['build'], { bin: fakeCli(SLOW), onLine: (l) => lines.push(l) });
    for (let i = 0; i < 100 && !lines.includes('started'); i++) await new Promise((r) => setTimeout(r, 50));
    await stopAllRuns();
    expect((await pending).errors.map((e) => e.code)).toEqual(['INTERRUPTED']);
  });
});
