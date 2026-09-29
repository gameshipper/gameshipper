// A tiny game that uses window.steam, gameshipper.saves and a plugin, logging each result as
// "steam-e2e:<step>:<json>" for tests/integration/steam.int.test.ts.
const screen = document.getElementById('screen').getContext('2d');
let frame = 0;
(function draw() {
  frame++;
  screen.fillStyle = `hsl(${frame % 360} 70% 40%)`;
  screen.fillRect(0, 0, 640, 360);
  requestAnimationFrame(draw);
})();

const report = (step, value) => console.log(`steam-e2e:${step}:${JSON.stringify(value)}`);
const ACHIEVEMENT = 'ACH_WIN_ONE_GAME'; // One of Spacewar's (App ID 480) achievements.

async function run() {
  if (!window.steam) return report('absent', true);
  report('available', await steam.isAvailable());
  const name = await steam.getUserName();
  report('user', typeof name === 'string' && name.length > 0); // Never log the player's name itself.
  report('language', await steam.getLanguage());
  report('deck', await steam.isSteamDeck());
  // Never clear an achievement the account really has: unlock and clear it only when it starts locked.
  const alreadyUnlocked = await steam.isAchievementUnlocked(ACHIEVEMENT);
  report('achievementAlreadyUnlocked', alreadyUnlocked);
  if (!alreadyUnlocked) {
    report('unlock', await steam.unlockAchievement(ACHIEVEMENT));
    report('unlocked', await steam.isAchievementUnlocked(ACHIEVEMENT));
    report('clear', await steam.clearAchievement(ACHIEVEMENT)); // Leave the test account as it was.
    report('cleared', !(await steam.isAchievementUnlocked(ACHIEVEMENT)));
  }
  report('achievements', (await steam.listAchievements()).length);
  report('presence', await steam.setRichPresence('status', 'Testing Gameshipper'));
  // A round-trip on one of Spacewar's int stats that changes nothing: write its current value back, store, read it.
  // Spacewar's NumGames only ever goes up (a lower value is refused), so this test must never increase it: that
  // would change the signed-in account for good.
  const games = await steam.getStat('NumGames', 'int');
  report('stat', typeof games);
  if (typeof games === 'number') {
    const set = await steam.setStat('NumGames', games, 'int');
    const stored = await steam.storeStats();
    const readBack = (await steam.getStat('NumGames', 'int')) === games;
    report('statRoundTrip', { set, stored, readBack });
  } else {
    report('statRoundTrip', null);
  }
  await gameshipper.saves.save('progress', { level: 2 });
  report('save', await gameshipper.saves.load('progress'));
  report('plugin', await gameshipper.plugins.echo.shout('hi'));
  report('done', true);
}

run().catch((e) => console.error(`steam-e2e:failed:${e.message}`));
