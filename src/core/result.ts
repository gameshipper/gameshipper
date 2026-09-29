export interface GsError {
  code: string;
  message: string;
  fix?: string;
}

export interface Result<T> {
  ok: boolean;
  data?: T;
  errors: GsError[];
  warnings: GsError[];
  logPath?: string;
}

export function gsError(code: string, message: string, fix?: string): GsError {
  return fix === undefined ? { code, message } : { code, message, fix };
}

export function ok<T>(data: T, warnings: GsError[] = []): Result<T> {
  return { ok: true, data, errors: [], warnings };
}

export function fail<T = never>(errors: GsError | GsError[], warnings: GsError[] = [], data?: T): Result<T> {
  return { ok: false, data, errors: Array.isArray(errors) ? errors : [errors], warnings };
}

/** Throw inside core helpers; `capture` turns it into a failed Result at the boundary. */
export class GsFailure extends Error {
  readonly error: GsError;

  constructor(code: string, message: string, fix?: string) {
    super(message);
    this.name = 'GsFailure';
    this.error = gsError(code, message, fix);
  }
}

/** The error for anything thrown that isn't a GsFailure: a Gameshipper bug. */
export function internalError(e: unknown): GsError {
  const message = e instanceof Error ? e.message : String(e);
  return gsError('INTERNAL_ERROR', `Unexpected error: ${message}`, 'This is a Gameshipper bug. Re-run with --verbose and report the log.');
}

/** Text for the run log: the stack when there is one, so a reported log shows where it broke. */
export function errorDetails(e: unknown): string {
  return e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);
}

/**
 * Runs `fn`, turning a thrown GsFailure into a failed Result and anything else into INTERNAL_ERROR.
 * `log` receives the stack of unexpected errors (pass `ctx.log`).
 */
export async function capture<T>(fn: () => Promise<Result<T>>, log?: (line: string) => void): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error);
    log?.(errorDetails(e));
    return fail(internalError(e));
  }
}
