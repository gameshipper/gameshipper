import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.int.test.ts', 'node_modules/**'],
    testTimeout: 30_000,
    // Tests never find the developer's own Steamworks SDK: not through GAMESHIPPER_STEAM_SDK, and not in
    // Gameshipper's cache, which keeps an SDK once a build has used one.
    env: { GAMESHIPPER_STEAM_SDK: '', GAMESHIPPER_CACHE: path.join(os.tmpdir(), 'gameshipper-test-cache') },
  },
});
