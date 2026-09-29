import * as path from 'node:path';
import type { BuildData } from '../core/build.js';
import type { InitData } from '../core/config/init.js';
import type { PlayData } from '../core/play.js';
import type { Result } from '../core/result.js';
import { problemCount } from '../core/smoke.js';
import type { StatusData } from '../core/status.js';

/** Human summary lines printed above a Result's errors, warnings and log path. Never used with --json. */

const rel = (projectDir: string, p: string) => path.relative(projectDir, p).split(path.sep).join('/');

/** "1 second", "3 seconds". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function initSummary(r: Result<InitData>): string[] {
  if (!r.ok || !r.data) return [];
  const { config } = r.data;
  const built = config.game.buildCommand ? ` (built with \`${config.game.buildCommand}\` into ${config.game.outputDir})` : '';
  return [
    `✓ Wrote gameshipper.json for "${config.name}"`,
    `  Entry: ${config.game.entry}${built}`,
    `  Icon: ${config.icon ?? 'none'}`,
    `  Store art: key art ${config.keyArt ?? 'none'}, logo ${config.logo ?? 'none'}`,
    `  Steam App ID: ${config.steam.appId}`,
    '',
    'Next: `npx gameshipper play` to try it, or `npx gameshipper play --smoke` for a quick automatic check.',
  ];
}

export function buildSummary(r: Result<BuildData>, projectDir: string): string[] {
  if (!r.data) return [];
  const lines = r.data.targets.map((t) => {
    const name = t.target.padEnd(8);
    if (t.status === 'built' && t.output) return `✓ ${name} ${rel(projectDir, t.output.executable)}`;
    if (t.status === 'failed') return `✗ ${name} failed (${t.errors.map((e) => e.code).join(', ')})`;
    return `- ${name} skipped`;
  });
  const store = r.data.store;
  if (store) {
    const name = 'store'.padEnd(8);
    if (store.status === 'built') lines.push(`✓ ${name} ${rel(projectDir, store.dir)}/ (${plural(store.images.length, 'image')})`);
    else if (store.status === 'failed') lines.push(`✗ ${name} failed (${store.errors.map((e) => e.code).join(', ')})`);
    else lines.push(`- ${name} skipped (set keyArt and logo)`);
  }
  if (r.data.targets.some((t) => t.status === 'built')) {
    lines.push('', 'Next: `npx gameshipper play --smoke` checks the game runs cleanly.');
  }
  return lines;
}

/**
 * `smoke` says which kind of run it was: a smoke run that never reported back has no `data.smoke`,
 * and must not read as a normal close. Failures (GAME_EXITED, SMOKE_NO_RESULT) explain themselves.
 */
export function playSummary(r: Result<PlayData>, opts: { smoke: boolean }): string[] {
  if (!r.data) return [];
  const shots = r.data.screenshots ?? [];
  const saved = shots.length ? [`Saved ${plural(shots.length, 'screenshot')} (1920x1080) in ${path.dirname(shots[0])}`] : [];
  if (opts.smoke) {
    const { smoke } = r.data;
    if (!smoke) return [];
    // Each code lists a few problems, then one entry counting the rest.
    const found = `✗ Found ${plural(problemCount(r.errors), 'problem')} while the game ran.`;
    return [r.ok ? '✓ The game ran with no errors.' : found, `Events: ${smoke.eventsLog}`, ...saved];
  }
  if (!r.ok) return [];
  return ['Game closed.', ...(r.data.eventsLog ? [`Events: ${r.data.eventsLog}`] : []), ...saved];
}

export function statusSummary(r: Result<StatusData>): string[] {
  const s = r.data;
  if (!s) return [];
  const config = s.config
    ? `"${s.config.name}" v${s.config.version}, Steam App ID ${s.config.steam.appId}, targets ${s.config.targets.join(', ')}`
    : 'none (run `npx gameshipper init`)';
  const lines = [
    `Gameshipper ${s.gameshipperVersion} (Electron ${s.electronVersion}) on ${s.host.platform}/${s.host.arch}`,
    `Project: ${s.projectDir}`,
    `Config: ${config}`,
    `Can build here: ${s.buildableHere.join(', ') || 'nothing'}`,
  ];
  if (s.notBuildableHere.length) {
    lines.push(`Can't build here: ${s.notBuildableHere.map((n) => `${n.target} (${n.reason.code})`).join(', ')}`);
  }
  const sdk = s.steamSdk;
  // Points at a warning only when status gave it.
  const warned = (code: string) => r.warnings.some((w) => w.code === code);
  lines.push(
    sdk
      ? `Steam SDK: ${sdk.version ?? 'unknown version'} from ${sdk.source} (${sdk.path}) for ${sdk.targets.join(', ')}`
      : warned('STEAM_SDK_INVALID')
        ? 'Steam SDK: not usable (see the STEAM_SDK_INVALID warning)'
        : warned('STEAM_SDK_MISSING')
          ? 'Steam SDK: none, so builds have no Steam features (see the STEAM_SDK_MISSING fix)'
          : 'Steam SDK: none found',
  );
  for (const o of s.outputs) lines.push(`out/${o.target}: ${o.exists ? 'built' : '—'}`);
  for (const run of Object.values(s.lastRuns)) {
    lines.push(`Last ${run.command}: ${run.ok ? '✓' : '✗'} ${run.at}${run.logPath ? ` (${run.logPath})` : ''}`);
  }
  return lines;
}
