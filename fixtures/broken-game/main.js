// A game with one of each problem `play --smoke` reports. tests/integration/detectors.int.test.ts checks
// that each is found, and nothing else.

console.error('broken-game: something went wrong');

// Loads something from the internet while running. no-cors: example.com doesn't allow CORS, and the error
// Chromium would log for that is a problem of its own.
fetch('https://example.com/', { mode: 'no-cors' }).catch(() => {});

setTimeout(() => {
  throw new Error('broken-game: uncaught error');
});

// Following the link leaves the game window, which the shell answers by loading the game again: only leave once.
addEventListener('load', () => {
  if (sessionStorage.getItem('left')) return;
  sessionStorage.setItem('left', 'yes');
  setTimeout(() => document.getElementById('leave').click(), 500);
});
