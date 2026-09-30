// The game for the manual release checks (docs/release-checklist.md): each button calls one part of window.steam or
// window.gameshipper and logs what came back, and the Gamepads panel follows every connected controller.
const $ = (id) => document.getElementById(id);
const steam = window.steam;
const saves = window.gameshipper?.saves;

function log(message) {
  $('log').textContent = `${new Date().toLocaleTimeString()}  ${message}\n${$('log').textContent}`;
}

async function run(label, fn) {
  try {
    const value = await fn();
    log(`${label} → ${JSON.stringify(value) ?? 'done'}`);
    return value;
  } catch (e) {
    log(`${label} failed: ${e?.message ?? e}`);
    return undefined;
  }
}

async function showSteam() {
  if (!steam) {
    $('steam').textContent = 'no window.steam: not running in Gameshipper';
    return;
  }
  const available = await steam.isAvailable();
  $('steam').textContent = available ? 'running' : 'off (no Steamworks SDK in the build, or Steam is not running)';
  if (available) $('player').textContent = (await steam.getUserName()) ?? '(unknown)';
}

$('unlock').onclick = () => run("steam.unlockAchievement('ACH_WIN_ONE_GAME')", () => steam.unlockAchievement('ACH_WIN_ONE_GAME'));
$('clear').onclick = () => run("steam.clearAchievement('ACH_WIN_ONE_GAME')", () => steam.clearAchievement('ACH_WIN_ONE_GAME'));
$('overlay').onclick = () => run("steam.activateOverlay('achievements')", () => steam.activateOverlay('achievements'));
$('save').onclick = () =>
  run("saves.save('release-check')", async () => {
    const previous = (await saves.load('release-check')) ?? { count: 0 };
    const next = { count: previous.count + 1, savedAt: new Date().toISOString(), savedOn: navigator.platform };
    await saves.save('release-check', next);
    return next;
  });
$('load').onclick = () => run("saves.load('release-check')", () => saves.load('release-check'));
$('quit').onclick = () => window.close();
// Steam Deck: the on-screen keyboard opens for this field, and what's typed lands in it.
$('typing').onchange = () => log(`typed: ${JSON.stringify($('typing').value)}`);

function showGamepads() {
  const pads = [...navigator.getGamepads()].filter(Boolean);
  $('pads').textContent = pads.length
    ? pads
        .map((p) => {
          const pressed = p.buttons.flatMap((b, i) => (b.pressed ? [i] : [])).join(', ') || 'none';
          return `#${p.index} ${p.id}\n  buttons pressed: ${pressed}\n  axes: ${p.axes.map((a) => a.toFixed(2)).join(' ')}`;
        })
        .join('\n')
    : 'No gamepad yet: press a button on the controller.';
}

// Something always moving, so the Steam overlay has frames to draw over.
const ctx = $('spinner').getContext('2d');
function frame(t) {
  showGamepads();
  ctx.clearRect(0, 0, 120, 120);
  ctx.save();
  ctx.translate(60, 60);
  ctx.rotate(t / 600);
  ctx.fillStyle = '#4fa3ff';
  ctx.fillRect(-30, -30, 60, 60);
  ctx.restore();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

showSteam().then(() => console.log('release-check:ready'), (e) => console.error(`release-check: ${e?.message ?? e}`));
