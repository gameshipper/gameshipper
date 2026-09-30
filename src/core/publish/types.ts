import type { GsError } from '../result.js';
import type { HandOff } from '../tools/run.js';

export const DESTINATIONS = ['steam', 'itch', 'github'] as const;
export type Destination = (typeof DESTINATIONS)[number];

/** uploaded = sent for real; previewed = the --dry-run checks passed; failed = see errors. */
export type DestinationStatus = 'uploaded' | 'previewed' | 'failed';

export interface DestinationResult<T> {
  to: Destination;
  status: DestinationStatus;
  /** What was uploaded, or would be; there once the destination got far enough to know. */
  details?: T;
  errors: GsError[];
  warnings: GsError[];
}

/** What every destination gets. */
export interface PublishEnv {
  dryRun: boolean;
  /** A person is at a terminal: SteamCMD or butler may take it over to log in. Never true for agents or MCP. */
  interactive: boolean;
  /** Where tokens (GITHUB_TOKEN), tool overrides and the tools' own environment come from. */
  env: NodeJS.ProcessEnv;
  handOff: HandOff;
  /** Tells the person at the terminal what is about to happen there (the CLI prints it on stderr). */
  notice: (message: string) => void;
  platform: NodeJS.Platform;
  arch: string;
}

export function failedDestination<T>(to: Destination, errors: GsError | GsError[], warnings: GsError[] = [], details?: T): DestinationResult<T> {
  return { to, status: 'failed', ...(details ? { details } : {}), errors: Array.isArray(errors) ? errors : [errors], warnings };
}
