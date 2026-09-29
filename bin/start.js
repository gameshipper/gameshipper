// Starts the CLI. Loading it takes a moment (~130 ms), and a signal in that time would kill Gameshipper
// without a word, so until main() takes over the process a signal prints an INTERRUPTED Result instead.
// Kept free of Gameshipper's own modules: it has to be running before they load.
import * as os from 'node:os';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** As the CLI decides it: --json, or --json=<anything but false>. */
const wantsJson = (argv) => argv.some((a) => a === '--json' || (a.startsWith('--json=') && a.toLowerCase() !== '--json=false'));

/**
 * Runs `main(argv)` from the module `loadMain` loads, with signals covered while it loads. Returns main's
 * exit code; never resolves if a signal arrived first (the process is exiting).
 */
export async function start(argv, loadMain) {
  let stopping = false;
  const onSignal = (signal) => {
    const code = 128 + (os.constants.signals[signal] ?? 0);
    // A second signal while the first is being reported: stop now.
    if (stopping) process.exit(code);
    stopping = true;
    const message = `Stopped by ${signal} before finishing.`;
    const fix = "Run the command again when you're ready.";
    const text = wantsJson(argv)
      ? `${JSON.stringify({ ok: false, errors: [{ code: 'INTERRUPTED', message, fix }], warnings: [] }, null, 2)}\n`
      : `✗ INTERRUPTED: ${message} ${fix}\n`;
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2000);
    try {
      process.stdout.write(text, () => process.exit(code));
    } catch {
      process.exit(code);
    }
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  const { main } = await loadMain();
  // Node loads modules synchronously, so a signal that arrived meanwhile is still waiting to be
  // delivered; one turn of the event loop delivers it here.
  await new Promise((resolve) => setImmediate(resolve));
  if (stopping) return new Promise(() => {});
  // main() installs its own handlers before its first await. Only then are these removed: Node stops
  // listening for a signal when its last handler goes, dropping one that arrived while modules loaded
  // synchronously and hasn't been delivered yet. This way it reaches main's handlers.
  const running = main(argv);
  for (const signal of SIGNALS) process.off(signal, onSignal);
  return running;
}
