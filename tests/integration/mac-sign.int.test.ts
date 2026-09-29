import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { notarizeMacApp } from '../../src/core/sign/notarize.js';
import { runSmoke } from '../../src/core/smoke.js';
import { cli, readEvents, ROOT } from '../helpers/built-cli.js';
import { testCtx } from '../helpers/ctx.js';
import { installFakeXcrun, withEnv } from '../helpers/fake-xcrun.js';
import { makeSolidPng } from '../helpers/png.js';
import { makeTmpDir, writeFiles } from '../helpers/tmp.js';

const BRIDGE_OK = 'gameshipper-bridge:{"ok":true}';
const STEAM_OVERLAY = path.join(os.homedir(), 'Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/gameoverlayrenderer.dylib');

const codesign = (...args: string[]) => {
  const r = spawnSync('codesign', args, { encoding: 'utf8' });
  return { code: r.status, text: `${r.stdout}${r.stderr}` };
};

function freshGame(): string {
  const dir = makeTmpDir('gs-mac-');
  fs.cpSync(path.join(ROOT, 'fixtures', 'threejs-cdn'), dir, { recursive: true });
  writeFiles(dir, { 'icon.png': makeSolidPng(1024, 1024) });
  expect(cli(['init', '--yes', '--name', 'Spinning Cube'], dir).code).toBe(0);
  return dir;
}

// The Apple variables are set empty for every test run (vitest.int.config.ts), so builds here are ad-hoc signed.
describe.runIf(process.platform === 'darwin')('Mac signing on this Mac', () => {
  it("build → hardened ad-hoc signature → the game runs → Steam's overlay can be injected → fake notarization", async (ctx) => {
    const dir = freshGame();

    // 1. Without Apple credentials the app is ad-hoc signed with the hardened runtime.
    const build = cli(['build', '--target', 'mac'], dir);
    expect(build.result.errors).toEqual([]);
    expect(build.result.warnings.map((w: { code: string }) => w.code)).toContain('MAC_UNSIGNED');
    const mac = build.result.data.targets.find((t: { target: string }) => t.target === 'mac').output;
    expect(mac.mac).toEqual({ signing: 'adhoc', notarized: false });
    const exe: string = mac.executable;
    const app = path.join(mac.dir, 'Spinning Cube.app');

    // 2. The signature is valid, hardened, and carries Steam's entitlements; the DYLD one on the main app only.
    expect(codesign('--verify', '--deep', '--strict', app).code).toBe(0);
    expect(codesign('-dv', app).text).toContain('flags=0x10002(adhoc,runtime)');
    const main = codesign('-d', '--entitlements', '-', '--xml', app).text;
    for (const key of ['allow-jit', 'disable-library-validation', 'allow-dyld-environment-variables']) expect(main).toContain(`com.apple.security.cs.${key}`);
    expect(main).not.toContain('app-sandbox');
    const helpers = fs.readdirSync(path.join(app, 'Contents', 'Frameworks')).filter((f) => f.endsWith('.app'));
    expect(helpers.length).toBeGreaterThanOrEqual(4);
    for (const helper of helpers) {
      const h = path.join(app, 'Contents', 'Frameworks', helper);
      expect(codesign('-dv', h).text, helper).toContain('flags=0x10002(adhoc,runtime)');
      expect(codesign('-d', '--entitlements', '-', '--xml', h).text, helper).not.toContain('allow-dyld-environment-variables');
    }

    // 3. The hardened app still runs the game: JIT in the renderer, WebGL on the in-process GPU, the preload bridge, saves.
    const userDataDir = path.join(dir, '.gameshipper', 'int-data');
    const smoke = await runSmoke(testCtx(dir), { command: exe, args: [], seconds: 3, userDataDir, windowed: true });
    expect(smoke.errors).toEqual([]);
    expect(smoke.warnings).toEqual([]);
    expect(smoke.data!.exitCode).toBe(0);
    const messages = readEvents(smoke.data!.eventsLog).flatMap((e) => (e.kind === 'console' ? [e.message ?? ''] : []));
    expect(messages).toContain(BRIDGE_OK);
    expect(Number(/^gameshipper-frames:(\d+)$/m.exec(messages.join('\n'))?.[1] ?? 0)).toBeGreaterThan(10);

    // 4. Steam injects its overlay with DYLD_INSERT_LIBRARIES; the main app's entitlement lets the library load.
    if (fs.existsSync(STEAM_OVERLAY)) {
      const summary = path.join(dir, '.gameshipper', 'overlay-smoke.json');
      const child = spawn(exe, [], {
        env: {
          ...process.env,
          DYLD_INSERT_LIBRARIES: STEAM_OVERLAY,
          GAMESHIPPER_LOG: path.join(dir, '.gameshipper', 'overlay-events.jsonl'),
          GAMESHIPPER_SMOKE_SECONDS: '6',
          GAMESHIPPER_SMOKE_OUT: summary,
          GAMESHIPPER_WINDOWED: '1',
          GAMESHIPPER_USER_DATA: userDataDir,
        },
        stdio: 'ignore',
      });
      await new Promise((r) => setTimeout(r, 3_000));
      const mapped = spawnSync('lsof', ['-p', String(child.pid)], { encoding: 'utf8' }).stdout;
      const exitCode = await new Promise((r) => child.on('close', r));
      expect(mapped).toContain('gameoverlayrenderer.dylib');
      expect(exitCode).toBe(0);
      expect(fs.existsSync(summary)).toBe(true);
    } else {
      await ctx.annotate(`Steam isn't installed (${STEAM_OVERLAY} is missing), so overlay injection wasn't tested`);
    }

    // 5. Notarization of the real app, against a fake notarytool and stapler (no Apple account needed).
    const fake = installFakeXcrun(dir);
    await withEnv({ PATH: `${fake.binDir}:${process.env.PATH}`, FAKE_XCRUN_LOG: fake.logFile, FAKE_NOTARY_RESULT: 'Accepted' }, () =>
      notarizeMacApp(testCtx(dir), app, { kind: 'keychain-profile', keychainProfile: 'gameshipper-test' }),
    );
    const calls = fs.readFileSync(fake.logFile, 'utf8');
    expect(calls).toMatch(/^notarytool submit .+Spinning Cube\.zip --keychain-profile gameshipper-test --wait --output-format json$/m);
    expect(calls).toMatch(/^notarytool log fake-submission-1 --keychain-profile gameshipper-test$/m);
    expect(calls).toMatch(/^stapler staple -v Spinning Cube\.app$/m);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('refuses half-set Apple credentials before building anything (exit 2)', () => {
    const dir = freshGame();
    const r = cli(['build', '--target', 'mac'], dir, { GAMESHIPPER_NOTARY_PROFILE: 'gameshipper-test' });
    expect(r.code).toBe(2);
    expect(r.result.errors.map((e: { code: string }) => e.code)).toEqual(['APPLE_CREDENTIALS_INVALID']);
    expect(fs.existsSync(path.join(dir, 'out', 'mac'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
