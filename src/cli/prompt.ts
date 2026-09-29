import * as readline from 'node:readline/promises';

export interface Prompter {
  /** Asks a human; when not interactive, returns the fallback immediately (agents never block). */
  ask(question: string, fallback: string): Promise<string>;
}

/** Questions go to stderr so stdout only ever carries the command's result. */
export function createPrompter(
  interactive: boolean,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Prompter {
  return {
    async ask(question, fallback) {
      if (!interactive) return fallback;
      const rl = readline.createInterface({ input, output, terminal: false });
      try {
        const answer = (await rl.question(`${question} (${fallback}): `)).trim();
        return answer || fallback;
      } finally {
        rl.close();
      }
    },
  };
}
