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

export async function capture<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GsFailure) return fail(e.error);
    const message = e instanceof Error ? e.message : String(e);
    return fail(
      gsError('INTERNAL_ERROR', `Unexpected error: ${message}`, 'This is a Gameshipper bug. Re-run with --verbose and report the log.'),
    );
  }
}
