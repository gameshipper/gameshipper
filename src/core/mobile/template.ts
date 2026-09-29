import { GsFailure } from '../result.js';

/** Capacitor's generated project didn't have something we edit; happens only if the pinned template changes. */
export function templateError(what: string): GsFailure {
  return new GsFailure(
    'MOBILE_TEMPLATE_UNEXPECTED',
    `Capacitor's generated project looks different than expected: ${what}.`,
    'This is a Gameshipper bug (usually after a Capacitor upgrade). Re-run with --verbose and report the log.',
  );
}

/** Replaces every match of re; throws MOBILE_TEMPLATE_UNEXPECTED when there is none. */
export function replaceOrFail(text: string, re: RegExp, replacement: string, what: string): string {
  if (!re.test(text)) throw templateError(what);
  re.lastIndex = 0;
  return text.replace(re, replacement);
}

/** Drops .gitignore lines for files Capacitor regenerates, so out/ios and out/android can be committed as they are. */
export function keepGeneratedFiles(gitignore: string, generated: readonly string[]): string {
  return gitignore
    .split('\n')
    .filter((line) => !generated.includes(line.trim()))
    .join('\n');
}
