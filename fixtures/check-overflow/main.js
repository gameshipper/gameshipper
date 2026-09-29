// A game with one problem only `gameshipper check` finds: its HUD text runs past the right edge of the Steam Deck's
// 1280x800 screen, though the HUD's box fits. tests/integration/check.int.test.ts checks that deck.layout warns.
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
}
addEventListener('resize', resize);
resize();

const orbs = Array.from({ length: 12 }, (_, i) => ({ hue: i * 30, speed: 0.4 + (i % 4) * 0.2, radius: 30 + (i % 3) * 20 }));

function frame(t) {
  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, '#1b2a49');
  sky.addColorStop(1, '#7a3b69');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  orbs.forEach((orb, i) => {
    const angle = (t / 1000) * orb.speed + (i * Math.PI) / 6;
    const x = canvas.width / 2 + Math.cos(angle) * canvas.width * 0.3;
    const y = canvas.height / 2 + Math.sin(angle) * canvas.height * 0.3;
    ctx.fillStyle = `hsl(${orb.hue}, 80%, 60%)`;
    ctx.beginPath();
    ctx.arc(x, y, orb.radius, 0, Math.PI * 2);
    ctx.fill();
  });
  // Played with a gamepad on Steam Deck.
  for (const pad of navigator.getGamepads()) if (pad?.buttons[0]?.pressed) orbs.reverse();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
