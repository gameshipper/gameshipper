import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.int.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Integration tests package real apps; running them side by side makes them fight over downloads and CPU.
    fileParallelism: false,
    // Builds never find the developer's own Steamworks SDK: not through GAMESHIPPER_STEAM_SDK, and not in
    // Gameshipper's cache, which keeps an SDK once a build has used one. The Steam tests bring their own.
    env: { GAMESHIPPER_STEAM_SDK: '', GAMESHIPPER_CACHE: path.join(os.tmpdir(), 'gameshipper-int-cache') },
  },
});
