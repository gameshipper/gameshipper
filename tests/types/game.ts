// Compiled by `npm run typecheck`: a game using every documented call must type-check.
import type { SteamAchievement } from '../../types/index.js';

export async function play(): Promise<void> {
  if (window.steam && (await window.steam.isAvailable())) {
    const name: string | null = await steam!.getUserName();
    await window.steam.unlockAchievement('ACH_WIN_ONE_GAME');
    const list: SteamAchievement[] = await window.steam.listAchievements();
    await window.steam.setStat('NumGames', list.length + (name ? 1 : 0));
    const upload = await window.steam.uploadLeaderboardScore('Feet Traveled', 12345);
    if (upload?.changed) await window.steam.setRichPresence('status', `Rank ${upload.rank}`);
    window.steam.activateOverlay('achievements');
    // @ts-expect-error: only Steam's overlay dialogs are allowed
    window.steam.activateOverlay('inventory');
  }
  const saves = window.gameshipper?.saves;
  await saves?.save('slot1', { level: 3 });
  const data = await saves?.load<{ level: number }>('slot1');
  const level: number | undefined = data?.level;
  await window.gameshipper?.plugins.echo?.shout('hi');
  void level;
}
