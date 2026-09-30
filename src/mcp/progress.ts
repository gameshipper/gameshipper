export interface ProgressUpdate {
  progress: number;
  message: string;
}

export interface ProgressOptions {
  /** Minimum time between two updates for log lines; lines in between only raise the count. */
  minIntervalMs?: number;
  /** With nothing sent for this long, an update says the command is still running. */
  heartbeatMs?: number;
  now?: () => number;
}

export interface Progress {
  /** A line of the command's log. */
  line(text: string): void;
  /** The call waits for another command on the same game folder: says so now, and in each update until `running`. */
  waiting(): void;
  /** The call's command has started. */
  running(): void;
  /** Ends the updates; call it when the command is done. */
  stop(): void;
}

const WAITING = 'Waiting for another Gameshipper command on this folder';

const MAX_MESSAGE = 300;

/**
 * Turns a command's log lines into MCP progress updates. Every line raises `progress`, but at most one update per
 * `minIntervalMs` is sent, so a chatty step can't flood the client. While nothing is logged (a long download), an
 * update every `heartbeatMs` keeps clients that reset their timeout on progress waiting.
 */
export function createProgress(send: (update: ProgressUpdate) => Promise<void>, opts: ProgressOptions = {}): Progress {
  const minIntervalMs = opts.minIntervalMs ?? 250;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const started = now();
  let count = 0;
  let lastSent = started;
  const emit = (message: string): void => {
    lastSent = now();
    send({ progress: count, message }).catch(() => {
      // The client may have gone; progress is best effort.
    });
  };
  let queued = false;
  const heartbeat = setInterval(() => {
    if (now() - lastSent < heartbeatMs) return;
    count++;
    const seconds = Math.round((now() - started) / 1000);
    emit(queued ? `${WAITING} (${seconds} s)…` : `Still running (${seconds} s)…`);
  }, heartbeatMs / 3);
  heartbeat.unref();
  let sentLine = false;
  return {
    line(text) {
      count++;
      if (sentLine && now() - lastSent < minIntervalMs) return;
      sentLine = true;
      emit(text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text);
    },
    waiting() {
      queued = true;
      count++;
      emit(`${WAITING} to finish…`);
    },
    running() {
      queued = false;
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}
