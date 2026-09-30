#!/usr/bin/env node
// A stand-in for SteamCMD in tests (GAMESHIPPER_STEAMCMD points at it). It prints what SteamCMD 1788292693 printed in
// real runs on 2026-09-29, records every run, and keeps "saved logins" as files.
//   FAKE_STEAMCMD_STATE  folder for runs.jsonl, builds.jsonl and login-<user> files (required)
//   FAKE_STEAMCMD_MODE   ok | access-denied | set-live-fails | no-connection | refuse-login | prompt | bad-cpu | hang
// "hang" starts a child of its own at +run_app_build (writing both PIDs to hang.json), then never finishes.
// Each run records its HOME, and the launchctl a shell would find on its PATH (the real SteamCMD calls it on macOS).
// It never calls process.exit(): with NODE_USE_SYSTEM_CA=1, Node 24.7 on macOS can crash there.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const state = process.env.FAKE_STEAMCMD_STATE;
const mode = process.env.FAKE_STEAMCMD_MODE ?? 'ok';
const args = process.argv.slice(2);
const TS = '[2026-09-29 10:00:00]:';
const say = (line) => process.stdout.write(`${line}\n`);
const saved = (user) => path.join(state, `login-${user}`);

// A FileExclusion as SteamCMD applies it: to each file's path relative to the content root, with `*` matching any
// characters, / included. So "steam_appid.txt" only matches the file at the top, and "*/steam_appid.txt" the ones in
// folders (checked with the real SteamCMD).
const exclusion = (glob) => new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

function listFiles(root, exclusions) {
  const skip = exclusions.map(exclusion);
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (!skip.some((x) => x.test(r))) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

/** The first executable `name` on PATH, as a shell finds it; only looked up, never run. */
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not there, or not executable
    }
  }
  return null;
}

function login(user, noPrompt) {
  if (user === 'anonymous') {
    say('Connecting anonymously to Steam Public...OK');
  } else if (mode === 'no-connection') {
    say(`Logging in user '${user}' [U:1:0] to Steam Public...FAILED (No Connection)`);
    return 5;
  } else if (fs.existsSync(saved(user))) {
    say('Logging in using cached credentials.');
    say(`Logging in user '${user}' [U:1:0] to Steam Public...OK`);
  } else if (mode === 'prompt') {
    process.stdout.write('password: ');
    setInterval(() => {}, 1000);
    return 'hang';
  } else if (noPrompt) {
    say('Cached credentials not found.');
    say('FAILED (No cached credentials and @NoPromptForPassword is set)');
    return 5;
  } else if (mode === 'refuse-login') {
    say(`Logging in user '${user}' [U:1:0] to Steam Public...FAILED (Invalid Password)`);
    return 5;
  } else {
    // The real SteamCMD asks for the password and the Steam Guard code here.
    fs.writeFileSync(saved(user), 'token');
    say(`Logging in user '${user}' [U:1:0] to Steam Public...OK`);
  }
  say('Waiting for client config...OK');
  say('Waiting for user info...OK');
  return 0;
}

function build(script) {
  const text = fs.readFileSync(script, 'utf8');
  const value = (t, key) => (new RegExp(`"${key}"\\s+"([^"]*)"`).exec(t) ?? [])[1];
  const appId = value(text, 'AppID');
  const preview = value(text, 'Preview') === '1';
  const setLive = value(text, 'SetLive') ?? null;
  const output = value(text, 'BuildOutput');
  const lines = [];
  const log = (line) => {
    say(line);
    lines.push(line);
  };
  const finish = (code) => {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `app_build_${appId}.log`), `${lines.join('\n')}\n`);
    return code;
  };
  log(`${TS} Starting AppID ${appId} build (flags 0x${preview ? '2' : '0'}).`);
  if (mode === 'hang') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(state, 'hang.json'), JSON.stringify({ pid: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
    return 'hang';
  }
  const depots = [];
  for (const m of text.matchAll(/"(\d+)"\s+"([^"]+\.vdf)"/g)) {
    const depotText = fs.readFileSync(m[2], 'utf8');
    const root = value(depotText, 'ContentRoot');
    const excluded = [...depotText.matchAll(/"FileExclusion"\s+"([^"]+)"/g)].map((x) => x[1]);
    log(`${TS} Building depot ${m[1]}...`);
    if (!root || !fs.existsSync(root)) {
      log(`${TS} ERROR! Content root folder "${root}" does not exist`);
      return finish(6);
    }
    const files = listFiles(root, excluded);
    log(`${TS} Found ${files.length} files`);
    depots.push({ depotId: Number(m[1]), root, files });
  }
  if (mode === 'access-denied') {
    log(`${TS} ERROR! Failed to initialize build on server (Access Denied)`);
    log(`${TS} ERROR! Build for depot ${depots[0]?.depotId} failed : Failure`);
    return finish(6);
  }
  fs.appendFileSync(path.join(state, 'builds.jsonl'), `${JSON.stringify({ appId: Number(appId), preview, setLive, depots })}\n`);
  if (preview) {
    log(`${TS} Successfully finished AppID ${appId} build preview.`);
    return finish(0);
  }
  log(`${TS} Successfully finished AppID ${appId} build (BuildID 12345678).`);
  if (setLive && mode === 'set-live-fails') {
    log(`${TS} ERROR! Failed to commit build for AppID ${appId} : Failure`);
    return finish(6);
  }
  return finish(0);
}

function main() {
  if (!state) {
    process.stderr.write('FAKE_STEAMCMD_STATE is not set\n');
    return 99;
  }
  fs.mkdirSync(state, { recursive: true });
  fs.appendFileSync(path.join(state, 'runs.jsonl'), `${JSON.stringify({ args, home: process.env.HOME ?? null, launchctl: onPath('launchctl') })}\n`);
  if (mode === 'bad-cpu') {
    say(`./steamcmd.sh: line 37: ${process.argv[1]}: Bad CPU type in executable`);
    return 126;
  }
  say('[  0%] Checking for available updates...');
  say('[----] Verifying installation...');
  say('Steam Console Client (c) Valve Corporation - version 1788292693');
  say("-- type 'quit' to exit --");
  say('Loading Steam API...OK');
  let noPrompt = false;
  for (let i = 0; i < args.length; i++) {
    let code = 0;
    if (args[i] === '+@NoPromptForPassword' || args[i] === '+@ShutdownOnFailedCommand') {
      if (args[i] === '+@NoPromptForPassword') noPrompt = args[i + 1] === '1';
      say(`"${args[i].slice(1)}" = "${args[i + 1]}"`);
      i++;
    } else if (args[i] === '+login') {
      code = login(args[++i], noPrompt);
    } else if (args[i] === '+run_app_build') {
      code = build(args[++i]);
    } else if (args[i] === '+quit') {
      break;
    }
    if (code === 'hang') return 'hang';
    if (code !== 0) {
      say('Unloading Steam API...OK');
      return code;
    }
  }
  say('Unloading Steam API...OK');
  return 0;
}

const code = main();
if (typeof code === 'number') process.exitCode = code;
