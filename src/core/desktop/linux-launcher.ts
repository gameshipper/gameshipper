import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The name of the Electron binary in a Linux build. The build's own name, `<slug>`, is the launcher that starts it
 * (linuxLauncherScript): that is the file players, Steam's launch option and Gameshipper run.
 */
export function linuxBinaryName(slug: string): string {
  return `${slug}-bin`;
}

/**
 * The launcher of a Linux build: a POSIX shell script that starts the Electron binary next to it with --no-sandbox.
 *
 * The shell runs without Chromium's sandbox on Linux (shell/flags.ts), but Chromium decides on its sandbox from the
 * command line alone, before any of the game's code runs. Where the sandbox can't start (Ubuntu 24.04 and later keep
 * programs outside a package from the user namespaces it needs, and the chrome-sandbox helper of an unpacked folder
 * isn't setuid root), a binary started without the switch stops with SIGTRAP before it opens a window. Only what
 * starts the binary can pass the switch, so the build's name is this script.
 *
 * - `exec` replaces the shell with the game: same process ID, so signals reach the game and its exit code is the
 *   launcher's. The environment (Steam's LD_PRELOAD for its overlay, SteamAppId) and the working directory pass
 *   through unchanged.
 * - It finds the binary next to its own real file, through symbolic links to it, from any working directory, and
 *   with spaces in the path.
 * - `slug` is slugify()'s: lowercase letters, digits and hyphens, so it needs no quoting. The game's display name
 *   never goes into the script.
 * - Lines end with LF on every OS: a `#!/bin/sh` line ending in CR names an interpreter that doesn't exist.
 */
export function linuxLauncherScript(slug: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`"${slug}" can't name a Linux build: it must be made of lowercase letters, digits and hyphens.`);
  const binary = linuxBinaryName(slug);
  const lines = [
    '#!/bin/sh',
    `# Starts the game. Written by Gameshipper: run this file, not ${binary}.`,
    '#',
    `# ${binary}, next to this file, is the game. It runs without Chromium's sandbox, and Chromium only takes`,
    '# that from the command line: started without --no-sandbox, the game stops before its window opens wherever the',
    "# sandbox can't start (Ubuntu 24.04 and later, for one).",
    '',
    '# The folder this file is really in, also when it was started through a symbolic link.',
    'self=$0',
    'while :; do',
    '  case $self in',
    '    */*) dir=${self%/*} ;;',
    '    *) dir=. ;;',
    '  esac',
    '  [ -L "$self" ] || break',
    '  target=$(readlink -- "$self") || break',
    '  case $target in',
    '    /*) self=$target ;;',
    '    *) self=$dir/$target ;;',
    '  esac',
    'done',
    '',
    '# exec: the game takes over this process, so its process ID, signals and exit code are the game\'s.',
    `exec "$dir/${binary}" --no-sandbox "$@"`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the launcher `<slug>` into a packaged Linux build, next to its Electron binary `<slug>-bin`, and returns
 * its path. Both are executable (0755); on Windows, which has no file modes, the zip writer and the stores' upload
 * tools mark them by their first bytes (`#!`, ELF). Throws when the binary isn't there.
 */
export function writeLinuxLauncher(dir: string, slug: string): string {
  const script = linuxLauncherScript(slug);
  const binary = path.join(dir, linuxBinaryName(slug));
  if (!fs.statSync(binary, { throwIfNoEntry: false })?.isFile()) throw new Error(`the Linux build has no ${linuxBinaryName(slug)} for its launcher to start`);
  const launcher = path.join(dir, slug);
  fs.writeFileSync(launcher, script, { mode: 0o755 });
  if (process.platform !== 'win32') {
    // writeFileSync's mode only applies to a new file, and the umask trims it.
    fs.chmodSync(launcher, 0o755);
    fs.chmodSync(binary, 0o755);
  }
  return launcher;
}
