#!/usr/bin/env node
// A stand-in for itch.io's butler 15.31.0 in tests (GAMESHIPPER_BUTLER points at it). With --json it prints the JSON
// lines the real one printed on 2026-09-29, and it records every run.
//   FAKE_BUTLER_STATE  folder for runs.jsonl, pushes.jsonl and the saved "creds" file (required)
//   FAKE_BUTLER_MODE   ok | push-fails | noisy-push | noisy-login | login-fails | offline | server-error | windows
// BUTLER_API_KEY counts as a login; the value "bad" is refused the way itch.io refuses an invalid key. "offline" and
// "server-error" fail every call that needs itch.io (checking a login, a real push) the way butler did with itch.io's
// address pointed at an unknown host and at a server answering 500. "noisy-push" fails each real push, and
// "noisy-login" each check of a login it has, with 60 errors whose first lines are 1,000 characters each.
// "windows" is the real butler on Windows, which can't tell there that nobody is at a terminal: without a login,
// `--json login` asks for one in the browser (a `login` message with the address) and waits for it.
// It never calls process.exit(): with NODE_USE_SYSTEM_CA=1, Node 24.7 on macOS can crash there.
import * as fs from 'node:fs';
import * as path from 'node:path';

const state = process.env.FAKE_BUTLER_STATE;
const mode = process.env.FAKE_BUTLER_MODE ?? 'ok';
const raw = process.argv.slice(2);
const json = raw.includes('--json') || raw.includes('-j');
const args = raw.filter((a) => a !== '--json' && a !== '-j');
const now = 1790734889;
const STACK = '\ngithub.com/itchio/go-itchio.(*Client).GetResponse\n\t/Users/runner/go/pkg/mod/github.com/itchio/go-itchio/http_helpers.go:130';
/** 60 different errors, each a 1,000-character line and a line of stack. */
const NOISY = Array.from({ length: 60 }, (_, i) => `${`itch.io API error (400): problem ${i + 1} `.padEnd(1000, 'x')}\nmain.main()`);

const emit = (obj) => process.stdout.write(`${JSON.stringify({ ...obj, time: now })}\n`);
const log = (message) => (json ? emit({ level: 'info', message, type: 'log' }) : process.stderr.write(`${message}\n`));
const error = (message) => (json ? emit({ message, type: 'error' }) : process.stderr.write(`${message}\n`));
const result = (value) => json && emit({ type: 'result', value });
const creds = () => path.join(state, 'creds');
const key = process.env.BUTLER_API_KEY;

/** null when logged in, else the exit code after saying why not. */
function refuse() {
  if ((key || fs.existsSync(creds())) && mode === 'offline') {
    error(`Get "https://api.itch.io/wharf/status": dial tcp: lookup api.itch.io: no such host${STACK}\nvalidating credentials`);
    return 1;
  }
  if ((key || fs.existsSync(creds())) && mode === 'server-error') {
    error(`itch.io API error (500): /wharf/status: internal error${STACK}\nvalidating credentials`);
    return 1;
  }
  if ((key || fs.existsSync(creds())) && mode === 'noisy-login') {
    for (const message of NOISY) error(message);
    return 1;
  }
  if (key === 'bad') {
    error(`itch.io API error (403): /wharf/status: invalid key${STACK}`);
    return 1;
  }
  if (key || fs.existsSync(creds())) return null;
  log('Please set BUTLER_API_KEY to your API key, see https://itch.io/docs/butler/login.html for more info.');
  error('No credentials and stdin is not a terminal - terminating.');
  return 1;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

function push() {
  const dryRun = args.includes('--dry-run');
  const rest = args.filter((a) => a !== '--dry-run');
  const [, src, target] = rest;
  const userversion = rest[rest.indexOf('--userversion') + 1];
  const channel = target.split(':')[1];
  if (!fs.existsSync(src)) {
    error(`stat ${src}: no such file or directory`);
    return 1;
  }
  const files = countFiles(src);
  if (dryRun) {
    log('> Dry run, listing files we would push...');
    log(`< Would push ${files} files`);
    result({ buildId: 0, channel, dryRun: true, reason: 'dry-run', skipped: false });
    return 0;
  }
  const refused = refuse();
  if (refused !== null) return refused;
  if (mode === 'push-fails') {
    error(`itch.io API error (400): /wharf/builds: invalid target (bad user/game)${STACK}`);
    return 1;
  }
  if (mode === 'noisy-push') {
    for (const message of NOISY) error(message);
    return 1;
  }
  const pushes = path.join(state, 'pushes.jsonl');
  const count = fs.existsSync(pushes) ? fs.readFileSync(pushes, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  fs.appendFileSync(pushes, `${JSON.stringify({ src, target, userversion, files })}\n`);
  log(`> For channel \`${channel}\`: pushing first build`);
  log(`> Pushing ${files} files`);
  log('> Build is now processing, should be up in a bit.');
  result({ buildId: 1000 + count, channel, dryRun: false, reason: '', skipped: false });
  return 0;
}

function main() {
  if (!state) {
    process.stderr.write('FAKE_BUTLER_STATE is not set\n');
    return 99;
  }
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(path.join(state, 'runs.jsonl'), `${JSON.stringify({ args: raw })}\n`);
  const [command] = args;
  if (command === 'version') {
    if (json) result({ version: 'v15.31.0' });
    else process.stderr.write('v15.31.0, built on Sep  1 2026 @ 15:23:44, ref 54a2dd86ed68ab72b25a8d753fa7f88dc552ef7f\n');
    return 0;
  }
  if (command === 'login') {
    if (key || fs.existsSync(creds())) {
      const refused = refuse();
      if (refused !== null) return refused;
      log('Your local credentials are valid!');
      result({ status: 'success' });
      return 0;
    }
    if (json && mode === 'windows') {
      const uri = 'https://itch.io/user/oauth?client_id=butler&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fcallback&response_type=token&scope=wharf';
      process.stdout.write(`${JSON.stringify({ time: now, type: 'login', uri })}\n`);
      setInterval(() => {}, 1000);
      return 0;
    }
    if (json) return refuse();
    // With a terminal, the real butler opens the browser here.
    if (mode === 'login-fails') {
      error('authenticating (no saved credentials): the login was cancelled');
      return 1;
    }
    fs.writeFileSync(creds(), 'key');
    log('Authenticated successfully! Saving key...');
    return 0;
  }
  if (command === 'push') return push();
  error(`unknown command ${command}`);
  return 1;
}

process.exitCode = main();
