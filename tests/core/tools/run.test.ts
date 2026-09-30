import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTPUT_BUFFER_CHARS } from '../../../src/core/proc.js';
import { handOff, runExternal, toolCommand } from '../../../src/core/tools/run.js';
import { makeTmpDir, writeFiles } from '../../helpers/tmp.js';

/** A tool as an ES module run with this Node. Tools never call process.exit() (see the plan's ground rules). */
function script(source: string): string {
  const dir = makeTmpDir();
  writeFiles(dir, { 'tool.mjs': source });
  return path.join(dir, 'tool.mjs');
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('toolCommand', () => {
  it('runs .js/.mjs/.cjs files with this Node and anything else directly', () => {
    const env = { A: '1' };
    expect(toolCommand('/x/fake.mjs', env)).toEqual({ command: process.execPath, args: ['/x/fake.mjs'], env });
    expect(toolCommand('/x/steamcmd.sh', env)).toEqual({ command: '/x/steamcmd.sh', args: [], env });
  });
});

describe('runExternal', () => {
  it('captures stdout and stderr, hands every line to onLine, and reports the exit code', async () => {
    const file = script(`process.stdout.write('one\\ntwo\\n'); process.stderr.write('three\\n'); process.exitCode = 3;`);
    const lines: string[] = [];
    const r = await runExternal(toolCommand(file, { ...process.env }), [], { timeoutMs: 10_000, onLine: (l) => lines.push(l) });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('one\ntwo\n');
    expect(lines.sort()).toEqual(['one', 'three', 'two']);
    expect([r.timedOut, r.stoppedOn, r.spawnError]).toEqual([false, null, null]);
  });

  it('passes the arguments and exactly the given environment', async () => {
    const file = script(`console.log(process.argv.slice(2).join('|') + ' ' + process.env.GS_TEST_VALUE + ' ' + (process.env.GS_TEST_UNSET ?? 'unset'));`);
    const env: NodeJS.ProcessEnv = { ...process.env, GS_TEST_VALUE: 'hello' };
    delete env.GS_TEST_UNSET;
    const r = await runExternal(toolCommand(file, env), ['+login', 'a b'], { timeoutMs: 10_000 });
    expect(r.output.trim()).toBe('+login|a b hello unset');
  });

  it('stops at a prompt nobody can answer, even before its newline', async () => {
    const file = script(`process.stdout.write('Loading...OK\\npassword: '); setInterval(() => {}, 1000);`);
    const r = await runExternal(toolCommand(file, { ...process.env }), [], { timeoutMs: 20_000, stopOn: /password:/ });
    expect([r.stoppedOn, r.exitCode, r.timedOut]).toEqual(['password:', null, false]);
  });

  it.skipIf(process.platform === 'win32')('stops what the tool started too (steamcmd.sh runs steamcmd as its child)', async () => {
    const pidFile = path.join(makeTmpDir(), 'grandchild.pid');
    const file = script(
      `import { spawn } from 'node:child_process';
       import * as fs from 'node:fs';
       const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
       process.stdout.write('password: ');
       setInterval(() => {}, 1000);`,
    );
    const r = await runExternal(toolCommand(file, { ...process.env }), [], { timeoutMs: 20_000, stopOn: /password:/ });
    expect(r.stoppedOn).toBe('password:');
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('times out', async () => {
    const file = script(`setInterval(() => {}, 1000);`);
    const r = await runExternal(toolCommand(file, { ...process.env }), [], { timeoutMs: 500 });
    expect([r.timedOut, r.exitCode]).toEqual([true, null]);
  });

  it('keeps only the end of a long output', async () => {
    const file = script(`for (let i = 0; i < 4000; i++) process.stdout.write('line ' + i + ' ' + 'x'.repeat(60) + '\\n');`);
    let count = 0;
    const r = await runExternal(toolCommand(file, { ...process.env }), [], { timeoutMs: 20_000, onLine: () => void count++ });
    expect(count).toBe(4000);
    expect(r.output.length).toBeLessThanOrEqual(OUTPUT_BUFFER_CHARS);
    expect(r.output.trimEnd().split('\n').at(-1)).toMatch(/^line 3999 /);
  });

  it('handles a 50 MB line in bounded memory and linear time, and still finds a prompt at its end', async () => {
    const file = script(
      `const chunk = 'x'.repeat(1 << 20);
       for (let i = 0; i < 50; i++) process.stdout.write(chunk);
       process.stdout.write('\\nshort line\\n');
       for (let i = 0; i < 50; i++) process.stdout.write(chunk);
       process.stdout.write('password: ');
       setInterval(() => {}, 1000);`,
    );
    const lines: string[] = [];
    const started = Date.now();
    const r = await runExternal(toolCommand(file, { ...process.env }), [], { timeoutMs: 60_000, stopOn: /password:/, onLine: (l) => lines.push(l) });
    // Searching the whole line again on each write took about 10 s here.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.stoppedOn).toMatch(/password:$/);
    expect(r.stoppedOn!.length).toBeLessThanOrEqual(OUTPUT_BUFFER_CHARS);
    expect(r.output.length).toBeLessThanOrEqual(OUTPUT_BUFFER_CHARS);
    expect(r.output.endsWith('xpassword: ')).toBe(true);
    // The long lines reach the log cut short, saying how much was left out.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`${'x'.repeat(OUTPUT_BUFFER_CHARS)}… (${50 * (1 << 20) - OUTPUT_BUFFER_CHARS} more characters)`);
    expect(lines[1]).toBe('short line');
    expect(lines[2]).toBe(`${'x'.repeat(OUTPUT_BUFFER_CHARS)}… (${50 * (1 << 20) + 'password: '.length - OUTPUT_BUFFER_CHARS} more characters)`);
  });

  it('finds a prompt split across writes, and hands on a line split across writes once', async () => {
    const file = script(
      `const wait = () => new Promise((r) => setTimeout(r, 50));
       process.stdout.write('Logging in\\r\\nSteam Guard ');
       await wait();
       process.stdout.write('co');
       await wait();
       process.stdout.write('de:');
       setInterval(() => {}, 1000);`,
    );
    const lines: string[] = [];
    const r = await runExternal(toolCommand(file, { ...process.env }), [], { timeoutMs: 20_000, stopOn: /Steam Guard code:/, onLine: (l) => lines.push(l) });
    expect(r.stoppedOn).toBe('Steam Guard code:');
    expect(lines).toEqual(['Logging in', 'Steam Guard code:']);
  });

  it('reports a tool that cannot start', async () => {
    const r = await runExternal(toolCommand('/nonexistent/steamcmd.sh', { ...process.env }), [], { timeoutMs: 5_000 });
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toContain('ENOENT');
  });
});

describe('handOff', () => {
  it('returns the tool’s exit code, or 127 when it cannot start', async () => {
    expect(await handOff(toolCommand(script('process.exitCode = 3;'), { ...process.env }), [])).toBe(3);
    expect(await handOff(toolCommand('/nonexistent/butler', { ...process.env }), ['login'])).toBe(127);
  });
});
