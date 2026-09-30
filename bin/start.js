// Starts the CLI. Loading it takes a moment (~130 ms), and a signal in that time would kill Gameshipper
// without a word, so until main() takes over the process a signal prints an INTERRUPTED Result instead.
// Kept free of Gameshipper's own modules: it has to be running before they load.
import * as os from 'node:os';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * process.exit(), once it can't crash Node. With NODE_USE_SYSTEM_CA=1 (or --use-system-ca), Node reads the OS's
 * certificate store on a thread while it starts, and exiting during that read crashes Node 24 (SIGSEGV), losing the
 * exit code: exactly when a signal stops the CLI as it loads. Asking for the store waits for that thread (~30 ms).
 * A copy of src/core/proc.ts exitProcess, which can't be imported before the CLI has loaded.
 */
function exitProcess(code) {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)];
  if (process.env.NODE_USE_SYSTEM_CA === '1' || flags.includes('--use-system-ca')) {
    try {
      process.getBuiltinModule('node:tls').getCACertificates?.('system');
    } catch {
      // Exiting matters more than the certificates.
    }
  }
  process.exit(code);
}

/** As the CLI decides it: --json, or --json=<anything but false>. */
const wantsJson = (argv) => argv.some((a) => a === '--json' || (a.startsWith('--json=') && a.toLowerCase() !== '--json=false'));

/** The command: the first word that isn't a flag or the value of --dir. */
const commandIn = (argv) => argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--dir');

/**
 * Runs `main(argv)` from the module `loadMain` loads, with signals covered while it loads. Returns main's
 * exit code; never resolves if a signal arrived first (the process is exiting).
 */
export async function start(argv, loadMain) {
  let stopping = false;
  const onSignal = (signal) => {
    const code = 128 + (os.constants.signals[signal] ?? 0);
    // A second signal while the first is being reported: stop now.
    if (stopping) exitProcess(code);
    stopping = true;
    const message = `Stopped by ${signal} before finishing.`;
    const fix = "Run the command again when you're ready.";
    const text = wantsJson(argv)
      ? `${JSON.stringify({ ok: false, errors: [{ code: 'INTERRUPTED', message, fix }], warnings: [] }, null, 2)}\n`
      : `✗ INTERRUPTED: ${message} ${fix}\n`;
    process.exitCode = code;
    setTimeout(() => exitProcess(code), 2000);
    // mcp's stdout carries only MCP messages.
    const out = commandIn(argv) === 'mcp' ? process.stderr : process.stdout;
    try {
      out.write(text, () => exitProcess(code));
    } catch {
      exitProcess(code);
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
